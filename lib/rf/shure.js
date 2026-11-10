'use strict';

/**
 * Shure "command strings" client (TCP 2202) for Axient Digital receivers:
 * AD4D, AD4Q and ANX4. ASCII frames: `< GET x PROP >` / `< REP x PROP value >`
 * and, once METER_RATE is set, `< SAMPLE x ALL ... >` every N ms.
 *
 * SAMPLE layout (standard channel):
 *   qual audBitmap audPeak audRms antStats (rfBitmap rfRssi) per antenna letter
 * Quadversity carries four antennas; FD-C channels append a second group.
 * Audio and RSSI values are reported as 0..120 and mean (value - 120) dBFS/dBm.
 */

const net = require('net');
const { EventEmitter } = require('events');
const { emptyChannel, num } = require('./telemetry');

const PORT = 2202;
const METER_RATE_MS = 200;
const RECONNECT_MS = 4000;
const KEEPALIVE_MS = 15000;
const REQUEST_TIMEOUT_MS = 3000;

const CHANNEL_PROPS = ['CHAN_NAME', 'FREQUENCY', 'AUDIO_MUTE', 'TX_MODEL', 'TX_DEVICE_ID', 'TX_BATT_CHARGE_PERCENT', 'TX_BATT_MINS', 'TX_BATT_BARS', 'TX_BATT_TYPE', 'TX_MUTE_MODE_STATUS', 'INTERFERENCE_STATUS', 'ENCRYPTION_STATUS', 'UNREGISTERED_TX_STATUS'];

/** `< REP 1 TX_MODEL ADX2 >` -> { channel: 1, prop, args }; `< SAMPLE ... >` -> { channel, prop: 'SAMPLE', sample }. */
function parseFrame(frame) {
  const sample = /^<\s*SAMPLE\s+(\d{1,2})\s+ALL\s+(.*?)\s*>$/.exec(frame);
  if (sample) return { channel: Number(sample[1]), prop: 'SAMPLE', args: [], sample: parseSample(sample[2]) };
  const m = /^<\s*REP\s+(.*?)\s*>$/s.exec(frame);
  if (!m) return null;
  const tokens = [];
  const re = /\{([^}]*)\}|(\S+)/g;
  let t;
  while ((t = re.exec(m[1]))) tokens.push(t[1] !== undefined ? { braced: t[1] } : t[2]);
  if (!tokens.length) return null;
  if (tokens[0] === 'ERR') return { channel: null, prop: 'ERR', args: [] };
  let channel = null;
  if (typeof tokens[0] === 'string' && /^\d{1,2}$/.test(tokens[0])) channel = Number(tokens.shift());
  const prop = tokens.shift();
  if (typeof prop !== 'string') return null;
  return { channel, prop, args: tokens.map((x) => (typeof x === 'string' ? x : x.braced.trim())) };
}

/** The fields after `ALL`. Returns { quality, afPeak, afRms, antennas[], rssi[] } (second FD-C group merged as max). */
function parseSample(text) {
  const t = text.trim().split(/\s+/);
  if (t.length < 5) return null;
  const level = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n <= 120 ? n - 120 : null;
  };
  const qual = Number(t[0]);
  const out = { quality: qual >= 0 && qual <= 5 ? qual * 20 : null, afPeak: level(t[2]), afRms: level(t[3]), antennas: [], rssi: [] };
  let i = 4;
  let first = true;
  while (i < t.length && /^[XRBN]{2,4}$/.test(t[i])) {
    const letters = [...t[i++]].filter((c) => c !== 'N');
    const rssi = [];
    for (let a = 0; a < letters.length && i + 1 < t.length + 1; a++) {
      i++; // rfBitmap (front-panel LEDs), not needed
      rssi.push(level(t[i++]));
    }
    if (first) {
      out.antennas = letters;
      out.rssi = rssi;
      first = false;
    } else {
      // FD-C second frequency: keep the stronger reading per antenna
      out.rssi = out.rssi.map((v, k) => (rssi[k] === null || rssi[k] === undefined ? v : v === null ? rssi[k] : Math.max(v, rssi[k])));
      out.antennas = out.antennas.map((c, k) => (c === 'X' && rssi[k] !== null ? letters[k] || c : c));
    }
  }
  return out;
}

