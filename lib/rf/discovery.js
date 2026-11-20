'use strict';

/**
 * Finding wireless receivers on the network.
 *
 *   - Shure Axient Digital units (AD4D, AD4Q, ANX4) answer an SLPv2 service
 *     request on 239.255.254.253:8427 with an AttrRply carrying their function
 *     tag (`AD4D_RX`, `AD4Q_RX`, `MCR_AD…` for an ANX4), their name and
 *     address. This follows the SoundBase Shure Axient Digital plugin's browser:
 *     one socket on 0.0.0.0:8427, multicast membership and solicits on each
 *     chosen interface, unicast solicits to known addresses, a solicit every
 *     5 s and a unit forgotten 30 s after it was last heard.
 *   - Sennheiser SSC servers advertise _ssc._udp (v1) / _ssc._tcp via mDNS.
 *
 * Shure discovery (a multicast on the network every 5 s) is off unless the
 * operator turns it on; Sennheiser mDNS browsing only listens and is always on.
 * `interfaces` is the list of local IPv4 addresses to browse on (null = every
 * interface), so receivers can live on a different network from Dante.
 * Results are advisory: the operator still adds the receiver by hand.
 */

const dgram = require('dgram');
const { EventEmitter } = require('events');
const mdns = require('../dante/mdns');
const { listInterfaces } = require('../dante/network');

const SLP_GROUP = '239.255.254.253';
const SLP_PORT = 8427;
const SSC_SERVICES = ['_ssc._udp.local', '_ssc._tcp.local'];
const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const SOLICIT_MS = 5000;
const EXPIRE_MS = 30000;

function parseAttributes(list) {
  const attrs = {};
  for (const [, key, value] of list.matchAll(/\(([^()=]+)=([^()]*)\)/g)) attrs[key.trim().toLowerCase()] = value.trim();
  return attrs;
}

/** `AD4D` for an `AD4D_RX` advert, `AD4Q`, `ANX4` for an `MCR_AD…` one, or null for anything else. */
function modelOf(fctn) {
  const s = String(fctn || '');
  const m = /^(ad4[qd])/i.exec(s);
  if (m) return m[1].toUpperCase();
  if (/^mcr/i.test(s)) return 'ANX4';
  return null;
}

/** SLPv2 AttrRply: version(1) function(1)=7 length(3) flags(2) next-ext(3) xid(2) lang-len(2) lang; error(2) attr-len(2) attrs. */
function parseAttrRply(buf) {
  if (buf.length < 16 || buf[0] !== 0x02 || buf[1] !== 0x07) return null;
  let offset = 14 + buf.readUInt16BE(12);
  if (offset + 4 > buf.length || buf.readUInt16BE(offset) !== 0) return null;
  const length = buf.readUInt16BE(offset + 2);
  offset += 4;
  const attrs = parseAttributes(buf.subarray(offset, offset + length).toString('utf8'));
  const endpoint = /esta\.sdt\/(\d+\.\d+\.\d+\.\d+):(\d+)/.exec(attrs['csl-esta.dmp'] || '');
  if (!endpoint) return null;
  return { fctn: attrs['acn-fctn'] || '', name: attrs['acn-uacn'] || '', ip: endpoint[1], port: Number(endpoint[2]) };
}

/** SLPv2 SrvRqst for service:esta.sdt, framed as the plugin sends it (empty scope list). */
function buildSrvRqst(xid = 0x1234, serviceType = 'service:esta.sdt') {
  const type = Buffer.from(serviceType, 'ascii');
  const lang = Buffer.from('en', 'ascii');
  const body = Buffer.concat([
    Buffer.alloc(2), // previous-responder list
    Buffer.from([type.length >> 8, type.length & 0xff]),
    type,
    Buffer.alloc(2), // scope list
    Buffer.alloc(2), // predicate
    Buffer.alloc(2) // SPI
  ]);
  const header = Buffer.concat([
    Buffer.from([0x02, 0x01, 0, 0, 0]),
    Buffer.from([0x20, 0x00]), // multicast
    Buffer.alloc(3),
    Buffer.from([xid >> 8, xid & 0xff]),
    Buffer.from([0x00, lang.length]),
    lang
  ]);
  const packet = Buffer.concat([header, body]);
  packet.writeUIntBE(packet.length, 2, 3);
  return packet;
}

const sameList = (a, b) => (a === null && b === null) || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]));

