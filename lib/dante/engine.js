'use strict';

/**
 * Dante discovery + metering engine.
 *
 * Discovers devices (mDNS, heartbeats, settings multicast, ARP probing), polls
 * them for names / channels / routing / clock status over ARC and the settings
 * protocol, subscribes to their metering streams, and exposes snapshots for
 * the web layer.
 */

const dgram = require('dgram');
const { EventEmitter } = require('events');

const {
  SERVICES,
  MULTICAST,
  PORTS,
  PROTOCOL,
  ARC_COMMANDS,
  ARC_RESULTS,
  SETTINGS_MESSAGES,
  RX_CONNECTED_STATUSES,
  PTP_PORT_LEADER,
  VALID_SAMPLE_RATES,
  TX_PAGE_SIZE,
  RX_PAGE_SIZE
} = require('./constants');
const packets = require('./packets');
const mdns = require('./mdns');
const network = require('./network');
const { IdentityResolver, applyQuirks } = require('./identity');
const { byteToDbfs } = require('../../public/levels');

const TIMING = {
  DISCOVERY_INTERVAL: 3000,
  SUBSCRIPTION_INTERVAL: 2500,
  OFFLINE_AFTER: 7000,
  REMOVE_AFTER: 60000,
  METER_STALE_AFTER: 1500,
  ARP_REPROBE_AFTER: 30000,
  // Devices answer clock and interface queries by MULTICAST, so every computer
  // on the Dante network (each Dante Controller included) receives every answer
  // to every question we ask. Ask rarely, and one question at a time.
  CLOCK_POLL_INTERVAL: 15000,
  INTERFACE_POLL_INTERVAL: 60000,
  SETTINGS_PROBE_INTERVAL: 3000, // while finding which form of a query a device answers
  SETTINGS_PROBE_SLOW_INTERVAL: 30000, // once every form has been tried twice without an answer
  SETTINGS_REPLY_WINDOW: 2500,
  // mDNS questions make every device multicast its records again.
  // Device Info tab: link speed per port, and identity (which never changes
  // while a device is up, so it is asked once and then only now and again).
  PORT_STATS_POLL_INTERVAL: 30000,
  IDENTITY_POLL_INTERVAL: 600000,
  MDNS_FAST_QUERIES: 5,
  MDNS_QUERY_INTERVAL: 30000
};

// Dante device names: letters, digits and hyphens (a little looser to be safe).
const MAX_INVENTORY_PAGES = 64;
const MAX_DEPARTED = 500;
const PTP_PORT_RECEIVING = new Set([7, 9]); // passive, follower
const interfaceSignature = (interfaces) => interfaces.map((i) => `${i.name}=${i.address}`).sort().join(',');
const DEVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.\- ]{0,62}$/;
const LINK_LOCAL = { address: '169.254.0.0', netmask: '255.255.0.0' };

const noopLog = { debug() {}, info() {}, warn() {}, error() {} };

/** PTP state of a device's network port (0 = primary, 1 = secondary), or null. */
function portState(dev, index) {
  const states = dev.clock && dev.clock.portStates;
  return states && states.length > index ? states[index] : null;
}

class DanteEngine extends EventEmitter {
  constructor({ nic = null, log = noopLog, identity = new IdentityResolver() } = {}) {
    super();
    this.log = log;
    this.identity = identity;
    this.requestedNic = nic;

    this.devices = new Map(); // ip -> device record
    this.sockets = {};
    this.timers = [];
    this.iface = null;
    this.boundMac = Buffer.alloc(6);

    this.seq = 1;
    this.meteringPort = null; // actual UDP port devices stream meters to
    this.arpProbes = new Map(); // ip -> last probe time
    this.arpBusy = false;
    this.localAddresses = new Set();
    this.mdnsLookups = new Map(); // instance -> last direct lookup time
    this.departed = new Map(); // lower-case name -> { name, ip, lastSeen } for devices removed while offline
    this.resetStats();
  }

  /** Network-wide packet counters, used to spot traffic that isn't arriving (e.g. a firewall). */
  resetStats() {
    this.stats = {
      boundAt: Date.now(),
      firstDeviceAt: null,
      heartbeats: 0,
      lastHeartbeatAt: null,
      meteringFrames: 0,
      lastMeteringAt: null,
      firstMeteringRequestAt: null
    };
  }

  count(dev, kind) {
    dev.counters[kind] = (dev.counters[kind] || 0) + 1;
  }

  get boundIp() {
    return this.iface ? this.iface.address : null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start() {
    const interfaces = network.listInterfaces();
    this.log.info('[Dante] Interfaces:', interfaces.map((i) => `${i.name} ${i.address}`).join(', ') || 'none');

    let iface = null;
    if (this.requestedNic) {
      iface = interfaces.find((i) => i.address === this.requestedNic || i.name === this.requestedNic) || null;
      if (!iface) {
        this.log.warn(`[Dante] Requested NIC "${this.requestedNic}" not found yet; auto-selecting and switching when it appears.`);
        this.waitingFor = { name: this.requestedNic, address: this.requestedNic };
      }
    }
    this.autoSelected = !iface;
    this.bind(iface || network.pickDefaultInterface(interfaces));

    this.timers.push(setInterval(() => this.discoveryTick(), TIMING.DISCOVERY_INTERVAL));
    this.timers.push(setInterval(() => this.subscriptionTick(), TIMING.SUBSCRIPTION_INTERVAL));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.stopAllMetering();
    this.closeSockets();
  }

  /** Switch to the interface with the given IPv4 address ('all' = wildcard). */
  selectInterface(address) {
    const iface = address && address !== 'all' ? network.listInterfaces().find((i) => i.address === address) : null;
    // An explicit choice from the UI: stop any automatic switching.
    this.autoSelected = false;
    this.waitingFor = null;
    this.bind(iface || null);
    return this.interfaceInfo();
  }

  interfaceInfo() {
    return { boundIp: this.boundIp, name: this.iface ? this.iface.name : 'All Interfaces' };
  }

  bind(iface) {
    this.stopAllMetering();
    this.closeSockets();
    this.devices.clear();
    this.arpProbes.clear();
    this.mdnsLookups.clear();
    this.departed.clear();
    this.resetStats();
    this.iface = iface;
    const interfaces = network.listInterfaces();
    this.localAddresses = new Set(interfaces.map((i) => i.address));
    this.interfaceSignature = interfaceSignature(interfaces);
    this.boundMac = iface ? network.macToBuffer(network.hardwareMac(iface)) : Buffer.alloc(6);

    if (iface) this.log.info(`[Dante] Bound to ${iface.name} (${iface.address})`);
    else this.log.warn('[Dante] No specific interface selected; listening on all interfaces.');

    this.openSockets();
    this.sendMdnsQueries({ force: true });
    this.probeArp();
    this.emit('interface', this.interfaceInfo());
  }

  // -------------------------------------------------------------------------
  // Sockets
  // -------------------------------------------------------------------------

  openSockets() {
    const local = this.boundIp || undefined;
    this.openSocket('ARC', { address: local, onMessage: (m, r) => this.handleArc(m, r) });
    this.openSocket('CMC', { address: local, onMessage: (m, r) => this.handleCmc(m, r) });
    this.openSocket('SETTINGS', {
      port: PORTS.INFO,
      group: MULTICAST.INFO,
      onMessage: (m, r) => this.handleSettings(m, r)
    });
    this.openSocket('HEARTBEAT', {
      port: PORTS.HEARTBEAT,
      group: MULTICAST.HEARTBEAT,
      onMessage: (m, r) => this.handleHeartbeat(m, r)
    });
    // Exclusive so a Dante Controller on this machine can't steal our stream
    // (and vice versa); if 8751 is taken, any free port works — devices send
    // to whatever port we put in the subscription request.
    this.meteringPort = null;
    this.openSocket('METERING', {
      port: PORTS.METERING,
      address: local,
      exclusive: true,
      fallbackToEphemeral: true,
      onMessage: (m, r) => this.handleMetering(m, r),
      onListening: (s) => {
        this.meteringPort = s.address().port;
        this.log.info(`[Dante] Metering listener on ${s.address().address}:${this.meteringPort}`);
        for (const ip of this.devices.keys()) this.startMetering(ip);
      }
    });
    // 5353 is usually held by the OS responder; fall back to an ephemeral port
    // (replies then arrive as legacy unicast).
    this.openSocket('MDNS', {
      port: PORTS.MDNS,
      group: MULTICAST.MDNS,
      multicastInterface: true,
      fallbackToEphemeral: true,
      onMessage: (m, r) => this.handleMdns(m, r)
    });
  }

  openSocket(name, opts) {
    const { port = 0, address, group, multicastInterface, fallbackToEphemeral, exclusive, onMessage, onListening } = opts;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: !exclusive });

    sock.on('message', (msg, rinfo) => {
      // A replaced socket stays open briefly so queued sends go out; packets it
      // still receives belong to the old network and must not be registered.
      if (this.sockets[name] !== sock) return;
      try {
        onMessage(msg, rinfo);
      } catch (err) {
        this.log.debug(`[${name}] Ignoring malformed packet from ${rinfo.address}: ${err.message}`);
      }
    });

    sock.on('error', (err) => {
      if (this.sockets[name] !== sock) return;
      if (fallbackToEphemeral && port !== 0) {
        this.log.info(`[${name}] Port ${port} is in use (${err.code}); using a free port instead.`);
        sock.close();
        this.openSocket(name, { ...opts, port: 0, fallbackToEphemeral: false });
        return;
      }
      this.log.warn(`[${name}] Socket error: ${err.message}`);
    });

    sock.on('listening', () => {
      if (group) {
        try {
          sock.addMembership(group, this.boundIp || undefined);
        } catch (err) {
          this.log.warn(`[${name}] Could not join ${group}: ${err.message}`);
        }
      }
      if (multicastInterface && this.boundIp) {
        try {
          sock.setMulticastInterface(this.boundIp);
        } catch (err) {
          this.log.debug(`[${name}] setMulticastInterface failed: ${err.message}`);
        }
      }
      if (onListening) onListening(sock);
    });

