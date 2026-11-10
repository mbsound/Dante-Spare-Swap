'use strict';

/**
 * Sennheiser SSCv2: HTTPS REST + Server-Sent Events, port 443, HTTP basic auth.
 * Devices use self-signed certificates, so TLS verification is off for them.
 *
 *   EW-DX EM 2 / EM 4 (firmware 4.0+): user "api"; channels 0..3 at
 *     /api/channel/{i}, /api/channel/{i}/{level,signalStrengthIndicator,signalQualityIndicator,diversityIndicator,warnings}
 *     /api/transmitters/{i} and /api/transmitters/{i}/battery, /api/rf/channels/{i} (frequency, kHz)
 *   Spectera base station: user "controlSennheiser"; mobile devices from
 *     /api/mts/paired/all (rssi, micLqi, battery…), frequency via /api/rf/channels,
 *     audio via /api/audio/levels (mapping to a device is best effort).
 *
 * Subscription: GET /api/ssc/state/subscriptions (event-stream) returns a session
 * UUID in Content-Location; PUT …/{uuid}/add with ["/api/path", …]; each
 * notification is a JSON object keyed by path.
 */

const https = require('https');
const http = require('http');
const { EventEmitter } = require('events');
const { emptyChannel, num } = require('./telemetry');

const RECONNECT_MS = 5000;
const POLL_MS = 2000; // slow poll for things the device may not push
const REQUEST_TIMEOUT_MS = 5000;

const PROFILES = {
  'sennheiser-ewdx': {
    kind: 'ewdx',
    user: 'api',
    channels: 4,
    subscribe: (count) => {
      const paths = [];
      for (let i = 0; i < count; i++) {
        paths.push(
          `/api/channel/${i}`,
          `/api/channel/${i}/level`,
          `/api/channel/${i}/signalStrengthIndicator`,
          `/api/channel/${i}/signalQualityIndicator`,
          `/api/channel/${i}/diversityIndicator`,
          `/api/channel/${i}/warnings`,
          `/api/transmitters/${i}`,
          `/api/transmitters/${i}/battery`,
          `/api/rf/channels/${i}`
        );
      }
      return paths;
    }
  },
  'sennheiser-spectera': {
    kind: 'spectera',
    user: 'controlSennheiser',
    channels: 32,
    subscribe: () => ['/api/mts/paired/all', '/api/rf/channels', '/api/audio/levels', '/api/audio/links']
  }
};

class SscRestReceiver extends EventEmitter {
  constructor({ host, port = 443, brand = 'sennheiser-ewdx', username, password, log, channels, insecure = true }) {
    super();
    this.host = host;
    this.port = port;
    this.profile = PROFILES[brand] || PROFILES['sennheiser-ewdx'];
    this.username = username || this.profile.user;
    this.password = password || '';
    this.log = log || console;
    this.count = channels || this.profile.channels;
    this.insecure = insecure;
    this.channels = new Map();
    if (this.profile.kind === 'ewdx') for (let n = 1; n <= this.count; n++) this.channels.set(n, emptyChannel(n));
    this.online = false;
    this.model = null;
    this.deviceId = null;
    this.closed = false;
    this.stream = null;
    this.sessionUUID = null;
    this.timers = [];
    this.spectera = { links: null, levels: null, rf: null, devices: [] };
    this.lastError = null;
  }

  start() {
    this.closed = false;
    this.open().catch((err) => this.fail(err));
    const poll = setInterval(() => {
      if (this.closed || !this.online) return;
      this.refresh().catch((err) => this.log.debug(`[SSCv2] ${this.host} poll: ${err.message}`));
    }, POLL_MS * 5);
    poll.unref();
    this.timers.push(poll);
  }

  stop() {
    this.closed = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
    this.setOnline(false);
  }

  setOnline(on) {
    if (this.online === on) return;
    this.online = on;
    this.emit('status', on);
  }

  fail(err) {
    this.lastError = err.message;
    this.log.debug(`[SSCv2] ${this.host}: ${err.message}`);
    this.setOnline(false);
    if (this.stream) {
      this.stream.destroy();
      this.stream = null;
    }
    if (!this.closed) {
      const t = setTimeout(() => this.open().catch((e) => this.fail(e)), RECONNECT_MS);
      t.unref();
      this.timers.push(t);
    }
  }

