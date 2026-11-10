'use strict';

/**
 * Demo engine: a handful of pretend Dante devices with moving meters and a
 * working routing table, so the UI can be set up and rehearsed with no Dante
 * network. Same surface as DanteEngine as far as the web layer is concerned.
 * Enabled with --demo.
 */

const { EventEmitter } = require('events');
const { txSubscriptionName } = require('./engine');

const DEMO_DEVICES = [
  { ip: '169.254.10.1', name: 'RF-Rack-A', tx: 8, rx: 0, model: 'Quad Receiver x2', tone: 0 },
  { ip: '169.254.10.2', name: 'RF-Rack-B', tx: 8, rx: 0, model: 'Quad Receiver x2', tone: 1 },
  { ip: '169.254.10.9', name: 'FOH-Console', tx: 0, rx: 32, model: 'Mixing Console' },
  { ip: '169.254.10.12', name: 'Monitor-Console', tx: 0, rx: 32, model: 'Mixing Console' }
];

const TX_FRIENDLY = { 'RF-Rack-A': { 1: 'Vocal 1', 2: 'Vocal 2', 3: 'Vocal 3', 4: 'Vocal 4' } };

class DemoEngine extends EventEmitter {
  constructor({ log } = {}) {
    super();
    this.log = log || console;
    this.devices = new Map();
    this.boundIp = '169.254.0.1';
    this.levels = new Map(); // "ip|ch" -> phase
    this.phase = 0;
    for (const d of DEMO_DEVICES) {
      const dev = {
        ip: d.ip,
        name: d.name,
        hasName: true,
        online: true,
        manufacturer: 'Demo Audio',
        modelName: d.model,
        sampleRate: 48000,
        tx: { count: d.tx, channels: {} },
        rx: { count: d.rx, channels: {} }
      };
      for (let i = 1; i <= d.tx; i++) {
        const friendly = (TX_FRIENDLY[d.name] || {})[i] || null;
        dev.tx.channels[i] = { number: i, friendlyName: friendly, canonicalName: String(i).padStart(2, '0'), name: friendly || String(i).padStart(2, '0') };
      }
      for (let i = 1; i <= d.rx; i++) {
        dev.rx.channels[i] = { number: i, name: `In ${i}`, subscribedDevice: null, subscribedChannel: null, status: 0, connected: false };
      }
      this.devices.set(dev.ip, dev);
    }
    // Starting routing: FOH inputs 1-4 take RF-Rack-A 1-4.
    for (let i = 1; i <= 4; i++) this.route('FOH-Console', i, 'RF-Rack-A', i);
    this.route('FOH-Console', 31, 'RF-Rack-B', 7); // a spare parked on a listen input
  }

  start() {
    this.log.info('[Demo] Simulated Dante network (no real devices are contacted).');
    this.timer = setInterval(() => (this.phase += 0.05), 50);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
  }
  selectInterface() {
    return this.interfaceInfo();
  }
  interfaceInfo() {
    return { boundIp: this.boundIp, name: 'Demo network' };
  }
  refresh() {}

  findDeviceByName(name) {
    const wanted = String(name || '').trim().toLowerCase();
    for (const dev of this.devices.values()) if (dev.ip === name || dev.name.toLowerCase() === wanted) return dev;
    return null;
  }
  isOnline() {
    return true;
  }

  route(rxDevice, rxChannel, txDevice, txChannel) {
    const rx = this.findDeviceByName(rxDevice);
    const tx = this.findDeviceByName(txDevice);
    const rec = rx && rx.rx.channels[rxChannel];
    if (!rec) return false;
    if (!txDevice) {
      Object.assign(rec, { subscribedDevice: null, subscribedChannel: null, status: 0, connected: false });
      return true;
    }
    const name = tx ? txSubscriptionName(tx, txChannel) : String(txChannel).padStart(2, '0');
    const exists = Boolean(tx && tx.tx.channels[txChannel]);
    Object.assign(rec, { subscribedDevice: tx ? tx.name : txDevice, subscribedChannel: name, status: exists ? 9 : 1, connected: exists });
    return true;
  }

