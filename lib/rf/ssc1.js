'use strict';

/**
 * Sennheiser Sound Control (SSC v1): JSON over UDP, port 45 by default.
 * A GET is the address tree with null leaves: {"m":{"rx1":{"rssi":null}}}.
 * Subscriptions: {"osc":{"state":{"subscribe":[{"#":{min,max,count,lifetime}, ...tree}]}}}
 * and the server pushes the same tree with values until the lifetime expires,
 * so we renew every (lifetime / 2) seconds.
 *
 * Used for EW-DX EM 2 / EM 4 on firmware before 4.0, and (unverified) EM 6000.
 */

const dgram = require('dgram');
const { EventEmitter } = require('events');
const { emptyChannel, num } = require('./telemetry');

const PORT = 45;
const LIFETIME_S = 60;
const RENEW_MS = 25000;
const OFFLINE_AFTER_MS = 20000;
const METER_MAX_MS = 100; // no faster than 10 notifications/s for meters
const METER_MIN_MS = 1000; // but at least once a second even if unchanged

/**
 * Address profile: how receiver channel N maps onto the SSC tree.
 * EW-DX names its receiver channels rx1..rx4 and their transmitters mates/tx1..tx4.
 */
const PROFILES = {
  'sennheiser-ewdx-v1': {
    channels: 4,
    meters: (n) => ({ m: { [`rx${n}`]: { af: null, rssi: null, rsqi: null, divi: null } } }),
    state: (n) => ({
      [`rx${n}`]: { name: null, frequency: null, mute: null, warnings: null },
      mates: { [`tx${n}`]: { name: null, type: null, mute: null, battery: { gauge: null, lifetime: null, type: null } } }
    })
  }
};
// EM 6000: the public docs we could reach do not list its SSC methods; the EW-DX
// layout is used until a unit says otherwise (errors are logged, nothing breaks).
PROFILES['sennheiser-6000'] = { ...PROFILES['sennheiser-ewdx-v1'], channels: 2 };

function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      merge(target[k], v);
    } else target[k] = v;
  }
  return target;
}

class SscUdpReceiver extends EventEmitter {
  constructor({ host, port = PORT, brand = 'sennheiser-ewdx-v1', log, channels }) {
    super();
    this.host = host;
    this.port = port;
    this.log = log || console;
    this.profile = PROFILES[brand] || PROFILES['sennheiser-ewdx-v1'];
    this.count = channels || this.profile.channels;
    this.channels = new Map();
    for (let n = 1; n <= this.count; n++) this.channels.set(n, emptyChannel(n));
    this.socket = null;
    this.online = false;
    this.lastHeard = 0;
    this.timers = [];
    this.model = null;
    this.deviceId = null;
    this.closed = false;
  }

