'use strict';

/**
 * Show file: the channels (cards) and spares the operator has defined, plus
 * which main is currently running on which spare. Persisted as JSON next to
 * the card pictures in the data directory.
 *
 *   channel: { id, name, image, tx: {device, channel}|null, rx: {device, channel}|null, spareId|null, notes }
 *   spare:   { id, name, image, tx: {device, channel}|null, rx: {device, channel}|null,
 *              monitorMain: bool, inUseBy: channelId|null }
 *
 * A spare's `rx` is where that spare pack is normally patched for monitoring
 * (a console input, a listen bus). With `monitorMain` on, a swap patches the
 * faulty main transmitter into that input so it can be worked on while the
 * spare carries the show; restore puts the spare's own transmitter back.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const SHOW_VERSION = 1;
const VIEWS = ['dante', 'rf', 'all'];
const { BRANDS } = require('../rf/telemetry');
const MAX_NAME = 64;

class ShowError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function cleanName(value, fallback) {
  const s = typeof value === 'string' ? value.trim().slice(0, MAX_NAME) : '';
  return s || fallback;
}

/** Validate a {device, channel} path, or null to clear it. */
function cleanPath(value, label) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'object') throw new ShowError(`${label} must be an object with device and channel`);
  const device = typeof value.device === 'string' ? value.device.trim() : '';
  const channel = Number(value.channel);
  if (!device) throw new ShowError(`${label}: device name is required`);
  if (!Number.isInteger(channel) || channel < 1 || channel > 1024) throw new ShowError(`${label}: channel must be 1-1024`);
  return { device, channel };
}

function cleanImage(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+\.(jpe?g|png|webp|gif)$/i.test(value)) throw new ShowError('Invalid image reference');
  return value;
}

/** Optional link from a card to a wireless receiver channel: { receiverId, channel } or null. */
function cleanRfLink(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'object') throw new ShowError('RF link must be an object with receiverId and channel');
  const receiverId = typeof value.receiverId === 'string' ? value.receiverId : '';
  const channel = Number(value.channel);
  if (!receiverId) return null;
  if (!Number.isInteger(channel) || channel < 1 || channel > 64) throw new ShowError('RF channel must be 1-64');
  return { receiverId, channel };
}

function cleanView(value, fallback = 'dante') {
  return VIEWS.includes(value) ? value : fallback;
}

function samePath(a, b) {
  return Boolean(a && b) && a.device.toLowerCase() === b.device.toLowerCase() && a.channel === b.channel;
}