    this.sockets[name] = sock;
    sock.bind({ port, address });
    return sock;
  }

  /** Close sockets after a short grace period so queued sends (unsubscribes) go out. */
  closeSockets(graceMs = 250) {
    const socks = Object.values(this.sockets);
    this.sockets = {};
    const close = () => {
      for (const sock of socks) {
        try {
          sock.close();
        } catch {
          // already closed
        }
      }
    };
    if (graceMs > 0) setTimeout(close, graceMs).unref();
    else close();
  }

  send(socketName, buf, port, host) {
    const sock = this.sockets[socketName];
    if (!sock || !port || !host) return;
    try {
      sock.send(buf, port, host, (err) => {
        if (err) this.log.debug(`[${socketName}] send to ${host}:${port} failed: ${err.message}`);
      });
    } catch (err) {
      this.log.debug(`[${socketName}] send failed: ${err.message}`);
    }
  }

  nextSeq() {
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xffff;
    return seq;
  }

  // -------------------------------------------------------------------------
  // Outgoing queries
  // -------------------------------------------------------------------------

  /**
   * Where and how to send ARC queries to a device. Once it has answered, use the
   * protocol ID and port it answered with. Until then, successive polls cycle
   * through protocol 0x2729 / 0x27FF and, unless mDNS told us the port, ports
   * 4440 / 4455: some devices (e.g. Dante Virtual Soundcard) only respond to
   * one combination.
   */
  arcTargetFor(dev) {
    if (!dev) return { protocolId: PROTOCOL.ARC, port: PORTS.ARC };
    const modern = this.modernArcProtocol(dev);
    if (modern && (dev.arcProtocol || dev.arcPortAdvertised)) return { protocolId: modern, port: dev.ports.ARC || PORTS.ARC };
    if (dev.arcProtocol && !packets.isModernArc(dev.arcProtocol)) return { protocolId: dev.arcProtocol, port: dev.ports.ARC || PORTS.ARC };
    const protocols = modern
      ? [modern]
      : dev.modernRejected || dev.arcAdvertised
        ? [PROTOCOL.ARC, PROTOCOL.ARC_DEFAULT]
        : [PROTOCOL.ARC, PROTOCOL.ARC_DEFAULT, PROTOCOL.ARC_MODERN];
    const ports = dev.arcPortAdvertised ? [dev.ports.ARC] : [PORTS.ARC, PORTS.ARC_ALTERNATE];
    const n = dev.pollCount % (protocols.length * ports.length);
    return { protocolId: protocols[n % protocols.length], port: ports[Math.floor(n / protocols.length)] };
  }

  /**
   * The modern ARC protocol (0x2809 / 0x280C / 0x280F) a device speaks, from its
   * mDNS `arcp_vers` or from its replies; null for devices using the older
   * protocols. Modern devices list channels with the paged 0x2400 / 0x3400
   * inventory and expect netaudio's exact packet framing.
   */
  modernArcProtocol(dev) {
    if (!dev) return null;
    if (packets.isModernArc(dev.arcAdvertised)) return dev.arcAdvertised;
    // Advertising an older protocol, or rejecting the modern inventory, wins
    // over having answered a modern-ID probe.
    if (dev.arcAdvertised || dev.modernRejected) return null;
    if (packets.isModernArc(dev.arcProtocol)) return dev.arcProtocol;
    return null;
  }

  sendArc(ip, commandType, args) {
    const dev = this.devices.get(ip);
    const { protocolId, port } = this.arcTargetFor(dev);
    if (packets.isModernArc(protocolId)) {
      // Basic queries use netaudio's framing with no padding.
      this.send('ARC', packets.arcRequest(this.nextSeq(), commandType, undefined, protocolId), port, ip);
      return;
    }
    this.send('ARC', packets.arcCommand(this.nextSeq(), commandType, args, protocolId), port, ip);
  }

  /** Request one page of the modern channel inventory. */
  sendChannelStatusQuery(dev, rx, mediaSelector = 1, start = 1) {
    const { protocolId, port } = this.arcTargetFor(dev);
    if (!packets.isModernArc(protocolId)) return;
    this.send('ARC', packets.channelStatusQuery(this.nextSeq(), { protocolId, rx, mediaSelector, start }), port, dev.ip);
  }

  /** Start a fresh paged inventory of a modern device's Tx or Rx channels. */
  queryChannelInventory(dev, rx) {
    const key = rx ? 'rx' : 'tx';
    dev.inventory = dev.inventory || {};
    dev.inventory[key] = { seen: new Map(), pages: 0 };
    this.sendChannelStatusQuery(dev, rx);
  }

  settingsPortFor(ip) {
    const dev = this.devices.get(ip);
    return (dev && dev.ports.SETTINGS) || PORTS.SETTINGS;
  }

  queryName(ip) {
    const dev = this.devices.get(ip);
    if (this.modernArcProtocol(dev)) {
      // Modern devices answer the name query only with the default protocol ID
      // (they reject it with 0x2809: result 0x30), as netaudio sends it.
      const { port } = this.arcTargetFor(dev);
      this.send('ARC', packets.arcRequest(this.nextSeq(), ARC_COMMANDS.DEVICE_NAME, undefined, PROTOCOL.ARC_DEFAULT), port, ip);
      return;
    }
    this.sendArc(ip, ARC_COMMANDS.DEVICE_NAME);
  }

  queryChannelCounts(ip) {
    // Modern devices: the channel inventory gives the counts.
    if (this.modernArcProtocol(this.devices.get(ip))) return;
    this.sendArc(ip, ARC_COMMANDS.CHANNEL_COUNTS);
  }

  queryDeviceSettings(ip) {
    // Modern devices report the sample rate per channel in the inventory
    // instead; ask them for the latency setting alone, and not on every poll.
    const dev = this.devices.get(ip);
    if (this.modernArcProtocol(dev)) {
      const now = Date.now();
      if (now - (dev.latencyAskedAt || 0) < TIMING.PORT_STATS_POLL_INTERVAL) return;
      dev.latencyAskedAt = now;
      const { protocolId, port } = this.arcTargetFor(dev);
      this.send('ARC', packets.arcCommand(this.nextSeq(), ARC_COMMANDS.DEVICE_SETTINGS, packets.latencySettingsArgs(), protocolId), port, ip);
      return;
    }
    this.sendArc(ip, ARC_COMMANDS.DEVICE_SETTINGS);
  }

  queryTxNames(ip) {
    const dev = this.devices.get(ip);
    if (this.modernArcProtocol(dev)) return this.queryChannelInventory(dev, false);
    const pages = packets.pageCount((dev && dev.tx.count) || 16, TX_PAGE_SIZE);
    for (let page = 0; page < pages; page++) {
      this.sendArc(ip, ARC_COMMANDS.TX_FRIENDLY_NAMES, packets.txNamesArgs(page));
      this.sendArc(ip, ARC_COMMANDS.TX_CHANNELS, packets.txChannelsArgs(page));
    }
  }

  queryRxChannels(ip) {
    const dev = this.devices.get(ip);
    if (this.modernArcProtocol(dev)) return this.queryChannelInventory(dev, true);
    const count = (dev && dev.rx.count) || 16;
    const pages = packets.pageCount(count, RX_PAGE_SIZE);
    for (let page = 0; page < pages; page++) {
      this.sendArc(ip, ARC_COMMANDS.RX_CHANNELS, packets.rxChannelsArgs(page, count));
    }
  }

  /** CMC ports to use: the advertised/answering one, else the standard and DVS ports. */
  cmcPortsFor(dev) {
    if (dev && (dev.cmcPortAdvertised || dev.cmcPortConfirmed)) return [dev.ports.CMC];
    return [PORTS.CMC, PORTS.CMC_DVS];
  }

  sendCmc(ip, pkt) {
    for (const port of this.cmcPortsFor(this.devices.get(ip))) this.send('CMC', pkt, port, ip);
  }

  querySettingsPort(ip) {
    this.sendCmc(ip, packets.cmcSettingsPortQuery(this.nextSeq(), this.boundMac));
  }

  queryClocking(ip) {
    // Two forms: the plain status request, and the clock-control query that
    // netaudio uses (answered by more devices). Both are read-only.
    this.settingsPoll(ip, 'clock', [packets.clockingQuery, packets.clockRefreshQuery], TIMING.CLOCK_POLL_INTERVAL);
  }

  queryInterfaces(ip) {
    this.settingsPoll(ip, 'interfaces', [packets.interfaceStatusQuery, packets.interfaceControlQuery], TIMING.INTERFACE_POLL_INTERVAL);
  }

  /** Manufacturer / Dante module identity and per-port link speed, for the Device Info tab. */
  queryDeviceInfo(ip) {
    const dev = this.devices.get(ip);
    if (!dev) return;
    this.settingsPoll(ip, 'makeModel', [packets.makeModelQuery], TIMING.IDENTITY_POLL_INTERVAL);
    this.settingsPoll(ip, 'danteModel', [packets.danteModelQuery], TIMING.IDENTITY_POLL_INTERVAL);
    this.settingsPoll(ip, 'portStats', [packets.interfaceStatsQuery], TIMING.PORT_STATS_POLL_INTERVAL);
    this.settingsPoll(ip, 'aes67', [packets.aes67Query], TIMING.INTERFACE_POLL_INTERVAL);
    // Most two-port devices state Redundant / Switched in their interface
    // status; ask the switch configuration only of those that do not.
    if (dev.numInterfaces >= 2 && !dev.redundancy) {
      this.settingsPoll(ip, 'switch', [packets.switchConfigQuery], TIMING.INTERFACE_POLL_INTERVAL);
    }
  }

  /**
   * Send at most one settings query of this kind, when one is due.
   *
   * A device answers these by multicast to the whole network, so they are kept
   * to a minimum: the forms (status / control) and ports (the device's settings
   * port / 8702) are tried one at a time until the device answers one, and from
   * then on only that one is sent, every `interval`. Devices also multicast
   * these records by themselves when something changes.
   */
  settingsPoll(ip, kind, builders, interval, now = Date.now()) {
    const dev = this.devices.get(ip);
    if (!dev) return;
    dev.settingsPolls = dev.settingsPolls || {};
    const st = dev.settingsPolls[kind] || (dev.settingsPolls[kind] = { locked: null, tries: 0, misses: 0, pending: null, nextAt: 0 });
    if (now < st.nextAt) return;
    st.interval = interval;

    const ports = [...new Set([this.settingsPortFor(ip), PORTS.INFO])];
    const combos = [];
    for (const build of builders) for (const port of ports) combos.push({ build, port });

    if (st.locked !== null && st.pending) {
      // The form that used to work went unanswered: after three, look again.
      if (++st.misses >= 3) Object.assign(st, { locked: null, tries: 0, misses: 0 });
    }
    let index;
    if (st.locked !== null && st.locked < combos.length) {
      index = st.locked;
      st.nextAt = now + interval;
    } else {
      index = st.tries++ % combos.length;
      st.nextAt = now + (st.tries <= combos.length * 2 ? TIMING.SETTINGS_PROBE_INTERVAL : TIMING.SETTINGS_PROBE_SLOW_INTERVAL);
    }
    st.pending = { index, at: now };
    const { build, port } = combos[index];
    this.send('SETTINGS', build(this.nextSeq(), this.boundMac), port, ip);
  }

  /** A device answered a settings query: remember which form it was. */
  settingsAnswered(dev, kind, now = Date.now()) {
    const st = dev.settingsPolls && dev.settingsPolls[kind];
    if (!st || !st.pending) return;
    if (now - st.pending.at <= TIMING.SETTINGS_REPLY_WINDOW) {
      st.locked = st.pending.index;
      st.misses = 0;
      st.nextAt = Math.max(st.nextAt, st.pending.at + (st.interval || TIMING.INTERFACE_POLL_INTERVAL));
    }
    st.pending = null;
  }

  /** Local address/MAC a device should stream meters to. */
  subscriberFor(ip) {
    if (this.iface) return { address: this.iface.address, mac: this.boundMac };
    const iface = network.listInterfaces().find((i) => network.sameSubnet(ip, i.address, i.netmask));
    return iface ? { address: iface.address, mac: network.macToBuffer(iface.mac) } : null;
  }

  /** (Re)send the metering subscription; devices expect periodic refreshes. */
  startMetering(ip) {
    const dev = this.devices.get(ip);
    const subscriber = this.subscriberFor(ip);
    if (!dev || !dev.hasName || !this.meteringPort || !subscriber) return;
    const pkt = packets.cmcMeteringRequest(this.nextSeq(), {
      deviceName: dev.name,
      subscriberIp: subscriber.address,
      mac: subscriber.mac,
      port: this.meteringPort
    });
    this.sendCmc(ip, pkt);
    dev.meteringSubscribed = true;
    if (this.stats.firstMeteringRequestAt === null) this.stats.firstMeteringRequestAt = Date.now();
  }

  stopMetering(ip) {
    const dev = this.devices.get(ip);
    const subscriber = this.subscriberFor(ip);
    if (!dev || !dev.meteringSubscribed || !this.meteringPort || !subscriber) return;
    const pkt = packets.cmcMeteringStop(this.nextSeq(), { deviceName: dev.name, mac: subscriber.mac, port: this.meteringPort });
    this.sendCmc(ip, pkt);
    dev.meteringSubscribed = false;
  }

  /** Tell devices to stop streaming to us (shutdown / interface change). */
  stopAllMetering() {
    for (const ip of this.devices.keys()) this.stopMetering(ip);
  }

  /**
   * One round of questions for a device.
   *
   * Small devices (two-channel adapters, for one) answer only about four
   * requests arriving together and silently drop the rest. So what changes most
   * and matters most, the receive subscriptions, is asked first on every round,
   * and the things that rarely change (name, channel counts, sample rate and
   * latency, transmit labels) take turns, two per round. A new device, and a
   * Refresh, ask for everything at once.
   */
  pollDevice(ip, { everything = false } = {}) {
    const dev = this.devices.get(ip);
    if (!dev) return;
    dev.pollCount++;
    this.queryRxChannels(ip);
    const slow = [() => this.queryName(ip), () => this.queryChannelCounts(ip), () => this.queryDeviceSettings(ip), () => this.queryTxNames(ip)];
    if (everything || dev.pollCount <= 2 || !dev.hasName) {
      for (const ask of slow) ask();
    } else {
      const turn = (dev.pollCount * 2) % slow.length;
      slow[turn]();
      slow[turn + 1]();
    }
    this.queryClocking(ip);
    this.queryInterfaces(ip);
    this.queryDeviceInfo(ip);
  }

  /**
   * Ask for Dante services over mDNS. Every question makes every device
   * multicast its records again, so after the first few (to find everything
   * quickly) this only goes out every MDNS_QUERY_INTERVAL; devices announce
   * themselves anyway, and heartbeats show they are still there.
   */
  sendMdnsQueries({ force = false, now = Date.now() } = {}) {
    if (force) this.mdnsQueryCount = 0;
    if (this.mdnsQueryCount >= TIMING.MDNS_FAST_QUERIES && now - this.lastMdnsQueryAt < TIMING.MDNS_QUERY_INTERVAL) return;
    this.mdnsQueryCount = (this.mdnsQueryCount || 0) + 1;
    this.lastMdnsQueryAt = now;
    for (const service of Object.values(SERVICES)) {
      this.send('MDNS', mdns.buildQuery([service]), PORTS.MDNS, MULTICAST.MDNS);
    }
  }

  // -------------------------------------------------------------------------
  // Periodic work
  // -------------------------------------------------------------------------

  /**
   * The interface to switch to on this tick, if any: the adapter we lost (or
   * that was requested with --nic) once it has an IPv4 address again, or — when
   * the current interface was picked automatically and isn't link-local — a
   * Dante link-local interface that has since appeared.
   */
  interfaceToReturnTo(interfaces) {
    const current = this.iface;
    if (this.waitingFor) {
      const match =
        interfaces.find((i) => i.name === this.waitingFor.name && i.isDanteLinkLocal) ||
        interfaces.find((i) => i.name === this.waitingFor.name || i.address === this.waitingFor.address);
      if (match && !(current && current.address === match.address)) return match;
      if (match) this.waitingFor = null;
    }
    if (this.autoSelected && !(current && current.isDanteLinkLocal)) {
      const best = network.pickDefaultInterface(interfaces);
      if (best && best.isDanteLinkLocal) return best;
      // Started (or left) with no network at all: take the first one that comes
      // up, whatever its addressing, rather than staying bound to nothing.
      if (best && !current) return best;
    }
    return null;
  }

  discoveryTick() {
    const interfaces = network.listInterfaces();
    this.localAddresses = new Set(interfaces.map((i) => i.address));
    const signature = interfaceSignature(interfaces);
    if (this.interfaceSignature !== undefined && signature !== this.interfaceSignature) this.emit('interfaces-changed', interfaces);
    this.interfaceSignature = signature;
    if (this.iface) {
      if (!interfaces.some((i) => i.address === this.boundIp)) {
        this.log.warn(`[Dante] Interface ${this.iface.name} (${this.boundIp}) disappeared; re-binding until it returns.`);
        this.emit('interface-lost', this.boundIp);
        // Come back to this adapter when it has an address again (a link-local
        // address may come back different after a cable pull).
        this.waitingFor = { name: this.iface.name, address: this.boundIp, wasAuto: this.autoSelected };
        this.autoSelected = true;
        this.bind(network.pickDefaultInterface(interfaces));
        return;
      }
    }

    const back = this.interfaceToReturnTo(interfaces);
    if (back) {
      this.log.info(`[Dante] Interface ${back.name} (${back.address}) is available again; switching back.`);
      this.emit('interface-restored', back);
      // Back on an interface the user chose: stop looking for a better one.
      const w = this.waitingFor;
      if (w && w.wasAuto === false && (back.name === w.name || back.address === w.address)) this.autoSelected = false;
      this.waitingFor = null;
      this.bind(back);
      return;
    }

    const now = Date.now();
    for (const [ip, dev] of this.devices) {
      if (now - dev.lastSeen > TIMING.REMOVE_AFTER) {
        this.log.info(`[Dante] Removed device that has been offline for a while: ${dev.name} (${ip})`);
        this.devices.delete(ip);
        // Still reported as offline by getNetworkStatus() until it returns.
        if (dev.hasName) {
          this.departed.delete(dev.name.toLowerCase());
          this.departed.set(dev.name.toLowerCase(), { name: dev.name, ip, lastSeen: dev.lastSeen });
          if (this.departed.size > MAX_DEPARTED) this.departed.delete(this.departed.keys().next().value);
        }
      } else if (dev.hasName && !this.isOnline(dev, now)) {
        // Offline at this address but online under the same name at another: it changed IP.
        const live = this.deviceByName(dev.name, dev);
        if (live && this.isOnline(live, now)) this.devices.delete(ip);
      }
    }

    this.sendMdnsQueries();
    this.probeArp();
    for (const ip of this.devices.keys()) this.pollDevice(ip);
  }

  subscriptionTick() {
    const now = Date.now();
    for (const [ip, dev] of this.devices) {
      if (now - dev.lastSeen <= TIMING.OFFLINE_AFTER) this.startMetering(ip);
    }
  }

  async probeArp() {
    if (this.arpBusy) return;
    this.arpBusy = true;
    try {
      const subnet = this.iface || LINK_LOCAL;
      const ips = await network.readArpTable();
      const now = Date.now();
      for (const ip of ips) {
        if (ip === this.boundIp || ip.endsWith('.255') || this.devices.has(ip)) continue;
        if (!network.sameSubnet(ip, subnet.address, subnet.netmask)) continue;
        const last = this.arpProbes.get(ip);
        if (last && now - last < TIMING.ARP_REPROBE_AFTER) continue;
        // Only registered once the host answers on ARC.
        this.arpProbes.set(ip, now);
        for (const port of [PORTS.ARC, PORTS.ARC_ALTERNATE]) {
          for (const protocolId of [PROTOCOL.ARC, PROTOCOL.ARC_DEFAULT]) {
            this.send('ARC', packets.arcCommand(this.nextSeq(), ARC_COMMANDS.DEVICE_NAME, undefined, protocolId), port, ip);
          }
          for (const protocolId of [PROTOCOL.ARC_DEFAULT, PROTOCOL.ARC_MODERN]) {
            this.send('ARC', packets.arcRequest(this.nextSeq(), ARC_COMMANDS.DEVICE_NAME, undefined, protocolId), port, ip);
          }
        }
      }
    } catch (err) {
      this.log.debug(`[ARP] ${err.message}`);
    } finally {
      this.arpBusy = false;
    }
  }

  /** Drop offline devices immediately and re-poll everything. */
  refresh() {
    const now = Date.now();
    for (const [ip, dev] of this.devices) {
      if (now - dev.lastSeen > TIMING.OFFLINE_AFTER) this.devices.delete(ip);
    }
    this.departed.clear(); // Refresh means "forget what isn't there"
    this.arpProbes.clear();
    this.mdnsLookups.clear();
    this.departed.clear();
    this.sendMdnsQueries({ force: true });
    this.probeArp();
    for (const ip of this.devices.keys()) {
      this.pollDevice(ip, { everything: true });
      this.querySettingsPort(ip);
      this.startMetering(ip);
    }
  }

  // -------------------------------------------------------------------------
  // Device records
  // -------------------------------------------------------------------------

  register(ip, name) {
    let dev = this.devices.get(ip);
    const now = Date.now();
    if (!dev) {
      dev = {
        ip,
        name: ip,
        hasName: false,
        ports: { ARC: PORTS.ARC, CMC: PORTS.CMC, SETTINGS: PORTS.SETTINGS },
        mac: null,
        mdnsMf: null,
        mdnsModel: null,
        manufacturer: null,
        modelName: null,
        productVersion: null,
        softwareVersion: null,
        firmwareVersion: null,
        sampleRate: null,
        tx: { count: 0, channels: {} },
        rx: { count: 0, channels: {} },
        meters: { tx: {}, rx: {} },
        clock: null,
        numPorts: null,
        numInterfaces: null,
        secondaryLinkUp: null,
        arcProtocol: null,
        arcAdvertised: null,
        arcpVers: null,
        lastArcError: null,
        inventory: null,
        pollCount: 0,
        counters: {},
        secondaryIp: null,
        firstSeen: now,
        onlineSince: now,
        lastSeen: now
      };
      this.devices.set(ip, dev);
      if (name) this.setName(dev, name, 'mdns', { quiet: true });
      if (this.stats.firstDeviceAt === null) this.stats.firstDeviceAt = Date.now();
      this.log.info(`[Dante] Discovered ${dev.name} (${ip})`);
      this.identity.resolve(dev);
      this.pollDevice(ip);
      this.querySettingsPort(ip);
      this.startMetering(ip);
    } else {
      if (now - dev.lastSeen > TIMING.OFFLINE_AFTER) {
        this.log.info(`[Dante] ${dev.name} (${ip}) is back online`);
        dev.onlineSince = now;
      }
      dev.lastSeen = now;
      if (name) this.setName(dev, name, 'mdns');
    }
    return dev;
  }

  /**
   * Name a device. Its own ARC reply is authoritative; an mDNS name is only
   * used until the device answers, and never if another device already holds
   * that name (relayed mDNS answers can otherwise put names on the wrong IP).
   */
  setName(dev, name, source = 'arc', { quiet = false } = {}) {
    if (!name || !DEVICE_NAME_RE.test(name)) return;
    if (source === 'mdns' && dev.nameSource === 'arc') return;
    const holder = this.deviceByName(name, dev);
    if (holder) {
      if (!this.isOnline(holder)) {
        // The same device at its old address (it changed IP): drop the dead record
        // rather than let it shadow the live one until it times out.
        this.log.info(`[Dante] ${name} moved from ${holder.ip} to ${dev.ip}`);
        this.stopMetering(holder.ip);
        this.devices.delete(holder.ip);
      } else if (source === 'mdns') {
        return;
      }
    }
    dev.nameSource = source;
    if (dev.hasName && dev.name === name) return;
    const previous = dev.hasName ? dev.name : null;
    if (previous) this.stopMetering(dev.ip);
    dev.name = name;
    dev.hasName = true;
    this.departed.delete(name.toLowerCase());
    if (previous && !quiet) this.log.info(`[Dante] ${dev.ip} renamed: ${previous} -> ${name} (from ${source === 'arc' ? 'the device' : 'mDNS'})`);
    this.identity.resolve(dev);
    if (this.devices.has(dev.ip)) this.startMetering(dev.ip);
  }

  /** The device holding this name (optionally other than `except`); an online one is preferred. */
  deviceByName(name, except = null) {
    const wanted = String(name).toLowerCase();
    let offline = null;
    for (const dev of this.devices.values()) {
      if (dev === except || !dev.hasName || dev.name.toLowerCase() !== wanted) continue;
      if (this.isOnline(dev)) return dev;
      offline = offline || dev;
    }
    return offline;
  }

  setChannelCount(dev, dir, count) {
    const block = dev[dir];
    const prefix = dir === 'tx' ? 'Tx' : 'Rx';
    const changed = block.count !== count;
    block.count = count;
    for (const key of Object.keys(block.channels)) {
      if (Number(key) > count) delete block.channels[key];
    }
    for (let i = 1; i <= count; i++) {
      if (!block.channels[i]) block.channels[i] = { number: i, name: `${prefix} ${i}` };
    }
    return changed;
  }

  txEntry(dev, number) {
    return dev.tx.channels[number] || (dev.tx.channels[number] = { number, name: `Tx ${number}`, friendlyName: null, canonicalName: null });
  }

  recordLevels(dev, dir, firstChannel, bytes, now) {
    const block = dev[dir];
    const meters = dev.meters[dir];
    for (let i = 0; i < bytes.length; i++) {
      const ch = firstChannel + i;
      if (block.count && ch > block.count) break;
      meters[ch] = { peak: bytes[i], at: now };
    }
  }

  // -------------------------------------------------------------------------
  // Incoming packets
  // -------------------------------------------------------------------------

  handleArc(msg, rinfo) {
    const reply = packets.parseArcReply(msg);
    if (!reply) return;
    const dev = this.register(rinfo.address);
    dev.lastArcReplyAt = Date.now();
    // A modern device may also answer basic queries sent with the default ID;
    // keep treating it as modern.
    // A device that is not modern may still answer a modern-ID probe; don't
    // adopt that ID for it.
    const keep = packets.isModernArc(dev.arcProtocol) && !packets.isModernArc(reply.protocolId) && this.modernArcProtocol(dev);
    const adopt = !packets.isModernArc(reply.protocolId) || this.modernArcProtocol(dev) || (!dev.arcAdvertised && !dev.modernRejected);
    if (!keep && adopt) dev.arcProtocol = reply.protocolId;
    else if (!dev.arcProtocol) dev.arcProtocol = PROTOCOL.ARC_DEFAULT;
    if (rinfo.port) dev.ports.ARC = rinfo.port; // answer from the port it actually listens on
    this.count(dev, 'arc');
    if (reply.resultCode !== undefined && reply.resultCode !== ARC_RESULTS.SUCCESS && reply.resultCode !== ARC_RESULTS.MORE_PAGES) {
      dev.lastArcError = { opcode: reply.commandId, protocolId: reply.protocolId, resultCode: reply.resultCode, at: Date.now() };
    }

    switch (reply.commandId) {
      case ARC_COMMANDS.TX_CHANNEL_STATUS:
      case ARC_COMMANDS.RX_CHANNEL_STATUS:
        this.handleChannelStatusPage(dev, reply);
        break;
      case ARC_COMMANDS.CHANNEL_COUNTS: {
        if (this.modernArcProtocol(dev)) break; // counts come from the inventory
        const txChanged = this.setChannelCount(dev, 'tx', reply.txCount);
        const rxChanged = this.setChannelCount(dev, 'rx', reply.rxCount);
        if (txChanged || rxChanged) {
          this.identity.resolve(dev);
          if (txChanged) this.queryTxNames(dev.ip);
          if (rxChanged) this.queryRxChannels(dev.ip);
        }
        break;
      }
      case ARC_COMMANDS.DEVICE_NAME:
        this.setName(dev, reply.name, 'arc');
        break;
      case ARC_COMMANDS.TX_FRIENDLY_NAMES:
        for (const ch of reply.channels) {
          if (dev.tx.count && ch.number > dev.tx.count) continue;
          const entry = this.txEntry(dev, ch.number);
          entry.friendlyName = ch.name || null;
          entry.name = txLabel(entry);
        }
        break;
      case ARC_COMMANDS.TX_CHANNELS:
        for (const ch of reply.channels) {
          if (dev.tx.count && ch.number > dev.tx.count) continue;
          const entry = this.txEntry(dev, ch.number);
          if (ch.canonicalName) entry.canonicalName = ch.canonicalName;
          entry.name = txLabel(entry);
        }
        break;
      case ARC_COMMANDS.RX_CHANNELS:
        for (const ch of reply.channels) {
          if (dev.rx.count && ch.number > dev.rx.count) continue;
          // "." means the receiver is subscribed to one of its own transmitters.
          const txDevice = ch.txDevice === '.' ? dev.name : ch.txDevice;
          dev.rx.channels[ch.number] = {
            number: ch.number,
            name: ch.name || `Rx ${ch.number}`,
            subscribedDevice: txDevice,
            subscribedChannel: ch.txChannel,
            status: ch.status,
            rxStatus: ch.rxStatus,
            // Status 1 with receiver status 0x0101 is a live dynamic flow on some devices.
            connected: RX_CONNECTED_STATUSES.has(ch.status) || (ch.status === 1 && ch.rxStatus === 0x0101),
            paths: rxPaths(txDevice, ch.status, ch.rxStatus)
          };
        }
        applyQuirks(dev);
        break;
      case ARC_COMMANDS.DEVICE_SETTINGS:
        if (VALID_SAMPLE_RATES.includes(reply.sampleRate)) dev.sampleRate = reply.sampleRate;
        if (reply.latencyNs) dev.latencyNs = reply.latencyNs;
        break;
    }
  }

  /** Merge one page of a modern channel inventory; request the next page or finish. */
  handleChannelStatusPage(dev, reply) {
    const rx = reply.commandId === ARC_COMMANDS.RX_CHANNEL_STATUS;
    const key = rx ? 'rx' : 'tx';
    if (!reply.ok) {
      // Rejected: not actually a modern device; go back to the older queries.
      if (!packets.isModernArc(dev.arcAdvertised)) {
        dev.modernRejected = true;
        if (packets.isModernArc(dev.arcProtocol)) dev.arcProtocol = null;
      }
      return;
    }
    this.count(dev, rx ? 'rxInventory' : 'txInventory');
    dev.inventory = dev.inventory || {};
    const run = dev.inventory[key] || (dev.inventory[key] = { seen: new Map(), pages: 0 });
    run.pages++;
    // Every record's local ID, per media type (video and ancillary included), so
    // paging continues past pages that hold no audio channels.
    run.usedIds = run.usedIds || new Map();
    for (const ch of reply.channels) {
      if (!run.usedIds.has(ch.mediaType)) run.usedIds.set(ch.mediaType, new Set());
      run.usedIds.get(ch.mediaType).add(ch.localId);
    }

    for (const ch of reply.channels) {
      if (ch.mediaType !== 3) continue; // audio only
      run.seen.set(ch.number, ch);
      if (ch.sampleRate && VALID_SAMPLE_RATES.includes(ch.sampleRate)) dev.sampleRate = ch.sampleRate;
      if (rx) {
        const txDevice = ch.txDevice === '.' ? dev.name : ch.txDevice;
        dev.rx.channels[ch.number] = {
          number: ch.number,
          name: ch.name || `Rx ${ch.number}`,
          subscribedDevice: txDevice,
          subscribedChannel: ch.txChannel,
          status: ch.status,
          rxStatus: ch.rxStatus,
          connected: RX_CONNECTED_STATUSES.has(ch.status) || (ch.status === 1 && ch.rxStatus === 0x0101),
          paths: rxPaths(txDevice, ch.status, ch.rxStatus)
        };
      } else {
        const entry = this.txEntry(dev, ch.number);
        entry.friendlyName = ch.name && ch.name !== ch.factoryName ? ch.name : null;
        entry.canonicalName = ch.factoryName || ch.name || null;
        entry.name = txLabel(entry);
      }
    }

    const last = reply.channels[reply.channels.length - 1];
    if (reply.morePages && last && run.pages < MAX_INVENTORY_PAGES) {
      const used = run.usedIds.get(last.mediaType);
      let next = 1;
      while (used.has(next)) next++;
      this.sendChannelStatusQuery(dev, rx, last.mediaType, next);
      return;
    }

    // Complete: the inventory is the channel list.
    const numbers = [...run.seen.keys()];
    for (const n of Object.keys(dev[key].channels)) if (!run.seen.has(Number(n))) delete dev[key].channels[n];
    if (this.setChannelCount(dev, key, numbers.length ? Math.max(...numbers) : 0)) this.identity.resolve(dev);
    if (rx) applyQuirks(dev);
  }

  handleSettings(msg, rinfo) {
    const reply = packets.parseSettingsReply(msg);
    if (!reply) return;
    const dev = this.register(rinfo.address);
    this.count(dev, 'settings');
    if (reply.mac) dev.mac = reply.mac;
    if (reply.clock) {
      dev.clock = reply.clock;
      dev.clockAt = Date.now();
      this.count(dev, 'clock');
      this.settingsAnswered(dev, 'clock');
    }
    if (reply.commandId === SETTINGS_MESSAGES.INTERFACE_STATUS || reply.commandId === SETTINGS_MESSAGES.INTERFACE_CONTROL) {
      this.settingsAnswered(dev, 'interfaces');
    }
    if (reply.numInterfaces) dev.numInterfaces = reply.numInterfaces;
    if (reply.secondaryIp) dev.secondaryIp = reply.secondaryIp;
    if (reply.interfaces && reply.interfaces.length) dev.interfaces = reply.interfaces;
    if (reply.linkSpeedMbps) dev.linkSpeedMbps = reply.linkSpeedMbps;
    if (reply.redundancy) dev.redundancy = reply.redundancy;
    if (reply.commandId === SETTINGS_MESSAGES.SWITCH_STATUS) this.settingsAnswered(dev, 'switch');
    if (reply.portStats) {
      dev.portStats = reply.portStats;
      this.settingsAnswered(dev, 'portStats');
    }
    if (reply.aes67) {
      dev.aes67 = reply.aes67;
      this.settingsAnswered(dev, 'aes67');
    }
    if (reply.danteModel) {
      dev.danteModel = reply.danteModel;
      this.settingsAnswered(dev, 'danteModel');
    }
    if (reply.makeModel) {
      dev.makeModel = reply.makeModel;
      this.settingsAnswered(dev, 'makeModel');
    }
  }

  handleCmc(msg, rinfo) {
    const reply = packets.parseCmcReply(msg);
    const dev = this.devices.get(rinfo.address);
    if (!reply || !dev) return;
    dev.lastSeen = Date.now();
    this.count(dev, 'cmc');
    if (rinfo.port && !dev.cmcPortAdvertised) {
      dev.ports.CMC = rinfo.port; // the port that answered
      dev.cmcPortConfirmed = true;
    }
    if (reply.settingsPort) dev.ports.SETTINGS = reply.settingsPort;
  }

  handleHeartbeat(msg, rinfo) {
    const hb = packets.parseHeartbeat(msg);
    if (!hb) return;
    const dev = this.register(rinfo.address);
    this.count(dev, 'heartbeat');
    this.stats.heartbeats++;
    this.stats.lastHeartbeatAt = Date.now();
    if (hb.mac) dev.mac = hb.mac;
    if (hb.ports) {
      dev.numPorts = hb.ports.numPorts;
      dev.secondaryLinkUp = hb.ports.secondaryLinkUp;
    }
    if (hb.clockOffsetPpb !== null) dev.clockOffsetPpb = hb.clockOffsetPpb;
    if (hb.latePackets !== null) dev.latePackets = hb.latePackets;
    if (hb.levels) {
      const now = Date.now();
      this.stats.lastLevelsAt = now;
      this.recordLevels(dev, 'tx', hb.levels.txFirst, hb.levels.tx, now);
      this.recordLevels(dev, 'rx', hb.levels.rxFirst, hb.levels.rx, now);
    }
  }

  handleMetering(msg, rinfo) {
    const levels = packets.parseMeteringPacket(msg);
    if (!levels) return;
    const dev = this.register(rinfo.address);
    this.count(dev, 'metering');
    this.stats.meteringFrames++;
    this.stats.lastMeteringAt = Date.now();
    if (levels.mac) dev.mac = levels.mac;
    // Only size channels from the meter stream until ARC has reported counts.
    let grew = false;
    if (!dev.tx.count && levels.tx.length) grew = this.setChannelCount(dev, 'tx', levels.tx.length) || grew;
    if (!dev.rx.count && levels.rx.length) grew = this.setChannelCount(dev, 'rx', levels.rx.length) || grew;
    if (grew) applyQuirks(dev);
    if (!dev.meteringSeen) {
      dev.meteringSeen = true;
      this.log.info(`[Dante] Receiving meters from ${dev.name} (${dev.ip}): ${levels.tx.length} Tx / ${levels.rx.length} Rx`);
    }
    const now = Date.now();
    this.recordLevels(dev, 'tx', 1, levels.tx, now);
    this.recordLevels(dev, 'rx', 1, levels.rx, now);
  }

  handleMdns(msg, rinfo) {
    const instances = mdns.parseServiceInstances(msg, Object.values(SERVICES));
    const now = Date.now();
    for (const inst of instances) {
      if (inst.address) {
        // The answer carries the device's own address (SRV + A): authoritative.
        const dev = this.register(inst.address, inst.name);
        this.applyMdns(dev, inst);
        continue;
      }
      // No address: this may be another host (often a computer's own mDNS
      // responder) relaying a cached record. Never attribute it to the sender.
      // Use it only for a device we already know by that name, and otherwise
      // ask that instance directly for its address.
      const known = this.deviceByName(inst.name);
      if (known) {
        this.applyMdns(known, inst);
      } else if (now - (this.mdnsLookups.get(inst.fullName) || 0) > 30000) {
        this.mdnsLookups.set(inst.fullName, now);
        this.send('MDNS', mdns.buildQuery([inst.fullName], mdns.TYPE.SRV), PORTS.MDNS, MULTICAST.MDNS);
      }
    }
  }

  /** Apply advertised ports and identity from an mDNS instance to a device. */
  applyMdns(dev, inst) {
    if (inst.port && inst.service === SERVICES.ARC) {
      dev.ports.ARC = inst.port;
      dev.arcPortAdvertised = true;
    }
    if (inst.port && inst.service === SERVICES.CMC) {
      dev.ports.CMC = inst.port;
      dev.cmcPortAdvertised = true;
    }
    const version = inst.txt.arcp_vers;
    if (inst.service === SERVICES.ARC && typeof version === 'string' && version !== dev.arcpVers) {
      dev.arcpVers = version;
      dev.arcAdvertised = packets.arcProtocolFromVersion(version);
      if (!packets.isModernArc(dev.arcAdvertised) && packets.isModernArc(dev.arcProtocol)) dev.arcProtocol = null;
      if (packets.isModernArc(dev.arcAdvertised)) {
        this.log.info(`[Dante] ${dev.name} uses modern ARC 0x${dev.arcAdvertised.toString(16)} (arcp_vers ${version})`);
        this.pollDevice(dev.ip);
      }
    }
    const { mf, model } = inst.txt;
    if ((mf && mf !== dev.mdnsMf) || (model && model !== dev.mdnsModel)) {
      if (typeof mf === 'string') dev.mdnsMf = mf;
      if (typeof model === 'string') dev.mdnsModel = model;
      this.identity.resolve(dev);
    }
  }

  // -------------------------------------------------------------------------
  // Routing control
  // -------------------------------------------------------------------------

  /** Find a device by its Dante name (case-insensitive) or IP; an online one is preferred. */
  findDeviceByName(name) {
    if (!name) return null;
    const byIp = this.devices.get(name);
    if (byIp) return byIp;
    return this.deviceByName(String(name).trim());
  }

  /** Subscription name for `txChannel` (number) on the device called `txDeviceName`. */
  txSubscriptionName(txDeviceName, txChannel) {
    return txSubscriptionName(this.findDeviceByName(txDeviceName), Number(txChannel));
  }

  /**
   * The transmit path a receiver is subscribed to, as { device, channel } with
   * the channel as a number, or null when it has no source. The channel is
   * matched by subscription name (friendly, then canonical), else parsed.
   */
  sourceOf(rxDeviceName, rxChannel) {
    const state = this.rxState(rxDeviceName, rxChannel);
    if (!state || !state.subscribedDevice) return null;
    const txDev = this.findDeviceByName(state.subscribedDevice);
    const device = txDev ? txDev.name : state.subscribedDevice;
    const channel = txDev ? findTxChannel(txDev, state.subscribedChannel) : null;
    if (channel) return { device, channel, channelName: state.subscribedChannel, connected: Boolean(state.connected) };
    const m = /^0*(\d+)/.exec(String(state.subscribedChannel || ''));
    return m ? { device, channel: Number(m[1]), channelName: state.subscribedChannel, connected: Boolean(state.connected) } : null;
  }

  /** Rx channel record for a device name + channel number, or null. */
  rxState(rxDeviceName, rxChannel) {
    const dev = this.findDeviceByName(rxDeviceName);
    const ch = dev && dev.rx.channels[Number(rxChannel)];
    return ch ? { ...ch, online: this.isOnline(dev) } : null;
  }

  /**
   * Every Rx channel on the network currently subscribed to a Tx channel
   * (by device name + channel number). Used to break a spare's existing patch.
   */
  receiversOf(txDeviceName, txChannel) {
    const txDev = this.findDeviceByName(txDeviceName);
    if (!txDev) return [];
    const wantedDev = txDev.name.toLowerCase();
    const names = new Set([txSubscriptionName(txDev, Number(txChannel)).toLowerCase(), String(txChannel).padStart(2, '0')]);
    const out = [];
    for (const dev of this.devices.values()) {
      for (const ch of Object.values(dev.rx.channels)) {
        if (!ch.subscribedDevice || !ch.subscribedChannel) continue;
        if (ch.subscribedDevice.toLowerCase() !== wantedDev) continue;
        if (!names.has(ch.subscribedChannel.toLowerCase())) continue;
        out.push({ device: dev.name, ip: dev.ip, channel: ch.number, online: this.isOnline(dev) });
      }
    }
    return out;
  }

  /** Re-read a receiver's subscriptions shortly after a change. */
  scheduleRxRefresh(ip) {
    for (const delay of [300, 1200]) setTimeout(() => this.devices.has(ip) && this.queryRxChannels(ip), delay).unref();
  }

  /**
   * Send a subscription message to a receiver. Uses the Dante Controller
   * framing (arcCommand) on the port the device answers on, with the legacy
   * protocol ID it answered with. Devices speaking only the modern ARC
   * protocols get the default ID 0x2729. Verified on Yamaha Rio3224-D (ARC
   * 0x280C) and Dante Virtual Soundcard 4.x (0x2809), as receiver and as source.
   */
  sendSubscription(dev, args) {
    const { port } = this.arcTargetFor(dev);
    const protocolId = dev.arcProtocol && !packets.isModernArc(dev.arcProtocol) ? dev.arcProtocol : PROTOCOL.ARC;
    this.send('ARC', packets.arcCommand(this.nextSeq(), ARC_COMMANDS.RX_SUBSCRIBE, args, protocolId), port, dev.ip);
  }

  /**
   * Point `rxChannel` on `rxDevice` at `txChannel` on `txDevice`.
   * Returns { ok, error?, txName?, txChannelName?, txOnline? }. The receiver is the device that is told.
   */
  subscribe({ rxDevice, rxChannel, txDevice, txChannel }) {
    const rx = this.findDeviceByName(rxDevice);
    if (!rx) return { ok: false, error: `Receiver "${rxDevice}" is not on the network` };
    if (!this.isOnline(rx)) return { ok: false, error: `Receiver "${rx.name}" is offline` };
    const rxCh = Number(rxChannel);
    if (!Number.isInteger(rxCh) || rxCh < 1 || (rx.rx.count && rxCh > rx.rx.count)) {
      return { ok: false, error: `Receiver "${rx.name}" has no Rx channel ${rxChannel}` };
    }
    const tx = this.findDeviceByName(txDevice);
    const txName = tx ? tx.name : String(txDevice).trim();
    const txCh = Number(txChannel);
    if (!txName || !Number.isInteger(txCh) || txCh < 1) return { ok: false, error: 'Invalid transmitter' };
    const chanName = txSubscriptionName(tx, txCh);
    this.sendSubscription(rx, packets.rxSubscribeArgs(rxCh, chanName, txName));
    this.log.info(`[Route] ${rx.name} Rx ${rxCh} <- ${txName} / ${chanName}`);
    this.scheduleRxRefresh(rx.ip);
    return { ok: true, txName, txChannelName: chanName, txOnline: Boolean(tx && this.isOnline(tx)) };
  }

  /** Clear the subscription on `rxChannel` of `rxDevice`. */
  unsubscribe({ rxDevice, rxChannel }) {
    const rx = this.findDeviceByName(rxDevice);
    if (!rx) return { ok: false, error: `Receiver "${rxDevice}" is not on the network` };
    if (!this.isOnline(rx)) return { ok: false, error: `Receiver "${rx.name}" is offline` };
    const rxCh = Number(rxChannel);
    if (!Number.isInteger(rxCh) || rxCh < 1) return { ok: false, error: `Invalid Rx channel ${rxChannel}` };
    this.sendSubscription(rx, packets.rxUnsubscribeArgs(rxCh));
    this.log.info(`[Route] ${rx.name} Rx ${rxCh} <- (cleared)`);
    this.scheduleRxRefresh(rx.ip);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  isOnline(dev, now = Date.now()) {
    return now - dev.lastSeen <= TIMING.OFFLINE_AFTER;
  }

  clockLeaders(now = Date.now()) {
    // Offline devices keep their last clock reply until they are removed; a
    // stale "I am leader" must not count.
    const online = [...this.devices.values()].filter((d) => this.isOnline(d, now));
    const votes = new Map();
    for (const dev of online) {
      const gm = dev.clock && dev.clock.grandmasterUuid;
      if (gm && !/^0+$/.test(gm)) votes.set(gm, (votes.get(gm) || 0) + 1);
    }
    let grandmaster = null;
    let best = 0;
    for (const [gm, count] of votes) {
      if (count > best) [grandmaster, best] = [gm, count];
    }
    // PTP clock identities are the leader's MAC followed by two zero bytes, so
    // the leader is found even when it doesn't answer clock queries itself.
    const gmMac = grandmaster ? grandmaster.slice(0, 12) : null;
    const leaders = new Set();
    for (const dev of online) {
      const byClock =
        dev.clock &&
        (dev.clock.isMaster || (grandmaster && dev.clock.uuid === grandmaster) || portState(dev, 0) === PTP_PORT_LEADER);
      if (byClock || (gmMac && dev.mac === gmMac)) leaders.add(dev.ip);
    }
    return leaders;
  }

  /**
   * Devices whose secondary port is the clock leader on the secondary network.
   * A healthy redundant network has exactly one (normally the primary leader).
   * A device whose secondary port is cut off from the others also reports
   * itself as leader there; one whose secondary link is known to be down is
   * left out.
   */
  secondaryClockLeaders(now = Date.now()) {
    const leaders = new Set();
    for (const dev of this.devices.values()) {
      if (!this.isOnline(dev, now) || dev.secondaryLinkUp === false) continue;
      if (portState(dev, 1) === PTP_PORT_LEADER) leaders.add(dev.ip);
    }
    return leaders;
  }

  syncStatus(dev, online, isLeader) {
    const clk = dev.clock;
    const clockFault = Boolean(clk && (clk.servo === 0 || clk.servo === 1));

    let primary;
    if (!online) primary = 'error';
    else if (isLeader) primary = 'good';
    else if (!clk) primary = 'none';
    else if (clk.servo === 3) primary = 'good';
    else if (clk.servo === 2) primary = 'syncing';
    else if (clockFault || clk.state === 1) primary = 'error';
    else primary = 'good';

    const ports = dev.numPorts !== null ? dev.numPorts : clk ? clk.numPorts : null;
    let secondary;
    if (ports !== null && ports < 2) secondary = 'unsupported';
    else if (dev.secondaryLinkUp === false || !online) secondary = 'error';
    else if (ports === null && dev.secondaryLinkUp === null) secondary = 'none';
    else if (clockFault) secondary = 'error';
    else if (!clk && dev.secondaryLinkUp === null) secondary = 'none';
    else secondary = 'good';

    return {
      primarySync: primary,
      secondarySync: secondary,
      secondarySupported: secondary !== 'unsupported',
      secondaryLinkUp: dev.secondaryLinkUp
    };
  }

  /**
   * Is the Dante traffic that only arrives unsolicited (multicast heartbeats,
   * meter streams) reaching us? If devices answer our queries but none of this
   * arrives, a firewall is the usual cause (e.g. Windows treating the Dante
   * network as "Public").
   */
  getHealth(now = Date.now()) {
    const GRACE = 20000;
    const st = this.stats;
    const online = [...this.devices.values()].filter((d) => this.isOnline(d, now));
    const settled = st.firstDeviceAt !== null && now - st.firstDeviceAt > GRACE;
    const heartbeatsMissing = settled && online.length > 0 && (st.lastHeartbeatAt === null || now - st.lastHeartbeatAt > GRACE);
    const meteringMissing =
      st.firstMeteringRequestAt !== null &&
      now - st.firstMeteringRequestAt > GRACE &&
      online.length > 0 &&
      (st.lastMeteringAt === null || now - st.lastMeteringAt > GRACE) &&
      // Devices also put levels in their heartbeats (about once a second); with
      // those arriving the meters work, just less smoothly, so it is not a fault.
      (!st.lastLevelsAt || now - st.lastLevelsAt > GRACE);
    return {
      multicastBlocked: heartbeatsMissing,
      meteringBlocked: meteringMissing,
      platform: process.platform
    };
  }

  /** Everything needed to diagnose a device that isn't showing data. */
  getDiagnostics(now = Date.now()) {
    const ago = (t) => (t ? Math.round((now - t) / 100) / 10 : null);
    return {
      generatedAt: new Date(now).toISOString(),
      platform: `${process.platform} ${process.arch}, Node ${process.version}`,
      interface: this.iface ? { name: this.iface.name, address: this.iface.address, netmask: this.iface.netmask } : 'all',
      meteringPort: this.meteringPort,
      mdnsPort: this.sockets.MDNS ? safePort(this.sockets.MDNS) : null,
      health: this.getHealth(now),
      network: {
        heartbeats: this.stats.heartbeats,
        lastHeartbeatSecondsAgo: ago(this.stats.lastHeartbeatAt),
        meteringFrames: this.stats.meteringFrames,
        lastMeteringSecondsAgo: ago(this.stats.lastMeteringAt)
      },
      devices: [...this.devices.values()].map((dev) => ({
        name: dev.name,
        ip: dev.ip,
        online: this.isOnline(dev, now),
        lastSeenSecondsAgo: ago(dev.lastSeen),
        identity: { manufacturer: dev.manufacturer, model: dev.modelName, mdnsMf: dev.mdnsMf, mdnsModel: dev.mdnsModel },
        ports: {
          ...dev.ports,
          arcSource: dev.arcProtocol ? 'answered' : dev.arcPortAdvertised ? 'mDNS (no answer yet)' : 'guessing',
          cmcSource: dev.cmcPortAdvertised ? 'mDNS' : dev.cmcPortConfirmed ? 'answered' : 'guessing'
        },
        arcProtocol: dev.arcProtocol ? `0x${dev.arcProtocol.toString(16)}` : null,
        arcAdvertised: dev.arcpVers ? `${dev.arcpVers} (0x${(dev.arcAdvertised || 0).toString(16)})` : null,
        channelInventory: this.modernArcProtocol(dev) ? 'modern (0x2400/0x3400)' : 'legacy',
        lastArcError: dev.lastArcError
          ? {
              opcode: `0x${dev.lastArcError.opcode.toString(16)}`,
              protocol: `0x${dev.lastArcError.protocolId.toString(16)}`,
              result: `0x${dev.lastArcError.resultCode.toString(16)}`,
              secondsAgo: ago(dev.lastArcError.at)
            }
          : null,
        lastArcReplySecondsAgo: ago(dev.lastArcReplyAt),
        polls: dev.pollCount,
        packets: dev.counters,
        channels: { tx: dev.tx.count, rx: dev.rx.count },
        sampleRate: dev.sampleRate,
        clock: dev.clock ? { servo: dev.clock.servo, state: dev.clock.state, revision: dev.clock.revision, secondsAgo: ago(dev.clockAt) } : null,
        network: { heartbeatPorts: dev.numPorts, interfaces: dev.numInterfaces, secondaryLinkUp: dev.secondaryLinkUp, secondaryIp: dev.secondaryIp },
        metering: { subscribed: Boolean(dev.meteringSubscribed), seen: Boolean(dev.meteringSeen) }
      }))
    };
  }

  /** Raw per-device state for the event monitor (lib/events/monitor.js). */
  getMonitorSnapshot(now = Date.now()) {
    const names = (ips) => {
      const set = new Set();
      for (const ip of ips) {
        const dev = this.devices.get(ip);
        if (dev) set.add(dev.name);
      }
      return set;
    };
    const leaders = names(this.clockLeaders(now));
    const secondaryLeaders = names(this.secondaryClockLeaders(now));
    return {
      iface: this.iface ? { name: this.iface.name, address: this.iface.address, netmask: this.iface.netmask } : null,
      health: this.getHealth(now),
      leaders: [...leaders],
      secondaryLeaders: [...secondaryLeaders],
      devices: [...this.devices.values()].map((dev) => ({
        ip: dev.ip,
        name: dev.name,
        hasName: dev.hasName,
        online: this.isOnline(dev, now),
        lastSeen: dev.lastSeen,
        lastArcReplyAt: dev.lastArcReplyAt || null,
        sampleRate: dev.sampleRate,
        clock: dev.clock,
        clockOffsetPpb: dev.clockOffsetPpb ?? null,
        latePackets: dev.latePackets ?? null,
        numPorts: dev.numPorts ?? (dev.clock ? dev.clock.numPorts : null),
        secondaryLinkUp: dev.secondaryLinkUp,
        secondaryIp: dev.secondaryIp,
        redundant: this.isRedundant(dev),
        rx: Object.values(dev.rx.channels).map((ch) => ({
          paths: ch.paths || null,
          number: ch.number,
          name: ch.name,
          subscribedDevice: ch.subscribedDevice || null,
          subscribedChannel: ch.subscribedChannel || null,
          status: ch.status,
          rxStatus: ch.rxStatus
        }))
      }))
    };
  }

  /**
   * A compact, read-only summary for outside tools that poll occasionally (a
   * status board, a spreadsheet script): one entry per device, by name, with
   * whether it is reachable and what it reports about each network. Devices
   * that were seen and have since dropped off stay listed as offline.
   */
  getNetworkStatus(now = Date.now()) {
    const iso = (t) => (t ? new Date(t).toISOString() : null);
    const leaders = this.clockLeaders(now);
    const secondaryLeaders = this.secondaryClockLeaders(now);
    const devices = [];
    const listed = new Set();
    for (const dev of this.devices.values()) {
      if (!dev.hasName) continue; // not identified yet
      const online = this.isOnline(dev, now);
      const sync = this.syncStatus(dev, online, leaders.has(dev.ip));
      // The bridge only talks to devices on the primary network; secondary state
      // is what the device says about itself, and is unknown while it's unreachable.
      let secondary;
      if (!sync.secondarySupported) secondary = 'none';
      else if (!online) secondary = 'unknown';
      else if (dev.secondaryLinkUp === true) secondary = 'up';
      else if (dev.secondaryLinkUp === false) secondary = 'down';
      // No link report (some devices never send one), but its secondary port is
      // following or listening to another device's clock: the link is working.
      else if (PTP_PORT_RECEIVING.has(portState(dev, 1))) secondary = 'up';
      else secondary = 'unknown';
      listed.add(dev.name.toLowerCase());
      devices.push({
        name: dev.name,
        online,
        since: iso(online ? dev.onlineSince : dev.lastSeen),
        lastSeen: iso(dev.lastSeen),
        primary: { status: online ? 'up' : 'down', ip: dev.ip, sync: sync.primarySync, clockLeader: leaders.has(dev.ip) },
        secondary: { status: secondary, ip: dev.secondaryIp || null, sync: sync.secondarySync, clockLeader: secondaryLeaders.has(dev.ip) }
      });
    }
    for (const gone of this.departed.values()) {
      if (listed.has(gone.name.toLowerCase())) continue;
      devices.push({
        name: gone.name,
        online: false,
        since: iso(gone.lastSeen),
        lastSeen: iso(gone.lastSeen),
        primary: { status: 'down', ip: gone.ip, sync: 'error', clockLeader: false },
        secondary: { status: 'unknown', ip: null, sync: 'none', clockLeader: false }
      });
    }
    devices.sort((a, b) => a.name.localeCompare(b.name));
    const online = devices.filter((d) => d.online).length;
    return {
      generatedAt: iso(now),
      interface: this.iface ? { name: this.iface.name, address: this.iface.address } : null,
      summary: { devices: devices.length, online, offline: devices.length - online },
      devices
    };
  }

  /** Device structure (everything except live levels). */
  getDevices() {
    const now = Date.now();
    const leaders = this.clockLeaders(now);
    const secondaryLeaders = this.secondaryClockLeaders(now);
    return [...this.devices.values()].map((dev) => {
      const online = this.isOnline(dev, now);
      const isClockLeader = leaders.has(dev.ip);
      return {
        ip: dev.ip,
        name: dev.name,
        online,
        manufacturer: dev.manufacturer,
        modelName: dev.modelName,
        productVersion: dev.productVersion,
        softwareVersion: dev.softwareVersion,
        firmwareVersion: dev.firmwareVersion,
        sampleRate: dev.sampleRate,
        isClockLeader,
        isSecondaryClockLeader: secondaryLeaders.has(dev.ip),
        aes67: dev.aes67 ? dev.aes67.enabled : null,
        redundant: this.isRedundant(dev),
        secondaryIp: dev.secondaryIp,
        ...this.syncStatus(dev, online, isClockLeader),
        tx: {
          count: dev.tx.count,
          channels: Object.fromEntries(
            Object.values(dev.tx.channels).map((ch) => [ch.number, { ...ch, subscriptionName: txSubscriptionName(dev, ch.number) }])
          )
        },
        rx: { count: dev.rx.count, channels: dev.rx.channels }
      };
    });
  }

  /** Whether the device carries audio on a separate secondary network (not one port, not Switched mode). */
  isRedundant(dev) {
    if (dev.redundancy) return dev.redundancy.mode === 'redundant';
    return Boolean(dev.secondaryIp);
  }

  /**
   * Technical details per device for the Device Info tab: what the device says
   * about itself (falling back to the identity database), its network mode and
   * port speeds, and its clock. Null means "not reported".
   */
  getDeviceInfo(now = Date.now()) {
    const leaders = this.clockLeaders(now);
    const secondaryLeaders = this.secondaryClockLeaders(now);
    const port = (dev, index, online) => {
      const stats = dev.portStats && dev.portStats[index];
      const iface = dev.interfaces && dev.interfaces[index];
      let speedMbps = stats ? stats.speedMbps : index === 0 ? dev.linkSpeedMbps || null : null;
      let link = speedMbps ? 'up' : stats ? 'down' : null;
      if (index === 1 && dev.secondaryLinkUp === false) {
        link = 'down';
        speedMbps = null;
      }
      if (!online) link = null;
      return {
        link,
        speedMbps: link === 'up' ? speedMbps : null,
        // Linked slower than the device is built for (e.g. a gigabit device at 100).
        reduced: Boolean(link === 'up' && speedMbps && dev.danteModel && dev.danteModel.preferredLinkSpeedMbps > speedMbps),
        ip: index === 0 ? dev.ip : dev.secondaryIp || null,
        mac: iface ? iface.mac : null,
        errors: stats ? stats.txErrors + stats.rxErrors : null,
        // Whole Mbit/s (0 = under 1), so the table is not redrawn for every small change.
        txMbps: stats && link === 'up' ? Math.floor(stats.txBitsPerSec / 1e6) : null,
        rxMbps: stats && link === 'up' ? Math.floor(stats.rxBitsPerSec / 1e6) : null
      };
    };
    // Receive channels that are subscribed, and how many of those are passing audio.
    const subscriptions = (dev) => {
      const subscribed = Object.values(dev.rx.channels).filter((ch) => ch.subscribedDevice);
      return { subscribed: subscribed.length, connected: subscribed.filter((ch) => ch.connected).length };
    };
    return [...this.devices.values()].map((dev) => {
      const online = this.isOnline(dev, now);
      const ports = dev.numInterfaces || dev.numPorts || (dev.portStats && dev.portStats.length) || null;
      const twoPorts = ports >= 2 || Boolean(dev.secondaryIp);
      const make = dev.makeModel || {};
      const dante = dev.danteModel || {};
      const clk = dev.clock;
      const muted = clk && clk.muteFlags !== null && clk.muteFlags !== undefined ? clk.muteFlags !== 0 : null;
      // PTP role of one multicast port: 'leader', 'follower', 'passive',
      // 'listening', 'disabled', or null when the device has no such port.
      const ptpRole = (version, iface) => {
        const ports = (clk && clk.ptpPorts) || [];
        let state = null;
        const p = ports.find((x) => x.version === version && x.transport === 'multicast' && x.iface === iface);
        if (p) state = p.disabled ? 3 : p.state;
        // Firmware without the per-protocol list still reports PTPv1 per port.
        else if (!ports.length && version === 1 && clk && clk.portStates) state = clk.portStates[iface] ?? null;
        if (iface === 1 && dev.secondaryLinkUp === false && state !== null) return 'no-link';
        return { 3: 'disabled', 4: 'listening', 6: 'leader', 7: 'passive', 9: 'follower' }[state] || (state === null ? null : 'other');
      };
      return {
        ip: dev.ip,
        name: dev.name,
        online,
        manufacturer: make.manufacturer || dev.manufacturer || null,
        modelName: make.modelName || dev.modelName || null,
        productVersion: make.productVersion || dev.productVersion || null,
        danteModel: dante.modelName || dante.modelId || null,
        danteFirmware: dante.firmwareVersion || dev.firmwareVersion || null,
        hardwareVersion: dante.hardwareVersion || null,
        romVersion: dante.romVersion || null,
        redundancy: dev.redundancy ? dev.redundancy.mode : ports === 1 && !twoPorts ? 'single' : null,
        aes67: dev.aes67 ? dev.aes67.enabled : null,
        aes67Pending: Boolean(dev.aes67 && dev.aes67.enabled !== dev.aes67.configured),
        redundancyPending: Boolean(dev.redundancy && dev.redundancy.configured && dev.redundancy.configured !== dev.redundancy.mode),
        primary: port(dev, 0, online),
        secondary: twoPorts ? port(dev, 1, online) : null,
        subscriptions: subscriptions(dev),
        latencyMs: dev.latencyNs ? dev.latencyNs / 1e6 : null,
        // Audio packets that arrived too late to play, counted by the device (null: it does not say).
        latePackets: dev.latePackets ?? null,
        packetErrors: dev.portStats ? dev.portStats.reduce((n, p) => n + p.txErrors + p.rxErrors, 0) : null,
        clock: clk
          ? {
              sync: clk.servo === 3 ? 'locked' : clk.servo === 2 ? 'syncing' : clk.servo === 0 || clk.servo === 1 ? 'fault' : 'unknown',
              muted,
              externalWordClock: clk.source === 1 || clk.source === 2 ? true : clk.source === 0 ? false : null,
              preferred: Boolean(clk.isPreferred),
              frequencyOffsetPpm: Number.isFinite(clk.frequencyOffsetPpb) ? Math.round(clk.frequencyOffsetPpb / 1000) : null,
              source: clk.source === 0 ? 'dante' : clk.source === 1 || clk.source === 2 ? 'external' : null,
              primaryV1: ptpRole(1, 0),
              primaryV2: ptpRole(2, 0),
              secondaryV1: twoPorts ? ptpRole(1, 1) : null,
              secondaryV2: twoPorts ? ptpRole(2, 1) : null,
              ptpv2Domain: clk.ptpv2Domain ?? null,
              ptpv2Priority1: clk.ptpv2Priority1 ?? null,
              ptpv2Priority2: clk.ptpv2Priority2 ?? null,
              leader: leaders.has(dev.ip) ? 'primary' : secondaryLeaders.has(dev.ip) ? 'secondary' : null
            }
          : null
      };
    });
  }

  /**
   * Current peak bytes per device/direction (array index 0 = channel 1,
   * null = no recent data). When a device doesn't report its own levels for a
   * channel, the level is inferred from the other end of a Dante subscription
   * and the channel is listed under `mirrored`.
   */
  getMeterFrame(now = Date.now()) {
    const live = (dev, dir, ch) => {
      const m = dev.meters[dir][ch];
      return m && now - m.at <= TIMING.METER_STALE_AFTER ? m.peak : null;
    };
    const devices = [...this.devices.values()].filter((d) => this.isOnline(d, now));
    const byName = new Map();
    for (const d of devices) {
      byName.set(d.ip, d);
      if (d.hasName) byName.set(d.name.toLowerCase(), d);
    }

    // Index native Rx levels by (source device, source channel) for Tx inference.
    const rxBySource = new Map();
    for (const d of devices) {
      for (const ch of Object.values(d.rx.channels)) {
        if (!ch.connected || !ch.subscribedDevice || !ch.subscribedChannel) continue;
        const peak = live(d, 'rx', ch.number);
        if (peak !== null) rxBySource.set(sourceKey(ch.subscribedDevice, ch.subscribedChannel), peak);
      }
    }

    const frame = {};
    for (const dev of devices) {
      const tx = [];
      const rx = [];
      const mirrored = { tx: [], rx: [] };

      for (let ch = 1; ch <= dev.tx.count; ch++) {
        let peak = live(dev, 'tx', ch);
        if (peak === null) {
          peak = rxBySource.get(sourceKey(dev.name, txSubscriptionName(dev, ch)));
          if (peak === undefined) peak = rxBySource.get(sourceKey(dev.name, String(ch).padStart(2, '0')));
          if (peak === undefined) peak = null;
          else mirrored.tx.push(ch);
        }
        tx.push(peak);
      }

      for (let ch = 1; ch <= dev.rx.count; ch++) {
        let peak = live(dev, 'rx', ch);
        const sub = dev.rx.channels[ch];
        if (peak === null && sub && sub.connected && sub.subscribedDevice) {
          const src = byName.get(sub.subscribedDevice.toLowerCase()) || byName.get(sub.subscribedDevice);
          const srcCh = src && findTxChannel(src, sub.subscribedChannel);
          const srcPeak = srcCh ? live(src, 'tx', srcCh) : null;
          if (srcPeak !== null) {
            peak = srcPeak;
            mirrored.rx.push(ch);
          }
        }
        rx.push(peak);
      }

      const entry = { tx, rx };
      if (mirrored.tx.length || mirrored.rx.length) entry.mirrored = mirrored;
      frame[dev.ip] = entry;
    }
    return frame;
  }

  /**
   * Rich snapshot for the JSON API: structure plus levels. `peak` is the raw
   * Dante byte (null = no recent data); `dbfs` is null for silence or no data.
   */
  getSnapshot() {
    const frame = this.getMeterFrame();
    const levels = (peaks) => ({
      peak: peaks,
      dbfs: peaks.map((p) => {
        const db = byteToDbfs(p);
        return isFinite(db) ? db : null;
      })
    });
    return {
      timestamp: Date.now(),
      boundIp: this.boundIp,
      devices: this.getDevices().map((d) => {
        const f = frame[d.ip];
        return f ? { ...d, levels: { tx: levels(f.tx), rx: levels(f.rx) } } : d;
      })
    };
  }
}

