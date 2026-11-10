'use strict';

/**
 * Finding wireless receivers on the network:
 *   - Shure ACN devices answer an SLPv2 service request on 239.255.254.253:8427
 *     with an AttrRply carrying their function tag (AD4Q_RX…), name and address.
 *   - Sennheiser SSC servers advertise _ssc._udp (v1) / _ssc._tcp via mDNS.
 * Results are advisory: the operator still adds the receiver by hand.
 */

const dgram = require('dgram');
const { EventEmitter } = require('events');
const mdns = require('../dante/mdns');

const SLP_GROUP = '239.255.254.253';
const SLP_PORT = 8427;
const SSC_SERVICES = ['_ssc._udp.local', '_ssc._tcp.local'];
const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;
const EXPIRE_MS = 90000;

function parseAttributes(list) {
  const attrs = {};
  for (const [, key, value] of list.matchAll(/\(([^()=]+)=([^()]*)\)/g)) attrs[key.trim().toLowerCase()] = value.trim();
  return attrs;
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
  return { fctn: attrs['acn-fctn'] || '', name: attrs['acn-uacn'] || '', ip: endpoint[1] };
}

/** SLPv2 SrvRqst for service:esta.sdt (what Shure controllers send). */
function buildSrvRqst(xid = 0x5a5a, serviceType = 'service:esta.sdt') {
  const lang = Buffer.from('en');
  const prList = Buffer.alloc(2);
  const svc = Buffer.from(serviceType);
  const scope = Buffer.from('DEFAULT');
  const body = Buffer.concat([
    prList,
    Buffer.from([svc.length >> 8, svc.length & 0xff]),
    svc,
    Buffer.from([scope.length >> 8, scope.length & 0xff]),
    scope,
    Buffer.alloc(2), // predicate
    Buffer.alloc(2) // SPI
  ]);
  const header = Buffer.alloc(14 + lang.length);
  header[0] = 2;
  header[1] = 1; // SrvRqst
  const total = header.length + body.length;
  header[2] = (total >> 16) & 0xff;
  header[3] = (total >> 8) & 0xff;
  header[4] = total & 0xff;
  header.writeUInt16BE(0x2000, 5); // multicast flag
  header.writeUInt16BE(xid, 10);
  header.writeUInt16BE(lang.length, 12);
  lang.copy(header, 14);
  return Buffer.concat([header, body]);
}

class ReceiverDiscovery extends EventEmitter {
  constructor({ log, boundIp = null } = {}) {
    super();
    this.log = log || console;
    this.boundIp = boundIp;
    this.found = new Map(); // key -> { brand, name, model, ip, port, seen }
    this.sockets = [];
    this.timer = null;
  }

  start() {
    this.openSlp();
    this.openMdns();
    this.timer = setInterval(() => this.query(), 10000);
    this.timer.unref();
    this.query();
  }

  stop() {
    clearInterval(this.timer);
    for (const s of this.sockets) {
      try {
        s.close();
      } catch {
        // ignore
      }
    }
    this.sockets = [];
  }

  openSlp() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => this.log.debug(`[Discovery] SLP: ${err.message}`));
    sock.on('message', (msg, rinfo) => {
      const r = parseAttrRply(msg);
      if (!r) return;
      const brand = /AD4|ANX|AXT|ULX/i.test(r.fctn) ? 'shure-ad' : null;
      if (!brand) return;
      this.add({ brand, name: r.name || r.fctn, model: r.fctn.replace(/_RX$/, ''), ip: r.ip || rinfo.address, port: 2202 });
    });
    sock.bind(SLP_PORT, () => {
      try {
        sock.addMembership(SLP_GROUP, this.boundIp || undefined);
      } catch (err) {
        this.log.debug(`[Discovery] SLP membership: ${err.message}`);
      }
    });
    this.slp = sock;
    this.sockets.push(sock);
  }

  openMdns() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => this.log.debug(`[Discovery] mDNS: ${err.message}`));
    sock.on('message', (msg, rinfo) => {
      let instances;
      try {
        instances = mdns.parseServiceInstances(msg, SSC_SERVICES);
      } catch {
        return;
      }
      for (const inst of instances) {
        const ip = inst.address || rinfo.address;
        const v2 = inst.service === '_ssc._tcp.local';
        this.add({ brand: v2 ? 'sennheiser-ewdx' : 'sennheiser-ewdx-v1', name: inst.name, model: (inst.txt && inst.txt.model) || 'SSC device', ip, port: v2 ? 443 : inst.port || 45 });
      }
    });
    sock.bind(MDNS_PORT, () => {
      try {
        sock.addMembership(MDNS_GROUP, this.boundIp || undefined);
      } catch (err) {
        this.log.debug(`[Discovery] mDNS membership: ${err.message}`);
      }
    });
    this.mdns = sock;
    this.sockets.push(sock);
  }

  query() {
    if (this.slp) this.slp.send(buildSrvRqst(), SLP_PORT, SLP_GROUP, () => {});
    if (this.mdns) this.mdns.send(mdns.buildQuery(SSC_SERVICES), MDNS_PORT, MDNS_GROUP, () => {});
    const now = Date.now();
    for (const [k, v] of this.found) if (now - v.seen > EXPIRE_MS) this.found.delete(k);
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

module.exports = { ReceiverDiscovery, parseAttrRply, buildSrvRqst, parseAttributes };