  requestOptions(method, path, headers = {}) {
    return {
      host: this.host,
      port: this.port,
      method,
      path,
      rejectUnauthorized: !this.insecure,
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.username}:${this.password}`).toString('base64')}`,
        Accept: 'application/json',
        ...headers
      }
    };
  }

  get transport() {
    return this.port === 80 ? http : https;
  }

  /** JSON request; resolves { status, body }. */
  call(method, path, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const opts = this.requestOptions(method, path, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {});
      const req = this.transport.request(opts, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode, body: parsed, headers: res.headers });
        });
      });
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  }

  async get(path) {
    const r = await this.call('GET', path);
    if (r.status === 401 || r.status === 403) throw new Error(`${this.host} rejected the credentials (${r.status})`);
    return r.status >= 200 && r.status < 300 ? r.body : null;
  }

  /** Identify, open the event stream, add subscriptions, and take a first full read. */
  async open() {
    if (this.closed) return;
    const identity = await this.get('/api/device/identity');
    if (identity) this.model = identity.product || identity.productName || this.model;
    const site = await this.get('/api/device/site');
    if (site) this.deviceId = site.name || site.deviceName || this.deviceId;
    await this.openStream();
    await this.refresh();
  }

  openStream() {
    return new Promise((resolve, reject) => {
      const opts = this.requestOptions('GET', '/api/ssc/state/subscriptions', { Accept: 'text/event-stream' });
      const req = this.transport.request(opts, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`subscription stream refused (${res.statusCode})`));
        }
        const loc = res.headers['content-location'] || '';
        this.sessionUUID = (loc.match(/subscriptions\/([0-9a-f-]+)/i) || [])[1] || null;
        this.stream = res;
        this.setOnline(true);
        this.lastError = null;
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            this.onEvent(block);
          }
        });
        res.on('end', () => this.fail(new Error('subscription stream ended')));
        res.on('error', (err) => this.fail(err));
        const add = () => {
          if (!this.sessionUUID) return resolve();
          this.call('PUT', `/api/ssc/state/subscriptions/${this.sessionUUID}/add`, this.profile.subscribe(this.count))
            .then(() => resolve())
            .catch(reject);
        };
        // The session UUID can also arrive in the "open" event; give it a moment.
        setTimeout(add, 150).unref();
      });
      req.on('error', reject);
      req.end();
    });
  }

  onEvent(block) {
    let event = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (!data.length) return;
    let parsed;
    try {
      parsed = JSON.parse(data.join('\n'));
    } catch {
      return;
    }
    if (event === 'open' && parsed && parsed.sessionUUID && !this.sessionUUID) this.sessionUUID = parsed.sessionUUID;
    if (event === 'message' || event === 'open') this.applyPaths(parsed);
  }

  /** Initial / periodic read of everything we subscribe to. */
  async refresh() {
    const paths = this.profile.subscribe(this.count);
    const values = {};
    for (const p of paths) {
      try {
        const v = await this.get(p);
        if (v !== null) values[p] = v;
      } catch (err) {
        if (/credentials/.test(err.message)) throw err;
      }
    }
    this.applyPaths(values);
  }

  applyPaths(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (this.profile.kind === 'ewdx') this.applyEwdx(obj);
    else this.applySpectera(obj);
  }

  applyEwdx(obj) {
    const now = Date.now();
    const touched = new Set();
    for (const [path, value] of Object.entries(obj)) {
      const m = /^\/api\/(channel|transmitters|rf\/channels)\/(\d+)(?:\/([A-Za-z]+))?$/.exec(path);
      if (!m || value === null || value === undefined) continue;
      const n = Number(m[2]) + 1;
      const ch = this.channels.get(n);
      if (!ch) continue;
      const leaf = m[3];
      const v = value && typeof value === 'object' && 'value' in value ? value.value : value;
      if (m[1] === 'channel') {
        if (!leaf) {
          if ('name' in value) ch.name = value.name || null;
          if (typeof value.mute === 'boolean') ch.mute = value.mute;
        } else if (leaf === 'level') ch.af = num(v, -140, 0);
        else if (leaf === 'signalStrengthIndicator') {
          const dbm = num(v, -120, 0);
          const a = ch.antennas[0] === 'B';
          const b = ch.antennas[1] === 'B';
          ch.rssi = a && !b ? [dbm, null] : b && !a ? [null, dbm] : [dbm, dbm];
        } else if (leaf === 'signalQualityIndicator') ch.quality = num(v, 0, 100);
        else if (leaf === 'diversityIndicator') {
          const d = Number(v);
          ch.antennas = d === 1 ? ['B', 'X'] : d === 2 ? ['X', 'B'] : ['X', 'X'];
        } else if (leaf === 'warnings') ch.warnings = Array.isArray(value) ? value.map(String) : [];
      } else if (m[1] === 'transmitters') {
        if (leaf === 'battery') {
          if ('gauge' in value) ch.battery.percent = num(value.gauge, 0, 100);
          if ('lifetime' in value) ch.battery.minutes = num(value.lifetime, 0);
          if ('type' in value) ch.battery.type = value.type || null;
        } else if (!leaf) {
          if ('type' in value) ch.txModel = value.type || null;
          if ('name' in value) ch.txName = value.name || null;
          if (typeof value.mute === 'boolean') ch.mute = value.mute;
        }
      } else if (m[1] === 'rf/channels' && !leaf) {
        if ('frequency' in value) ch.frequencyKHz = num(value.frequency, 0) || null;
      }
      touched.add(n);
    }
    for (const n of touched) {
      this.channels.get(n).updatedAt = now;
      this.emit('update', n);
    }
  }

  /** Spectera: one "channel" per paired mobile device, numbered by position in the paired list. */
  applySpectera(obj) {
    const s = this.spectera;
    if (Array.isArray(obj['/api/mts/paired/all'])) s.devices = obj['/api/mts/paired/all'];
    if (Array.isArray(obj['/api/rf/channels'])) s.rf = obj['/api/rf/channels'];
    if (obj['/api/audio/levels']) s.levels = obj['/api/audio/levels'];
    if (obj['/api/audio/links']) s.links = obj['/api/audio/links'];
    const now = Date.now();
    const seen = new Set();
    s.devices.forEach((dev, i) => {
      const n = i + 1;
      seen.add(n);
      const ch = this.channels.get(n) || (this.channels.set(n, emptyChannel(n)), this.channels.get(n));
      ch.name = dev.name || null;
      ch.txName = dev.name || null;
      ch.txModel = dev.type || null;
      const rssi = num(dev.rssi, -120, 0);
      const ant = String(dev.dominantAntenna || '').toLowerCase();
      ch.rssi = [rssi, rssi];
      ch.antennas = ant === 'a' ? ['B', 'X'] : ant === 'b' ? ['X', 'B'] : ['B', 'B'];
      const lqi = num(dev.micLqi, 0, 5);
      ch.quality = lqi === null ? null : lqi * 20;
      ch.battery.percent = num(dev.batteryFillLevel, 0, 100);
      const rt = num(dev.batteryRuntime, 0);
      ch.battery.minutes = rt !== null && rt < 65535 ? rt : null;
      ch.warnings = [];
      if (dev.batteryLow) ch.warnings.push('Battery low');
      if (dev.interference && dev.interference.severity && dev.interference.severity !== 'Low') ch.warnings.push(`Interference ${dev.interference.severity}`);
      if (dev.state && dev.state !== 'Connected') ch.warnings.push(dev.state);
      const rf = s.rf && s.rf.find((r) => r.rfChannelId === dev.rfChannelId);
      ch.frequencyKHz = rf ? num(rf.frequency, 0) || null : null;
      ch.af = audioLevelFor(dev, s.links, s.levels);
      ch.updatedAt = now;
      this.emit('update', n);
    });
    for (const n of [...this.channels.keys()]) if (!seen.has(n)) this.channels.delete(n);
  }

  snapshot() {
    return { online: this.online, model: this.model, deviceId: this.deviceId, lastError: this.lastError, channels: Object.fromEntries([...this.channels.values()].map((c) => [c.number, c])) };
  }
}

/**
 * Best effort: find the audio output a mobile device's MIC link feeds and read
 * its level. The docs give no schema for /api/audio/links or /api/audio/levels,
 * so a few plausible shapes are tried; null when nothing matches.
 */
function audioLevelFor(dev, links, levels) {
  if (!levels || dev.micAudiolinkId === undefined || dev.micAudiolinkId < 0) return null;
  const link = Array.isArray(links) ? links.find((l) => l && (l.id === dev.micAudiolinkId || l.audiolinkId === dev.micAudiolinkId)) : null;
  const outputId = link ? (link.outputId ?? link.audioOutputId ?? link.output ?? null) : null;
  const outputs = levels.outputs || levels.output || levels.mic || levels.MIC || null;
  if (outputId === null || !outputs) return null;
  const v = Array.isArray(outputs) ? outputs[outputId] : outputs[outputId];
  const n = typeof v === 'object' && v ? v.level ?? v.value : v;
  return num(n, -140, 0);
}

module.exports = { SscRestReceiver, PROFILES, audioLevelFor };