class ReceiverDiscovery extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string[]|null} [opts.interfaces] local IPv4 addresses to browse on; null = all
   * @param {boolean} [opts.shure] send SLP solicits (off by default)
   * @param {string[]} [opts.targets] addresses to solicit by unicast as well
   */
  constructor({ log, interfaces = null, shure = false, targets = [] } = {}) {
    super();
    this.log = log || console;
    this.interfaces = interfaces;
    this.shure = Boolean(shure);
    this.targets = targets;
    this.found = new Map(); // key -> { brand, name, model, ip, port, seen }
    this.slp = null;
    this.mdns = null;
    this.timer = null;
    this.started = false;
  }

  /** The local addresses the multicast goes out on and is listened for. */
  addresses() {
    if (this.interfaces) return this.interfaces;
    return listInterfaces().map((i) => i.address);
  }

  start() {
    this.started = true;
    if (this.shure) this.openSlp();
    this.openMdns();
    this.timer = setInterval(() => this.query(), SOLICIT_MS);
    this.timer.unref();
    this.query();
  }

  stop() {
    this.started = false;
    clearInterval(this.timer);
    this.timer = null;
    this.closeSocket('slp');
    this.closeSocket('mdns');
    this.found.clear();
  }

  closeSocket(name) {
    const sock = this[name];
    this[name] = null;
    try {
      if (sock) sock.close();
    } catch {
      // already closed
    }
  }

  /** Browse on different adapters; a running browse re-opens on the new ones. */
  setInterfaces(interfaces) {
    const next = Array.isArray(interfaces) ? [...interfaces] : null;
    if (sameList(this.interfaces, next)) return;
    this.interfaces = next;
    if (!this.started) return;
    this.closeSocket('slp');
    this.closeSocket('mdns');
    this.found.clear();
    if (this.shure) this.openSlp();
    this.openMdns();
    this.query();
  }

  /** Addresses to solicit directly (the Shure receivers the operator configured). */
  setTargets(targets) {
    this.targets = Array.isArray(targets) ? targets.filter((t) => /^\d+\.\d+\.\d+\.\d+$/.test(t)) : [];
  }

  /** Turn Shure (SLP) discovery on or off while running. Off also forgets the Shure units found. */
  setShureEnabled(on) {
    on = Boolean(on);
    if (on === this.shure) return;
    this.shure = on;
    if (!this.started) return;
    if (on) {
      this.openSlp();
      this.query();
    } else {
      this.closeSocket('slp');
      for (const [k, v] of this.found) if (v.brand === 'shure-ad') this.found.delete(k);
    }
  }

  openMulticast(name, port, group, onMessage) {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => this.log.debug(`[Discovery] ${name}: ${err.message}`));
    sock.on('message', (msg, rinfo) => {
      if (this[name] !== sock) return;
      try {
        onMessage(msg, rinfo);
      } catch (err) {
        this.log.debug(`[Discovery] ${name} packet from ${rinfo.address}: ${err.message}`);
      }
    });
    sock.bind({ port, address: '0.0.0.0' }, () => {
      if (this[name] !== sock) return;
      for (const address of this.addresses()) {
        try {
          sock.addMembership(group, address);
        } catch (err) {
          this.log.debug(`[Discovery] ${name} membership on ${address}: ${err.message}`);
        }
      }
    });
    this[name] = sock;
    return sock;
  }

  openSlp() {
    this.openMulticast('slp', SLP_PORT, SLP_GROUP, (msg, rinfo) => {
      const r = parseAttrRply(msg);
      if (!r) return;
      const model = modelOf(r.fctn);
      if (!model) return;
      this.add({ brand: 'shure-ad', name: r.name || model, model, ip: r.ip || rinfo.address, port: 2202 });
    });
  }

  openMdns() {
    this.openMulticast('mdns', MDNS_PORT, MDNS_GROUP, (msg, rinfo) => {
      for (const inst of mdns.parseServiceInstances(msg, SSC_SERVICES)) {
        const ip = inst.address || rinfo.address;
        const v2 = inst.service === '_ssc._tcp.local';
        this.add({ brand: v2 ? 'sennheiser-ewdx' : 'sennheiser-ewdx-v1', name: inst.name, model: (inst.txt && inst.txt.model) || 'SSC device', ip, port: v2 ? 443 : inst.port || 45 });
      }
    });
  }

  /** Send a multicast from each browsed interface, and to each target by unicast. */
  solicit(sock, packet, port, group) {
    for (const address of this.addresses()) {
      try {
        sock.setMulticastInterface(address);
        sock.send(packet, port, group, () => {});
      } catch {
        // skip an interface that will not send
      }
    }
  }

  query() {
    if (this.slp && this.shure) {
      const request = buildSrvRqst();
      this.solicit(this.slp, request, SLP_PORT, SLP_GROUP);
      for (const ip of this.targets) this.slp.send(request, SLP_PORT, ip, () => {});
    }
    if (this.mdns) this.solicit(this.mdns, mdns.buildQuery(SSC_SERVICES), MDNS_PORT, MDNS_GROUP);
    const now = Date.now();
    for (const [k, v] of this.found) {
      if (now - v.seen > EXPIRE_MS) {
        this.found.delete(k);
        this.emit('lost', v);
      }
    }
  }

  add(entry) {
    const key = `${entry.brand}|${entry.ip}`;
    const known = this.found.get(key);
    this.found.set(key, { ...entry, seen: Date.now() });
    if (!known) {
      this.log.info(`[Discovery] Found ${entry.model} "${entry.name}" at ${entry.ip}`);
      this.emit('found', entry);
    }
  }

  list() {
    return [...this.found.values()].map(({ seen, ...rest }) => rest);
  }
}

module.exports = { ReceiverDiscovery, parseAttrRply, buildSrvRqst, parseAttributes, modelOf, SLP_GROUP, SLP_PORT };