function splitFrames(text) {
  const frames = [];
  let rest = text;
  for (;;) {
    const start = rest.indexOf('<');
    if (start < 0) return { frames, rest: '' };
    const end = rest.indexOf('>', start);
    if (end < 0) return { frames, rest: rest.slice(start) };
    frames.push(rest.slice(start, end + 1));
    rest = rest.slice(end + 1);
  }
}

const unknown = (v, u) => (v === undefined || v === null || Number(v) === u ? null : Number(v));

class ShureReceiver extends EventEmitter {
  constructor({ host, port = PORT, log, channels = 4 }) {
    super();
    this.host = host;
    this.port = port;
    this.log = log || console;
    this.maxChannels = channels;
    this.model = null;
    this.deviceId = null;
    this.online = false;
    this.channels = new Map(); // number -> telemetry
    this.socket = null;
    this.buffer = '';
    this.closed = false;
    this.timers = [];
    this.pending = [];
  }

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    if (this.socket) {
      try {
        for (const ch of this.channels.keys()) this.socket.write(`< SET ${ch} METER_RATE 00000 >`);
      } catch {
        // ignore
      }
      this.socket.destroy();
      this.socket = null;
    }
    this.setOnline(false);
  }

  later(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref();
    this.timers.push(t);
    return t;
  }

  setOnline(on) {
    if (this.online === on) return;
    this.online = on;
    this.emit('status', on);
  }

  connect() {
    if (this.closed) return;
    const socket = net.createConnection({ host: this.host, port: this.port });
    socket.setNoDelay(true);
    socket.setTimeout(KEEPALIVE_MS * 2);
    socket.on('connect', () => {
      this.log.info(`[Shure] Connected to ${this.host}:${this.port}`);
      this.socket = socket;
      this.buffer = '';
      this.setOnline(true);
      this.hello().catch((err) => this.log.debug(`[Shure] hello: ${err.message}`));
      this.keepalive();
    });
    socket.on('data', (d) => this.onData(d.toString('latin1')));
    socket.on('timeout', () => socket.destroy(new Error('no traffic')));
    socket.on('error', (err) => this.log.debug(`[Shure] ${this.host}: ${err.message}`));
    socket.on('close', () => {
      if (this.socket === socket) this.socket = null;
      this.setOnline(false);
      for (const p of this.pending.splice(0)) p.reject(new Error('connection closed'));
      if (!this.closed) this.later(() => this.connect(), RECONNECT_MS);
    });
  }

  keepalive() {
    this.later(() => {
      if (!this.socket) return;
      this.request('< GET MODEL >', (r) => r.channel === null && r.prop === 'MODEL').catch(() => this.socket && this.socket.destroy());
      this.keepalive();
    }, KEEPALIVE_MS);
  }

  write(line) {
    if (!this.socket) return false;
    this.socket.write(line);
    return true;
  }

  request(line, match) {
    return new Promise((resolve, reject) => {
      if (!this.write(line)) return reject(new Error('not connected'));
      const p = { match, resolve, reject, timer: null };
      p.timer = setTimeout(() => {
        const i = this.pending.indexOf(p);
        if (i >= 0) this.pending.splice(i, 1);
        reject(new Error(`no reply to ${line.trim()}`));
      }, REQUEST_TIMEOUT_MS);
      p.timer.unref();
      this.pending.push(p);
    });
  }

  /** On connect: identify the unit, learn its channels, read the static properties, start meters. */
  async hello() {
    const model = await this.request('< GET MODEL >', (r) => r.channel === null && r.prop === 'MODEL');
    this.model = model.args[0] || null;
    try {
      const id = await this.request('< GET DEVICE_ID >', (r) => r.channel === null && r.prop === 'DEVICE_ID');
      this.deviceId = id.args[0] || null;
    } catch {
      // older firmware
    }
    let numbers = null;
    try {
      const avail = await this.request('< GET AVAILABLE_CHANNELS >', (r) => r.channel === null && r.prop === 'AVAILABLE_CHANNELS');
      const list = (avail.args[0] || '').split(',').map((s) => parseInt(s, 10)).filter((n) => n >= 1);
      if (list.length) numbers = list;
    } catch {
      // AD4D / AD4Q do not have AVAILABLE_CHANNELS: infer from the model name
    }
    if (!numbers) {
      const count = /AD4D/i.test(this.model || '') ? 2 : /AD4Q/i.test(this.model || '') ? 4 : this.maxChannels;
      numbers = Array.from({ length: count }, (_, i) => i + 1);
    }
    for (const n of numbers) if (!this.channels.has(n)) this.channels.set(n, emptyChannel(n));
    for (const n of [...this.channels.keys()]) if (!numbers.includes(n)) this.channels.delete(n);
    this.emit('structure');

    for (const n of numbers) {
      for (const prop of CHANNEL_PROPS) this.write(`< GET ${n} ${prop} >`);
      this.write(`< SET ${n} METER_RATE ${String(METER_RATE_MS).padStart(5, '0')} >`);
    }
  }

  onData(text) {
    this.buffer += text;
    const { frames, rest } = splitFrames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) {
      let rep;
      try {
        rep = parseFrame(frame);
      } catch {
        rep = null;
      }
      if (!rep) continue;
      if (rep.prop === 'ERR' && this.pending.length) {
        // The unit answers an unsupported GET with a bare ERR: fail the oldest request.
        const p = this.pending.shift();
        clearTimeout(p.timer);
        p.reject(new Error('REP ERR'));
        continue;
      }
      const i = this.pending.findIndex((p) => p.match(rep));
      if (i >= 0) {
        const p = this.pending.splice(i, 1)[0];
        clearTimeout(p.timer);
        p.resolve(rep);
      }
      this.apply(rep);
    }
  }

  apply(rep) {
    if (rep.prop === 'DEVICE_ID' && rep.channel === null) this.deviceId = rep.args[0] || this.deviceId;
    if (rep.channel === null || rep.channel === 0) return;
    const ch = this.channels.get(rep.channel) || (this.channels.set(rep.channel, emptyChannel(rep.channel)), this.channels.get(rep.channel));
    const v = rep.args[0];
    const now = Date.now();
    switch (rep.prop) {
      case 'SAMPLE':
        if (!rep.sample) return;
        ch.quality = rep.sample.quality;
        ch.afPeak = rep.sample.afPeak;
        ch.af = rep.sample.afRms !== null ? rep.sample.afRms : rep.sample.afPeak;
        ch.rssi = rep.sample.rssi;
        ch.antennas = rep.sample.antennas;
        break;
      case 'CHAN_NAME':
        ch.name = v || null;
        break;
      case 'FREQUENCY':
        ch.frequencyKHz = num(v, 0) || null;
        break;
      case 'AUDIO_MUTE':
        ch.mute = v === 'ON' ? true : v === 'OFF' ? false : null;
        break;
      case 'TX_MODEL':
        ch.txModel = v && v !== 'UNKNOWN' ? v : null;
        break;
      case 'TX_DEVICE_ID':
        ch.txName = v || null;
        break;
      case 'TX_BATT_CHARGE_PERCENT':
        ch.battery.percent = unknown(v, 255);
        break;
      case 'TX_BATT_BARS':
        ch.battery.bars = unknown(v, 255);
        break;
      case 'TX_BATT_MINS': {
        const m = unknown(v, 65535);
        ch.battery.minutes = m !== null && m <= 65532 ? m : null;
        break;
      }
      case 'TX_BATT_TYPE':
        ch.battery.type = v && v !== 'UNKN' ? v : null;
        break;
      case 'TX_MUTE_MODE_STATUS':
        if (v === 'MUTE') ch.mute = true;
        else if (v === 'ON' && ch.mute !== true) ch.mute = false;
        break;
      case 'INTERFERENCE_STATUS':
        setWarning(ch, 'Interference', v === 'DETECTED');
        break;
      case 'ENCRYPTION_STATUS':
        setWarning(ch, 'Encryption mismatch', v === 'ERROR');
        break;
      case 'UNREGISTERED_TX_STATUS':
        setWarning(ch, 'Unregistered transmitter', v === 'ERROR');
        break;
      default:
        return;
    }
    ch.updatedAt = now;
    this.emit('update', rep.channel);
  }

  snapshot() {
    return {
      online: this.online,
      model: this.model,
      deviceId: this.deviceId,
      channels: Object.fromEntries([...this.channels.values()].map((c) => [c.number, c]))
    };
  }
}

function setWarning(ch, text, on) {
  const has = ch.warnings.includes(text);
  if (on && !has) ch.warnings.push(text);
  if (!on && has) ch.warnings = ch.warnings.filter((w) => w !== text);
}

module.exports = { ShureReceiver, parseFrame, parseSample, splitFrames, PORT };