  txSubscriptionName(txDevice, txChannel) {
    return txSubscriptionName(this.findDeviceByName(txDevice), Number(txChannel));
  }
  rxState(rxDevice, rxChannel) {
    const dev = this.findDeviceByName(rxDevice);
    const ch = dev && dev.rx.channels[Number(rxChannel)];
    return ch ? { ...ch, online: true } : null;
  }
  receiversOf(txDevice, txChannel) {
    const tx = this.findDeviceByName(txDevice);
    if (!tx) return [];
    const name = txSubscriptionName(tx, Number(txChannel)).toLowerCase();
    const out = [];
    for (const dev of this.devices.values()) {
      for (const ch of Object.values(dev.rx.channels)) {
        if (ch.subscribedDevice && ch.subscribedDevice.toLowerCase() === tx.name.toLowerCase() && String(ch.subscribedChannel).toLowerCase() === name) {
          out.push({ device: dev.name, ip: dev.ip, channel: ch.number });
        }
      }
    }
    return out;
  }
  subscribe({ rxDevice, rxChannel, txDevice, txChannel }) {
    const rx = this.findDeviceByName(rxDevice);
    if (!rx) return { ok: false, error: `Receiver "${rxDevice}" is not on the network` };
    if (!rx.rx.channels[Number(rxChannel)]) return { ok: false, error: `Receiver "${rx.name}" has no Rx channel ${rxChannel}` };
    const tx = this.findDeviceByName(txDevice);
    const txName = tx ? tx.name : String(txDevice);
    const chanName = txSubscriptionName(tx, Number(txChannel));
    setTimeout(() => this.route(rx.name, Number(rxChannel), txName, Number(txChannel)), 200).unref();
    this.log.info(`[Demo] ${rx.name} Rx ${rxChannel} <- ${txName} / ${chanName}`);
    return { ok: true, txName, txChannelName: chanName, txOnline: Boolean(tx) };
  }
  unsubscribe({ rxDevice, rxChannel }) {
    const rx = this.findDeviceByName(rxDevice);
    if (!rx) return { ok: false, error: `Receiver "${rxDevice}" is not on the network` };
    setTimeout(() => this.route(rx.name, Number(rxChannel), null), 150).unref();
    this.log.info(`[Demo] ${rx.name} Rx ${rxChannel} <- (cleared)`);
    return { ok: true };
  }

  getDevices() {
    return [...this.devices.values()].map((dev) => ({
      ip: dev.ip,
      name: dev.name,
      online: true,
      manufacturer: dev.manufacturer,
      modelName: dev.modelName,
      sampleRate: dev.sampleRate,
      isClockLeader: dev.name === 'FOH-Console',
      primarySync: 'good',
      secondarySync: 'none',
      secondarySupported: true,
      tx: {
        count: dev.tx.count,
        channels: Object.fromEntries(Object.values(dev.tx.channels).map((ch) => [ch.number, { ...ch, subscriptionName: txSubscriptionName(dev, ch.number) }]))
      },
      rx: { count: dev.rx.count, channels: dev.rx.channels }
    }));
  }

  /** Tx levels: a slow musical wobble per channel; Rx levels mirror the subscribed Tx. */
  txByte(dev, ch) {
    const idx = [...this.devices.keys()].indexOf(dev.ip);
    const seed = idx * 8 + ch;
    // Channel 3 on rack A is the "faulty pack": intermittent dropouts.
    if (dev.name === 'RF-Rack-A' && ch === 3 && Math.sin(this.phase / 3) > 0.2) return 254;
    const db = -14 + 10 * Math.sin(this.phase * (0.7 + (seed % 5) * 0.13) + seed) + 4 * Math.sin(this.phase * 3.1 + seed * 2);
    const clamped = Math.max(-60, Math.min(0, db));
    return clamped <= -60 ? 254 : Math.round(1 - clamped * 2);
  }

  getMeterFrame() {
    const frame = {};
    for (const dev of this.devices.values()) {
      const tx = [];
      for (let ch = 1; ch <= dev.tx.count; ch++) tx.push(this.txByte(dev, ch));
      const rx = [];
      for (let ch = 1; ch <= dev.rx.count; ch++) {
        const rec = dev.rx.channels[ch];
        if (!rec.connected) {
          rx.push(null);
          continue;
        }
        const src = this.findDeviceByName(rec.subscribedDevice);
        const n = src && Object.values(src.tx.channels).find((c) => txSubscriptionName(src, c.number) === rec.subscribedChannel);
        rx.push(src && n ? this.txByte(src, n.number) : null);
      }
      frame[dev.ip] = { tx, rx };
    }
    return frame;
  }

  getSnapshot() {
    return { timestamp: Date.now(), boundIp: this.boundIp, demo: true, devices: this.getDevices() };
  }
}

module.exports = { DemoEngine };