class ShowStore extends EventEmitter {
  constructor({ dataDir, log = console } = {}) {
    super();
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'show.json');
    this.imagesDir = path.join(dataDir, 'images');
    this.log = log;
    this.show = { version: SHOW_VERSION, name: 'Untitled Show', channels: [], spares: [], receivers: [] };
    this.saveTimer = null;
  }

  load() {
    fs.mkdirSync(this.imagesDir, { recursive: true });
    if (!fs.existsSync(this.file)) return this.show;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.show = normalize(parsed);
      this.log.info(`[Show] Loaded ${this.show.channels.length} channels, ${this.show.spares.length} spares from ${this.file}`);
    } catch (err) {
      this.log.error(`[Show] Could not read ${this.file}: ${err.message}. Starting with an empty show.`);
    }
    return this.show;
  }

  /** Write soon (coalesces bursts of edits). */
  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 150);
    this.saveTimer.unref();
    this.emit('change', this.snapshot());
  }

  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.show, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.log.error(`[Show] Could not save ${this.file}: ${err.message}`);
    }
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.show));
  }

  // --- lookups -------------------------------------------------------------

  channel(id) {
    const ch = this.show.channels.find((c) => c.id === id);
    if (!ch) throw new ShowError(`Channel ${id} not found`, 404);
    return ch;
  }

  spare(id) {
    const sp = this.show.spares.find((s) => s.id === id);
    if (!sp) throw new ShowError(`Spare ${id} not found`, 404);
    return sp;
  }

  /** Spares whose Tx path equals the given path. */
  sparesWithTx(txPath) {
    return this.show.spares.filter((s) => samePath(s.tx, txPath));
  }

  // --- show ------------------------------------------------------------------

  rename(name) {
    this.show.name = cleanName(name, this.show.name);
    this.save();
    return this.show.name;
  }

  // --- channels ------------------------------------------------------------

  addChannel(input = {}) {
    if (this.show.channels.length >= 256) throw new ShowError('Too many channels');
    const ch = {
      id: newId('ch'),
      name: cleanName(input.name, `Channel ${this.show.channels.length + 1}`),
      image: cleanImage(input.image),
      tx: cleanPath(input.tx, 'Transmit path'),
      rx: cleanPath(input.rx, 'Receive path'),
      spareId: null,
      notes: typeof input.notes === 'string' ? input.notes.slice(0, 500) : '',
      rf: cleanRfLink(input.rf),
      view: cleanView(input.view)
    };
    this.show.channels.push(ch);
    this.save();
    return ch;
  }

  updateChannel(id, patch = {}) {
    const ch = this.channel(id);
    if ('name' in patch) ch.name = cleanName(patch.name, ch.name);
    if ('image' in patch) this.replaceImage(ch, cleanImage(patch.image));
    if ('tx' in patch) ch.tx = cleanPath(patch.tx, 'Transmit path');
    if ('rx' in patch) ch.rx = cleanPath(patch.rx, 'Receive path');
    if ('notes' in patch) ch.notes = typeof patch.notes === 'string' ? patch.notes.slice(0, 500) : '';
    if ('rf' in patch) ch.rf = cleanRfLink(patch.rf);
    if ('view' in patch) ch.view = cleanView(patch.view, ch.view);
    this.save();
    return ch;
  }

  removeChannel(id) {
    const ch = this.channel(id);
    for (const sp of this.show.spares) if (sp.inUseBy === id) sp.inUseBy = null;
    this.show.channels = this.show.channels.filter((c) => c !== ch);
    this.replaceImage(ch, null);
    this.save();
    return ch;
  }

  reorderChannels(ids) {
    this.show.channels = reorder(this.show.channels, ids);
    this.save();
  }

  reorderSpares(ids) {
    this.show.spares = reorder(this.show.spares, ids);
    this.save();
  }

  // --- spares --------------------------------------------------------------

  addSpare(input = {}) {
    if (this.show.spares.length >= 64) throw new ShowError('Too many spares');
    const sp = {
      id: newId('sp'),
      name: cleanName(input.name, `Spare ${this.show.spares.length + 1}`),
      image: cleanImage(input.image),
      tx: cleanPath(input.tx, 'Transmit path'),
      rx: cleanPath(input.rx, 'Monitor path'),
      monitorMain: Boolean(input.monitorMain),
      rf: cleanRfLink(input.rf),
      view: cleanView(input.view),
      inUseBy: null
    };
    this.show.spares.push(sp);
    this.save();
    return sp;
  }

  updateSpare(id, patch = {}) {
    const sp = this.spare(id);
    if ('name' in patch) sp.name = cleanName(patch.name, sp.name);
    if ('image' in patch) this.replaceImage(sp, cleanImage(patch.image));
    if ('tx' in patch) sp.tx = cleanPath(patch.tx, 'Transmit path');
    if ('rx' in patch) sp.rx = cleanPath(patch.rx, 'Monitor path');
    if ('monitorMain' in patch) sp.monitorMain = Boolean(patch.monitorMain);
    if ('rf' in patch) sp.rf = cleanRfLink(patch.rf);
    if ('view' in patch) sp.view = cleanView(patch.view, sp.view);
    this.save();
    return sp;
  }

  removeSpare(id) {
    const sp = this.spare(id);
    for (const ch of this.show.channels) if (ch.spareId === id) ch.spareId = null;
    this.show.spares = this.show.spares.filter((s) => s !== sp);
    this.replaceImage(sp, null);
    this.save();
    return sp;
  }

  // --- wireless receivers --------------------------------------------------

  receiver(id) {
    const r = this.show.receivers.find((x) => x.id === id);
    if (!r) throw new ShowError(`Receiver ${id} not found`, 404);
    return r;
  }

  cleanReceiver(input, existing = null) {
    const brand = BRANDS[input.brand] ? input.brand : existing ? existing.brand : null;
    if (!brand) throw new ShowError('Unknown receiver brand');
    const host = 'host' in input ? String(input.host || '').trim() : existing ? existing.host : '';
    if (!host || !/^[A-Za-z0-9.\-:]+$/.test(host)) throw new ShowError('Receiver needs an IP address or host name');
    const port = 'port' in input && input.port !== '' && input.port !== null ? Number(input.port) : existing ? existing.port : null;
    if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new ShowError('Port must be 1-65535');
    const channels = 'channels' in input && input.channels !== '' && input.channels !== null ? Number(input.channels) : existing ? existing.channels : null;
    if (channels !== null && (!Number.isInteger(channels) || channels < 1 || channels > 64)) throw new ShowError('Channels must be 1-64');
    return {
      id: existing ? existing.id : newId('rx'),
      name: cleanName(input.name, existing ? existing.name : host),
      brand,
      host,
      port,
      channels,
      username: 'username' in input ? String(input.username || '').trim().slice(0, 64) : existing ? existing.username : '',
      // Password is kept unless a new one is given; an explicit empty string clears it.
      password: 'password' in input && input.password !== undefined ? String(input.password).slice(0, 128) : existing ? existing.password : ''
    };
  }

  addReceiver(input = {}) {
    if (this.show.receivers.length >= 64) throw new ShowError('Too many receivers');
    const r = this.cleanReceiver(input);
    this.show.receivers.push(r);
    this.save();
    return r;
  }

  updateReceiver(id, patch = {}) {
    const r = this.receiver(id);
    Object.assign(r, this.cleanReceiver(patch, r));
    this.save();
    return r;
  }

  removeReceiver(id) {
    const r = this.receiver(id);
    this.show.receivers = this.show.receivers.filter((x) => x !== r);
    for (const item of [...this.show.channels, ...this.show.spares]) if (item.rf && item.rf.receiverId === id) item.rf = null;
    this.save();
    return r;
  }

  /** The show as sent to browsers: receiver passwords replaced by a flag. */
  publicSnapshot() {
    const snap = this.snapshot();
    snap.receivers = snap.receivers.map(({ password, ...r }) => ({ ...r, hasPassword: Boolean(password) }));
    return snap;
  }

  // --- swap bookkeeping ----------------------------------------------------

  /** Record that `channelId` now runs on `spareId` (or on its own path when null). */
  setOnSpare(channelId, spareId) {
    const ch = this.channel(channelId);
    const previous = ch.spareId;
    if (previous && previous !== spareId) {
      const prev = this.show.spares.find((s) => s.id === previous);
      if (prev && prev.inUseBy === channelId) prev.inUseBy = null;
    }
    if (spareId) {
      const sp = this.spare(spareId);
      const bumped = sp.inUseBy && sp.inUseBy !== channelId ? sp.inUseBy : null;
      if (bumped) {
        const other = this.show.channels.find((c) => c.id === bumped);
        if (other && other.spareId === spareId) other.spareId = null;
      }
      sp.inUseBy = channelId;
    }
    ch.spareId = spareId || null;
    this.save();
    return ch;
  }

  // --- images --------------------------------------------------------------

  /** Store a picture (data URL) and return its file name. */
  saveImage(dataUrl) {
    const m = /^data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
    if (!m) throw new ShowError('Picture must be a PNG, JPEG, WebP or GIF data URL');
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64');
    if (!bytes.length) throw new ShowError('Picture is empty');
    if (bytes.length > 4 * 1024 * 1024) throw new ShowError('Picture is too large (4 MB max)', 413);
    const file = `${newId('img')}.${ext}`;
    fs.mkdirSync(this.imagesDir, { recursive: true });
    fs.writeFileSync(path.join(this.imagesDir, file), bytes);
    return file;
  }

  imagePath(file) {
    let clean;
    try {
      clean = cleanImage(file);
    } catch {
      return null;
    }
    if (!clean) return null;
    const full = path.resolve(this.imagesDir, clean);
    return full.startsWith(this.imagesDir + path.sep) ? full : null;
  }

  replaceImage(item, newImage) {
    const old = item.image;
    item.image = newImage;
    if (!old || old === newImage) return;
    const stillUsed = [...this.show.channels, ...this.show.spares].some((x) => x !== item && x.image === old);
    if (stillUsed) return;
    const full = this.imagePath(old);
    if (full) fs.rm(full, { force: true }, () => {});
  }
}

