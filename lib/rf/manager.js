'use strict';

/**
 * Owns one client per configured receiver and hands the web layer a frame of
 * every receiver's channels. Receivers are configured in the show file; the
 * manager follows it (start / stop / restart on change).
 */

const { EventEmitter } = require('events');
const { BRANDS, emptyChannel } = require('./telemetry');
const { ShureReceiver } = require('./shure');
const { SscUdpReceiver } = require('./ssc1');
const { SscRestReceiver } = require('./ssc2');

/** Demo receiver: pretend channels with moving values. */
class SimulatedReceiver extends EventEmitter {
  constructor({ brand, name, channels }) {
    super();
    this.brand = brand;
    this.online = false;
    this.model = { 'shure-ad': 'AD4Q-A (simulated)', 'sennheiser-ewdx': 'EWDX4CHDS (simulated)', 'sennheiser-spectera': 'Spectera (simulated)' }[brand] || 'Simulated receiver';
    this.deviceId = name;
    this.channels = new Map();
    const names = ['Vocal 1', 'Vocal 2', 'Vocal 3', 'Vocal 4', 'Spare A', 'Spare B', '', ''];
    for (let n = 1; n <= (channels || 4); n++) {
      const ch = emptyChannel(n);
      ch.name = names[n - 1] || `CH ${n}`;
      ch.txName = ch.name ? ch.name.replace(' ', '') : null;
      ch.txModel = brand === 'shure-ad' ? 'ADX1' : 'EW-DX SK';
      ch.frequencyKHz = 520000 + n * 1250;
      ch.battery = { percent: 90 - n * 9, minutes: 300 - n * 35, bars: 5 - (n % 3), type: brand === 'shure-ad' ? 'LION' : 'Battery' };
      ch.mute = false;
      this.channels.set(n, ch);
    }
    this.phase = Math.random() * 10;
  }
  start() {
    this.online = true;
    this.timer = setInterval(() => this.tick(), 100);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
    this.online = false;
  }
  tick() {
    this.phase += 0.1;
    const now = Date.now();
    for (const ch of this.channels.values()) {
      const n = ch.number;
      const faulty = n === 3 && Math.sin(this.phase / 4) > 0.3; // the bad pack
      ch.af = faulty ? null : Math.max(-60, Math.min(-6, -22 + 12 * Math.sin(this.phase * (0.5 + n * 0.1) + n)));
      const a = faulty ? -95 : -50 + 10 * Math.sin(this.phase / 3 + n);
      const b = faulty ? -98 : -62 + 12 * Math.sin(this.phase / 2.3 + n * 2);
      ch.rssi = [Math.round(a), Math.round(b)];
      ch.antennas = a >= b ? ['B', 'X'] : ['X', 'B'];
      ch.quality = faulty ? 20 : 100 - (n === 2 ? 20 : 0);
      ch.warnings = faulty ? ['Interference'] : [];
      if (Math.random() < 0.002 && ch.battery.minutes > 1) ch.battery.minutes -= 1;
      ch.updatedAt = now;
    }
  }
  snapshot() {
    return { online: this.online, model: this.model, deviceId: this.deviceId, channels: Object.fromEntries([...this.channels.values()].map((c) => [c.number, c])) };
  }
}

function createClient(cfg, { log, simulate }) {
  const brand = BRANDS[cfg.brand] ? cfg.brand : 'shure-ad';
  const spec = BRANDS[brand];
  if (simulate) return new SimulatedReceiver({ brand, name: cfg.name, channels: cfg.channels || Math.min(spec.channels, 8) });
  const common = { host: cfg.host, port: cfg.port || spec.port, log, channels: cfg.channels || undefined };
  if (spec.transport === 'shure') return new ShureReceiver(common);
  if (spec.transport === 'ssc1') return new SscUdpReceiver({ ...common, brand });
  return new SscRestReceiver({ ...common, brand, username: cfg.username || spec.user, password: cfg.password || '' });
}

class RfManager extends EventEmitter {
  constructor({ store, log, simulate = false }) {
    super();
    this.store = store;
    this.log = log || console;
    this.simulate = simulate;
    this.clients = new Map(); // receiver id -> { key, client }
  }

  start() {
    this.sync();
    this.store.on('change', () => this.sync());
  }

  stop() {
    for (const { client } of this.clients.values()) client.stop();
    this.clients.clear();
  }

  /** Make the running clients match the receivers in the show file. */
  sync() {
    const wanted = new Map((this.store.show.receivers || []).map((r) => [r.id, r]));
    for (const [id, entry] of this.clients) {
      const cfg = wanted.get(id);
      if (!cfg || configKey(cfg) !== entry.key) {
        entry.client.stop();
        this.clients.delete(id);
      }
    }
    for (const [id, cfg] of wanted) {
      if (this.clients.has(id) || !cfg.host) continue;
      const client = createClient(cfg, { log: this.log, simulate: this.simulate });
      client.on('status', (on) => {
        this.log.info(`[RF] ${cfg.name || cfg.host} ${on ? 'online' : 'offline'}`);
        this.emit('status', { id, online: on });
      });
      client.start();
      this.clients.set(id, { key: configKey(cfg), client });
    }
  }

  /** Every receiver's channels, for the browsers. */
  getFrame() {
    const frame = {};
    for (const r of this.store.show.receivers || []) {
      const entry = this.clients.get(r.id);
      frame[r.id] = entry ? entry.client.snapshot() : { online: false, model: null, deviceId: null, channels: {} };
    }
    return frame;
  }
}

function configKey(cfg) {
  return [cfg.brand, cfg.host, cfg.port, cfg.username, cfg.password, cfg.channels].join('|');
}

module.exports = { RfManager, SimulatedReceiver, createClient };