/**
 * Which networks a subscribed receive channel is getting audio on.
 *
 * The receiver status word is two bytes of interface bits (bit 0 primary,
 * bit 1 secondary): the high byte says where a flow is set up, the low byte
 * where audio is actually arriving. Null when the channel is not subscribed,
 * or is subscribed to the device's own transmitter (no network flow).
 */
function rxPaths(txDevice, status, rxStatus) {
  if (!txDevice || status === 4 || typeof rxStatus !== 'number') return null;
  return { primary: Boolean(rxStatus & 0x01), secondary: Boolean(rxStatus & 0x02) };
}

function safePort(sock) {
  try {
    return sock.address().port;
  } catch {
    return null;
  }
}

/** Display label for a Tx channel: friendly name, else canonical name, else "Tx N". */
function txLabel(entry) {
  return entry.friendlyName || entry.canonicalName || `Tx ${entry.number}`;
}

/**
 * The name a receiver must use to subscribe to a Tx channel: the friendly
 * name when one is set, otherwise the canonical name (usually "01", "02", …).
 */
function txSubscriptionName(dev, number) {
  const entry = dev && dev.tx.channels[number];
  if (entry && entry.friendlyName) return entry.friendlyName;
  if (entry && entry.canonicalName) return entry.canonicalName;
  return String(number).padStart(2, '0');
}

function sourceKey(device, channel) {
  return `${String(device).toLowerCase()}\u0000${String(channel).toLowerCase()}`;
}

function findTxChannel(dev, channelName) {
  if (!channelName) return null;
  const wanted = channelName.trim().toLowerCase();
  for (const ch of Object.values(dev.tx.channels)) {
    for (const candidate of [ch.friendlyName, ch.canonicalName, ch.name]) {
      if (candidate && candidate.trim().toLowerCase() === wanted) return ch.number;
    }
  }
  const m = wanted.match(/^(\d+)/);
  const n = m ? parseInt(m[1], 10) : null;
  return n && n <= dev.tx.count ? n : null;
}

module.exports = { DanteEngine, TIMING, txSubscriptionName, txLabel };