  start() {
    this.closed = false;
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (msg) => this.onMessage(msg));
    this.socket.on('error', (err) => this.log.debug(`[SSC] ${this.host}: ${err.message}`));
    this.socket.bind(0, () => {
      this.subscribeAll();
      this.send({ device: { name: null, identity: { product: null } } });
    });
    const renew = setInterval(() => {
      if (this.closed) return;
      this.subscribeAll();
      this.send({ device: { name: null } });
      this.setOnline(Date.now() - this.lastHeard < OFFLINE_AFTER_MS);
    }, RENEW_MS);
    renew.unref();
    this.timers.push(renew);
    const watchdog = setInterval(() => this.setOnline(Date.now() - this.lastHeard < OFFLINE_AFTER_MS), 5000);
    watchdog.unref();
    this.timers.push(watchdog);
  }

  stop() {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.socket) {
      try {
        this.send({ osc: { state: { subscribe: [{ '#': { cancel: true }, ...this.fullTree() }] } } });
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.setOnline(false);
  }

  setOnline(on) {
    if (this.online === on) return;
    this.online = on;
    this.emit('status', on);
  }

  send(tree) {
    if (!this.socket) return;
    const buf = Buffer.from(JSON.stringify(tree));
    this.socket.send(buf, this.port, this.host, (err) => {
      if (err) this.log.debug(`[SSC] send to ${this.host}: ${err.message}`);
    });
  }

  fullTree() {
    const tree = {};
    for (let n = 1; n <= this.count; n++) {
      merge(tree, this.profile.meters(n));
      merge(tree, this.profile.state(n));
    }
    return tree;
  }

  subscribeAll() {
    const meters = {};
    const state = {};
    for (let n = 1; n <= this.count; n++) {
      merge(meters, this.profile.meters(n));
      merge(state, this.profile.state(n));
    }
    // Meters: throttled; state: on change. Two trees so the server can treat them separately.
    this.send({ osc: { state: { subscribe: [{ '#': { min: METER_MIN_MS, max: METER_MAX_MS, count: 100000, lifetime: LIFETIME_S }, ...meters }] } } });
    this.send({ osc: { state: { subscribe: [{ '#': { min: 0, max: 0, count: 100000, lifetime: LIFETIME_S }, ...state }] } } });
  }

  onMessage(msg) {
    let tree;
    try {
      tree = JSON.parse(msg.toString('utf8'));
    } catch {
      return;
    }
    if (!tree || typeof tree !== 'object') return;
    this.lastHeard = Date.now();
    this.setOnline(true);
    if (tree.osc && tree.osc.error) this.log.debug(`[SSC] ${this.host} error: ${JSON.stringify(tree.osc.error)}`);
    if (tree.device) {
      if (typeof tree.device.name === 'string') this.deviceId = tree.device.name;
      if (tree.device.identity && typeof tree.device.identity.product === 'string') this.model = tree.device.identity.product;
    }
    this.applyTree(tree);
  }

  applyTree(tree) {
    const now = Date.now();
    const touched = new Set();
    const chFor = (key) => {
      const m = /^(?:rx|tx)(\d+)$/.exec(key);
      const n = m ? Number(m[1]) : null;
      return n && this.channels.has(n) ? this.channels.get(n) : null;
    };
    if (tree.m && typeof tree.m === 'object') {
      for (const [key, vals] of Object.entries(tree.m)) {
        const ch = chFor(key);
        if (!ch || !vals || typeof vals !== 'object') continue;
        if ('af' in vals) ch.af = num(vals.af, -140, 0);
        if ('rssi' in vals) {
          const dbm = num(vals.rssi, -120, 0);
          const divi = 'divi' in vals ? Number(vals.divi) : null;
          ch.rssi = divi === 2 ? [null, dbm] : divi === 1 ? [dbm, null] : [dbm, dbm];
        }
        if ('divi' in vals) {
          const d = Number(vals.divi);
          ch.antennas = d === 1 ? ['B', 'X'] : d === 2 ? ['X', 'B'] : ['X', 'X'];
        }
        if ('rsqi' in vals) ch.quality = num(vals.rsqi, 0, 100);
        touched.add(ch.number);
      }
    }
    for (const [key, vals] of Object.entries(tree)) {
      const ch = /^rx\d+$/.test(key) ? chFor(key) : null;
      if (!ch || !vals || typeof vals !== 'object') continue;
      if ('name' in vals) ch.name = vals.name || null;
      if ('frequency' in vals) ch.frequencyKHz = num(vals.frequency, 0) || null;
      if ('mute' in vals && typeof vals.mute === 'boolean') ch.mute = vals.mute;
      if ('warnings' in vals) ch.warnings = Array.isArray(vals.warnings) ? vals.warnings.map(String) : [];
      touched.add(ch.number);
    }
    if (tree.mates && typeof tree.mates === 'object') {
      for (const [key, vals] of Object.entries(tree.mates)) {
        const ch = chFor(key);
        if (!ch || !vals || typeof vals !== 'object') continue;
        if ('name' in vals) ch.txName = vals.name || null;
        if ('type' in vals) ch.txModel = vals.type || null;
        if ('mute' in vals && typeof vals.mute === 'boolean') ch.mute = vals.mute;
        if (vals.battery && typeof vals.battery === 'object') {
          if ('gauge' in vals.battery) ch.battery.percent = num(vals.battery.gauge, 0, 100);
          if ('lifetime' in vals.battery) ch.battery.minutes = num(vals.battery.lifetime, 0);
          if ('type' in vals.battery) ch.battery.type = vals.battery.type || null;
        }
        touched.add(ch.number);
      }
    }
    for (const n of touched) {
      this.channels.get(n).updatedAt = now;
      this.emit('update', n);
    }
  }

  snapshot() {
    return { online: this.online, model: this.model, deviceId: this.deviceId, channels: Object.fromEntries([...this.channels.values()].map((c) => [c.number, c])) };
  }
}

module.exports = { SscUdpReceiver, PROFILES, merge, PORT };