/** Items in the order of `ids`; anything not listed keeps its place at the end. */
function reorder(items, ids) {
  if (!Array.isArray(ids)) throw new ShowError('ids must be an array');
  const byId = new Map(items.map((x) => [x.id, x]));
  const ordered = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item) {
      ordered.push(item);
      byId.delete(id);
    }
  }
  return [...ordered, ...byId.values()];
}

function normalize(raw) {
  const show = { version: SHOW_VERSION, name: 'Untitled Show', channels: [], spares: [], receivers: [] };
  if (!raw || typeof raw !== 'object') return show;
  show.name = cleanName(raw.name, show.name);
  const safePath = (p) => {
    try {
      return cleanPath(p, 'path');
    } catch {
      return null;
    }
  };
  const safeImage = (i) => {
    try {
      return cleanImage(i);
    } catch {
      return null;
    }
  };
  const safeRf = (v) => {
    try {
      return cleanRfLink(v);
    } catch {
      return null;
    }
  };
  for (const r of Array.isArray(raw.receivers) ? raw.receivers : []) {
    if (!r || typeof r.id !== 'string' || !BRANDS[r.brand]) continue;
    show.receivers.push({
      id: r.id,
      name: cleanName(r.name, 'Receiver'),
      brand: r.brand,
      host: typeof r.host === 'string' ? r.host : '',
      port: Number.isInteger(r.port) ? r.port : null,
      channels: Number.isInteger(r.channels) ? r.channels : null,
      username: typeof r.username === 'string' ? r.username : '',
      password: typeof r.password === 'string' ? r.password : ''
    });
  }
  const rxIds = new Set(show.receivers.map((r) => r.id));
  for (const c of Array.isArray(raw.channels) ? raw.channels : []) {
    if (!c || typeof c.id !== 'string') continue;
    show.channels.push({
      id: c.id,
      name: cleanName(c.name, 'Channel'),
      image: safeImage(c.image),
      tx: safePath(c.tx),
      rx: safePath(c.rx),
      spareId: typeof c.spareId === 'string' ? c.spareId : null,
      notes: typeof c.notes === 'string' ? c.notes.slice(0, 500) : '',
      rf: safeRf(c.rf),
      view: cleanView(c.view)
    });
  }
  for (const s of Array.isArray(raw.spares) ? raw.spares : []) {
    if (!s || typeof s.id !== 'string') continue;
    show.spares.push({
      id: s.id,
      name: cleanName(s.name, 'Spare'),
      image: safeImage(s.image),
      tx: safePath(s.tx),
      rx: safePath(s.rx),
      monitorMain: Boolean(s.monitorMain),
      rf: safeRf(s.rf),
      view: cleanView(s.view),
      inUseBy: typeof s.inUseBy === 'string' ? s.inUseBy : null
    });
  }
  // Drop dangling references.
  const chIds = new Set(show.channels.map((c) => c.id));
  const spIds = new Set(show.spares.map((s) => s.id));
  for (const c of show.channels) if (c.spareId && !spIds.has(c.spareId)) c.spareId = null;
  for (const s of show.spares) if (s.inUseBy && !chIds.has(s.inUseBy)) s.inUseBy = null;
  for (const item of [...show.channels, ...show.spares]) if (item.rf && !rxIds.has(item.rf.receiverId)) item.rf = null;
  return show;
}

module.exports = { ShowStore, ShowError, samePath, normalize, VIEWS };
