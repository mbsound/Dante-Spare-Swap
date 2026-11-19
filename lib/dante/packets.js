'use strict';

/**
 * Pure builders and parsers for the Dante UDP protocols used by the bridge.
 * Nothing in here touches sockets or engine state, so it can be unit tested
 * byte-for-byte.
 */

const {
  PORTS,
  PROTOCOL,
  ARC_PROTOCOL_IDS,
  KNOWN_ARC_PROTOCOLS,
  MODERN_ARC_PROTOCOLS,
  ARC_COMMANDS,
  ARC_RESULTS,
  SETTINGS_MESSAGES,
  HEARTBEAT_RECORDS,
  AUDINATE_MAGIC,
  DEVICE_SETTINGS_SAMPLE_RATE,
  DEVICE_SETTINGS_LATENCY_NS,
  TX_PAGE_SIZE,
  RX_PAGE_SIZE
} = require('./constants');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function u16(value) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value & 0xffff);
  return buf;
}

function u32(value) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value >>> 0);
  return buf;
}

function readU16(buf, offset) {
  return offset + 2 <= buf.length ? buf.readUInt16BE(offset) : 0;
}

function readU32(buf, offset) {
  return offset + 4 <= buf.length ? buf.readUInt32BE(offset) : 0;
}

/** Read a NUL-terminated string starting at `start` (0 means "absent"). */
function readCString(buf, start) {
  if (!start || start <= 0 || start >= buf.length) return '';
  const end = buf.indexOf(0x00, start);
  return buf.toString('utf8', start, end === -1 ? buf.length : end);
}

function ipv4ToBuffer(ip) {
  if (!ip || ip.startsWith('127.')) return Buffer.alloc(4);
  const parts = ip.split('.').map((x) => parseInt(x, 10) & 0xff);
  return parts.length === 4 ? Buffer.from(parts) : Buffer.alloc(4);
}

function nameBuffer(name) {
  return Buffer.from(name + '\0', 'ascii');
}

// ---------------------------------------------------------------------------
// ARC (device control, UDP 4440)
// ---------------------------------------------------------------------------

function arcCommand(seq, commandType, args = Buffer.alloc(2), protocolId = PROTOCOL.ARC) {
  return Buffer.concat([
    u16(protocolId),
    u16(args.length + 11),
    u16(seq),
    u16(commandType),
    Buffer.from([0x00, 0x00]),
    args,
    Buffer.from([0x00])
  ]);
}

/**
 * ARC request framed exactly as netaudio frames it: protocol, total length,
 * message ID, opcode, payload — no padding. Newer Dante software (e.g. Dante
 * Virtual Soundcard) is used with this framing; the legacy arcCommand framing
 * above carries extra trailing bytes that older hardware tolerates.
 */
function arcRequest(seq, opcode, payload = Buffer.alloc(2), protocolId = PROTOCOL.ARC_DEFAULT) {
  return Buffer.concat([u16(protocolId), u16(payload.length + 8), u16(seq), u16(opcode), payload]);
}

/** Arguments asking device settings for the configured latency only. */
function latencySettingsArgs() {
  return Buffer.concat([u16(1), u16(DEVICE_SETTINGS_LATENCY_NS)]);
}

/** ARC protocol ID for an mDNS `arcp_vers` value such as "2.8.9" (netaudio's mapping). */
function arcProtocolFromVersion(version) {
  const parts = String(version || '').trim().split('.');
  const num = (p) => (p !== undefined && /^\d+$/.test(p) ? Number(p) : null);
  const major = num(parts[0]);
  const minor = num(parts[1]);
  if (major === null || minor === null) return null;
  const patch = num(parts[2]) ?? 0;
  const id = (Math.min(major, 15) << 12) | (Math.min(minor, 15) << 8) | Math.min(patch, 255);
  let known = PROTOCOL.ARC_DEFAULT;
  for (const candidate of KNOWN_ARC_PROTOCOLS) if (candidate <= id) known = candidate;
  return known;
}

function isModernArc(protocolId) {
  return MODERN_ARC_PROTOCOLS.has(protocolId);
}

/**
 * Modern paged Tx / Rx channel inventory query (opcodes 0x2400 / 0x3400).
 * The first page starts at media selector 1, channel 1; later pages continue
 * from the last record's media type and the next unseen channel ID.
 */
function channelStatusQuery(seq, { protocolId, rx = false, mediaSelector = 1, start = 1 }) {
  const body = Buffer.alloc(24);
  body.writeUInt16BE(1, 6);
  body.writeUInt16BE(mediaSelector, 8);
  body.writeUInt16BE(start, 10);
  body.writeUInt16BE(0, 12); // no end: as many as fit in one page
  if (protocolId === PROTOCOL.ARC_MODERN) Buffer.from('830283060310', 'hex').copy(body, 18);
  const opcode = rx ? ARC_COMMANDS.RX_CHANNEL_STATUS : ARC_COMMANDS.TX_CHANNEL_STATUS;
  return arcRequest(seq, opcode, Buffer.concat([Buffer.alloc(2), body]), protocolId);
}

const MEDIA_TYPES = { 3: 'audio', 4: 'video', 5: 'ancillary' };
const TX_STATUS_RECORDS = { 0x1414: 40, 0x1616: 44 };
// size, source channel ptr, source device ptr, subscription status, receiver status
const RX_STATUS_RECORDS = {
  0x141c: [56, 44, 46, 48, 50],
  0x161c: [56, 48, 50, 52, 54],
  0x161e: [60, 48, 50, 52, 54]
};
const POINTER_TABLE = 18;

function stringAt(buf, pointer, minimum) {
  if (!pointer || pointer < minimum || pointer >= buf.length) return null;
  return readCString(buf, pointer);
}

/** Parse one page of a 0x2400 / 0x3400 reply. Returns null if malformed. */
function parseChannelStatusPage(buf, rx) {
  if (buf.length < POINTER_TABLE) return null;
  const capacity = buf[16];
  const count = buf[17];
  if (count > capacity) return null;
  const tableEnd = POINTER_TABLE + count * 2;
  if (tableEnd > buf.length) return null;

  const channels = [];
  for (let i = 0; i < count; i++) {
    const at = readU16(buf, POINTER_TABLE + i * 2);
    if (at < tableEnd || at + 2 > buf.length) return null;
    const type = readU16(buf, at);
    const layout = rx ? RX_STATUS_RECORDS[type] : TX_STATUS_RECORDS[type];
    if (!layout) return null;
    const size = rx ? layout[0] : layout;
    if (at + size > buf.length) return null;

    const number = readU16(buf, at + 2);
    const mediaType = readU16(buf, at + 6);
    const localId = readU16(buf, at + 8);
    if (!number || !localId || !MEDIA_TYPES[mediaType]) return null;
    const name = stringAt(buf, readU16(buf, at + 20), tableEnd);
    const formatAt = readU16(buf, at + 22);
    const sampleRate = mediaType === 3 && formatAt >= tableEnd && formatAt + 4 <= buf.length ? readU32(buf, formatAt) : null;
    const channel = { number, mediaType, localId, name, factoryName: stringAt(buf, readU16(buf, at + 30), tableEnd), sampleRate };

    if (rx) {
      const [, srcChannel, srcDevice, status, rxStatus] = layout;
      channel.txChannel = stringAt(buf, readU16(buf, at + srcChannel), tableEnd);
      channel.txDevice = stringAt(buf, readU16(buf, at + srcDevice), tableEnd);
      channel.status = readU16(buf, at + status);
      channel.rxStatus = readU16(buf, at + rxStatus);
    }
    channels.push(channel);
  }
  return { capacity, channels };
}

function txNamesArgs(page) {
  const args = Buffer.from('0001000100', 'hex');
  args.writeUInt16BE(page * TX_PAGE_SIZE + 1, 2);
  return args;
}

/** The TX_CHANNELS (canonical names) query pages like the friendly-name query. */
function txChannelsArgs(page) {
  return txNamesArgs(page);
}

/**
 * Rx subscription (ARC 0x3010): point `rxChannel` at `txChannel@txDevice`.
 * Both names are the Dante subscription names (the Tx channel's friendly
 * name if it has one, otherwise its canonical name such as "01").
 * Layout follows Dante Controller: count, rx channel, two string offsets
 * (absolute within the packet, after the 10-byte legacy header), 4 bytes
 * padding, string pool.
 */
function rxSubscribeArgs(rxChannel, txChannelName, txDeviceName) {
  const chan = Buffer.from(String(txChannelName), 'utf8');
  const dev = Buffer.from(String(txDeviceName), 'utf8');
  const chanOffset = 22; // 10-byte header + count(2) + entry(6) + padding(4)
  const devOffset = chanOffset + chan.length + 1;
  return Buffer.concat([u16(1), u16(rxChannel), u16(chanOffset), u16(devOffset), Buffer.alloc(4), chan, Buffer.alloc(1), dev, Buffer.alloc(1)]);
}

/** Clear an Rx subscription: same message with zero string offsets. */
function rxUnsubscribeArgs(rxChannel) {
  return Buffer.concat([u16(1), u16(rxChannel), Buffer.alloc(4), Buffer.alloc(4)]);
}

/**
 * Rx channel page query, byte-identical to netaudio's: a constant 0x0001 then
 * the first channel of the page. (Earlier versions sent the page's channel
 * count instead of 0x0001, which devices reject with result 0x22.)
 */
// eslint-disable-next-line no-unused-vars
function rxChannelsArgs(page, rxCount) {
  const args = Buffer.alloc(5);
  args.writeUInt16BE(1, 0);
  args.writeUInt16BE(page * RX_PAGE_SIZE + 1, 2);
  return args;
}

function pageCount(channelCount, pageSize) {
  return Math.max(1, Math.ceil(channelCount / pageSize));
}

function parseArcReply(buf) {
  if (buf.length < 10 || !ARC_PROTOCOL_IDS.has(readU16(buf, 0))) return null;
  const protocolId = readU16(buf, 0);
  const commandId = readU16(buf, 6);
  const resultCode = readU16(buf, 8);
  if (commandId === ARC_COMMANDS.TX_CHANNEL_STATUS || commandId === ARC_COMMANDS.RX_CHANNEL_STATUS) {
    const ok = resultCode === ARC_RESULTS.SUCCESS || resultCode === ARC_RESULTS.MORE_PAGES;
    const page = ok ? parseChannelStatusPage(buf, commandId === ARC_COMMANDS.RX_CHANNEL_STATUS) : null;
    return { protocolId, commandId, resultCode, ok: !!page, morePages: resultCode === ARC_RESULTS.MORE_PAGES, channels: page ? page.channels : [] };
  }
  const body = parseArcBody(buf, commandId);
  return body ? { protocolId, resultCode, ...body } : null;
}

function parseArcBody(buf, commandId) {
  switch (commandId) {
    case ARC_COMMANDS.CHANNEL_COUNTS:
      if (buf.length < 16) return null;
      return { commandId, txCount: buf[13], rxCount: buf[15] };

    case ARC_COMMANDS.DEVICE_NAME:
      return { commandId, name: readCString(buf, 10) };

    case ARC_COMMANDS.TX_FRIENDLY_NAMES: {
      const count = Math.min(buf[11] || 0, TX_PAGE_SIZE);
      const channels = [];
      for (let i = 0; i < count; i++) {
        const rec = 12 + 6 * i;
        const number = readU16(buf, rec + 2);
        if (number > 0) channels.push({ number, name: readCString(buf, readU16(buf, rec + 4)) });
      }
      return { commandId, channels };
    }

    case ARC_COMMANDS.TX_CHANNELS: {
      // 8-byte records: number u16 @0, sample-rate pointer @4, canonical-name pointer @6.
      const count = Math.min(buf[11] || 0, TX_PAGE_SIZE);
      const channels = [];
      for (let i = 0; i < count; i++) {
        const rec = 12 + 8 * i;
        const number = readU16(buf, rec);
        if (number > 0) channels.push({ number, canonicalName: readCString(buf, readU16(buf, rec + 6)) });
      }
      return { commandId, channels };
    }

    case ARC_COMMANDS.RX_CHANNELS: {
      const count = Math.min(buf[11] || 0, RX_PAGE_SIZE);
      const channels = [];
      for (let i = 0; i < count; i++) {
        const rec = 12 + 20 * i;
        const number = readU16(buf, rec);
        if (number <= 0) continue;
        channels.push({
          number,
          txChannel: readCString(buf, readU16(buf, rec + 6)) || null,
          txDevice: readCString(buf, readU16(buf, rec + 8)) || null,
          name: readCString(buf, readU16(buf, rec + 10)),
          rxStatus: readU16(buf, rec + 12),
          status: readU16(buf, rec + 14)
        });
      }
      return { commandId, channels };
    }

    case ARC_COMMANDS.DEVICE_SETTINGS: {
      // Body (after the 10-byte header): [?, count, (infoCode u16, pointer u16) x count].
      // Codes with the high bit set point at a u32 value elsewhere in the reply.
      const count = buf[11] || 0;
      let sampleRate = null;
      let latencyNs = null;
      for (let i = 0; i < count; i++) {
        const rec = 12 + 4 * i;
        if (rec + 4 > buf.length) break;
        const code = buf.readUInt16BE(rec);
        const at = buf.readUInt16BE(rec + 2);
        if (code === DEVICE_SETTINGS_SAMPLE_RATE) sampleRate = readU32(buf, at);
        else if (code === DEVICE_SETTINGS_LATENCY_NS && at + 4 <= buf.length) latencyNs = readU32(buf, at) || null;
      }
      return { commandId, sampleRate, latencyNs };
    }

    default:
      return { commandId };
  }
}

// ---------------------------------------------------------------------------
// Settings / info (UDP 8700 + 8702, multicast 224.0.0.231)
// ---------------------------------------------------------------------------

function settingsCommand(seq, mac, commandType, args = Buffer.alloc(2), revision = null) {
  return Buffer.concat([
    u16(PROTOCOL.SETTINGS),
    u16(args.length + 28),
    u16(seq),
    Buffer.from('2a84', 'hex'),
    mac,
    Buffer.from('0000', 'hex'),
    revision === null ? AUDINATE_MAGIC : Buffer.concat([AUDINATE_MAGIC.subarray(0, 8), u16(revision)]),
    u16(commandType),
    args
  ]);
}

// Read-only queries for the Device Info tab, in the forms netaudio sends them.

/** Manufacturer, product name and product version. */
function makeModelQuery(seq, mac) {
  return settingsCommand(seq, mac, SETTINGS_MESSAGES.MAKE_MODEL_CONTROL, Buffer.alloc(4), 0x0731);
}

/** Dante module model, firmware, hardware and boot versions. */
function danteModelQuery(seq, mac) {
  return settingsCommand(seq, mac, SETTINGS_MESSAGES.DANTE_MODEL_CONTROL, Buffer.alloc(4), 0x0731);
}

/** Per-port link speed, traffic and error counters. */
function interfaceStatsQuery(seq, mac) {
  return settingsCommand(seq, mac, SETTINGS_MESSAGES.INTERFACE_STATS_CONTROL, Buffer.alloc(6), 0x073a);
}

/** Redundant / Switched mode, for devices whose interface status does not say. */
function switchConfigQuery(seq, mac) {
  const args = Buffer.alloc(8);
  args.writeUInt32BE(100, 0);
  return settingsCommand(seq, mac, SETTINGS_MESSAGES.SWITCH_CONTROL, args, 0x073a);
}

/** Whether the device runs in AES67 (RTP) mode. */
function aes67Query(seq, mac) {
  const args = Buffer.alloc(8);
  args.writeUInt32BE(100, 0);
  return settingsCommand(seq, mac, SETTINGS_MESSAGES.AES67_CONTROL, args, 0x073a);
}

/** NUL-terminated printable text in a fixed-width field, or null. */
function fieldString(buf, start, end) {
  if (start >= buf.length) return null;
  const field = buf.subarray(start, Math.min(end, buf.length));
  const nul = field.indexOf(0);
  const text = field.subarray(0, nul === -1 ? field.length : nul).toString('utf8').trim();
  // eslint-disable-next-line no-control-regex
  return text && !/[\u0000-\u001f\ufffd]/.test(text) ? text : null;
}

/** "major.minor.patch[.build]" from a packed version word (8.8.16 bits), or null when unset. */
function versionString(word, fourth = 0) {
  if (!word && !fourth) return null;
  const parts = [word >>> 24, (word >>> 16) & 0xff, word & 0xffff];
  if (fourth) parts.push(fourth);
  return parts.join('.');
}

function redundancyModeForLabel(label) {
  if (label === 'Redundant' || label === 'Split/Redundant') return 'redundant';
  if (label === 'Switched') return 'switched';
  return null;
}

function clockingQuery(seq, mac) {
  return settingsCommand(seq, mac, SETTINGS_MESSAGES.CLOCKING_STATUS, u32(0));
}

/**
 * Clock status refresh as netaudio sends it: a clock *control* record
 * (revision 0x0734, 40 bytes) with every change flag zero, i.e. a pure query.
 * More devices answer this than the plain status request above.
 */
function clockRefreshQuery(seq, mac) {
  const args = Buffer.alloc(36);
  args.writeUInt32BE(100, 0);
  return settingsCommand(seq, mac, SETTINGS_MESSAGES.CLOCKING_CONTROL, args);
}

function interfaceControlQuery(seq, mac) {
  const args = Buffer.alloc(12);
  args.writeUInt32BE(100, 0);
  return settingsCommand(seq, mac, SETTINGS_MESSAGES.INTERFACE_CONTROL, args);
}

function interfaceStatusQuery(seq, mac) {
  return settingsCommand(seq, mac, SETTINGS_MESSAGES.INTERFACE_STATUS, Buffer.alloc(4));
}

/**
 * The per-protocol PTP ports that newer firmware appends to its clock status
 * (layout per the netaudio project, checked against a device in AES67 mode):
 *
 *   ext+32  u16 offset of a vector header { count, -, first record, stride }
 *   record  16 bytes: flags (bit 0 = disabled by the user), number, PTP
 *           version (1 or 2), format, transport (1 multicast, 2 unicast), -,
 *           u32, PTP port state, validity
 *   ext+40  offset and length of a block holding one 4-byte entry per record
 *           (which network interface it is on) and, when long enough, the
 *           PTPv2 priorities.
 *
 * Anything that does not have this exact shape yields no ports rather than a guess.
 */
function parsePtpPorts(payload, revision, ext) {
  const none = { ptpPorts: [], ptpv2Domain: null, ptpv2Priority1: null, ptpv2Priority2: null };
  if (revision < 0x071c || !ext || ext + 36 > payload.length) return none;
  const out = { ...none };
  const flags = readU16(payload, ext + 10);
  if (revision >= 0x0728 && flags & 0x0800) out.ptpv2Domain = payload[ext + 9];

  const vector = readU16(payload, ext + 32);
  if (!readU16(payload, ext + 34) || !vector || vector + 8 > payload.length) return out;
  const count = readU16(payload, vector);
  const first = readU16(payload, vector + 4);
  const stride = readU16(payload, vector + 6);
  if (!count || count > 16 || (stride !== 16 && stride !== 0x1000) || first + count * 16 > payload.length) return out;

  const ports = [];
  for (let i = 0; i < count; i++) {
    const at = first + i * 16;
    const version = payload[at + 4];
    const transport = payload[at + 6];
    if (version !== 1 && version !== 2) return out;
    ports.push({
      version,
      transport: transport === 1 ? 'multicast' : transport === 2 ? 'unicast' : null,
      disabled: Boolean(readU16(payload, at) & 1),
      state: readU16(payload, at + 12),
      iface: null
    });
  }

  if (revision >= 0x0726 && ext + 44 <= payload.length && readU16(payload, ext + 38) >= 12) {
    const block = readU16(payload, ext + 40);
    const length = readU16(payload, ext + 42);
    if (block && length >= 8 && block + length <= payload.length) {
      const entries = readU16(payload, block);
      const at = readU16(payload, block + 4);
      const size = readU16(payload, block + 6);
      if (entries === count && at && size >= 4 && at + entries * size <= payload.length) {
        for (let i = 0; i < count; i++) {
          if (readU16(payload, at + i * size) & 1) ports[i].iface = readU16(payload, at + i * size + 2);
        }
      }
      if (revision >= 0x0739 && length >= 54) {
        const valid = readU32(payload, block + 36);
        if (valid & 0x08) out.ptpv2Domain = payload[block + 50];
        if (valid & 0x10) out.ptpv2Priority1 = payload[block + 52];
        if (valid & 0x20) out.ptpv2Priority2 = payload[block + 53];
      }
    }
  }
  // Older firmware does not say which interface a port is on: the first
  // multicast port of each PTP version is the primary, the next the secondary.
  if (ports.every((p) => p.iface === null)) {
    const seen = {};
    for (const p of ports) {
      if (p.transport !== 'multicast') continue;
      p.iface = seen[p.version] || 0;
      seen[p.version] = p.iface + 1;
    }
  }
  out.ptpPorts = ports;
  return out;
}

/** Sender MAC carried in settings / heartbeat / metering headers (bytes 8-13). */
function headerMac(buf) {
  const mac = buf.subarray(8, 14);
  if (mac.length < 6 || mac.every((b) => b === 0) || mac.every((b) => b === 0xff)) return null;
  return mac.toString('hex');
}

function parseSettingsReply(buf) {
  if (buf.length < 28 || readU16(buf, 0) !== PROTOCOL.SETTINGS) return null;
  const payload = buf.subarray(24);
  const commandId = readU16(payload, 2);
  const mac = headerMac(buf);

  switch (commandId) {
    case SETTINGS_MESSAGES.CLOCKING_STATUS:
    case SETTINGS_MESSAGES.CLOCKING_CONTROL: {
      if (payload.length < 16) return { commandId };
      // Layout per the netaudio project: clock state 0-3 (none / passive /
      // undisciplined / disciplined), servo 0-6 (faulty / reset / synchronizing /
      // synchronized / unknown / delay reset / none). Revision 0x0100 records have
      // no identities; later ones carry an extension with drift limit and mute flags.
      const hex = (from, to) => (payload.length >= to ? payload.subarray(from, to).toString('hex') : '');
      const revision = readU16(payload, 0);
      const legacy = revision === 0x0100;
      const uuid = legacy ? '' : hex(20, 28);
      const grandmasterUuid = legacy ? '' : hex(36, 44);
      const portCount = payload.length >= (legacy ? 22 : 46) ? readU16(payload, legacy ? 0x14 : 0x2c) : 0;

      // One 4-byte record per network port follows the port count (port 1 =
      // primary, port 2 = secondary), starting with that port's PTP state:
      // 6 = leader (master), 7 = passive, 9 = follower (slave). Seen on a live
      // redundant network: followers report 9/7, the leader 6/6.
      const portStates = [];
      if (!legacy && portCount > 0 && portCount <= 8 && payload.length >= 0x30 + portCount * 4) {
        for (let i = 0; i < portCount; i++) portStates.push(readU16(payload, 0x30 + i * 4));
      }

      let maxDriftPpb = null;
      let muteFlags = null;
      const ext = legacy ? 0 : readU16(payload, 0x2e);
      if (revision >= 0x0400 && ext && ext + 30 <= payload.length) {
        maxDriftPpb = payload.readInt32BE(ext + 4) || null;
        if (revision >= 0x0704) muteFlags = readU16(payload, ext + 28);
      }
      const ptp = parsePtpPorts(payload, revision, ext);

      return {
        commandId,
        mac,
        clock: {
          revision,
          state: readU16(payload, 8),
          servo: readU16(payload, 10),
          source: readU16(payload, 12),
          isPreferred: payload[14] === 1,
          stratum: payload[15],
          frequencyOffsetPpb: payload.length >= 20 ? payload.readInt32BE(16) : null,
          uuid,
          masterUuid: legacy ? '' : hex(28, 36),
          grandmasterUuid,
          isMaster: Boolean(uuid) && uuid === grandmasterUuid,
          numPorts: portCount || null,
          portStates,
          maxDriftPpb,
          muteFlags,
          ...ptp
        }
      };
    }

    case SETTINGS_MESSAGES.INTERFACE_STATUS:
    case SETTINGS_MESSAGES.INTERFACE_CONTROL: {
      if (payload.length < 40) return { commandId };
      const numInterfaces = readU16(payload, 8);
      let secondaryIp = null;
      // Interface records are 28 bytes starting at offset 16 (mode, MAC, IPv4,
      // netmask, DNS, gateway); the second (secondary network) record's IPv4
      // address sits at offset 52.
      if (numInterfaces >= 2 && payload.length >= 68) {
        const ip = Array.from(payload.subarray(52, 56)).join('.');
        if (!ip.startsWith('0.')) secondaryIp = ip;
      }

      const interfaces = [];
      let offset = 16;
      let fixedRecords = numInterfaces >= 1 && numInterfaces <= 8;
      for (let i = 0; fixedRecords && i < numInterfaces; i++) {
        if (offset + 24 > payload.length || readU16(payload, offset) > 3) {
          fixedRecords = false;
          break;
        }
        interfaces.push({
          mac: payload.subarray(offset + 2, offset + 8).toString('hex'),
          ip: Array.from(payload.subarray(offset + 8, offset + 12)).join('.')
        });
        offset += 28;
      }
      // After the records: a flags word whose bit 0 is "running in Redundant
      // mode" and bit 1 "configured for Redundant" (they differ until a reboot).
      // Only trusted when the size/pointer pair before it has the known shape.
      let redundancy = null;
      if (fixedRecords && numInterfaces >= 2 && offset + 2 <= payload.length) {
        const flags = readU16(payload, offset);
        if (readU16(payload, offset - 4) === 24 && readU16(payload, offset - 2) === offset + 4 && (flags & ~3) === 0) {
          redundancy = { mode: flags & 1 ? 'redundant' : 'switched', configured: flags & 2 ? 'redundant' : 'switched' };
        }
      }
      return {
        commandId,
        mac,
        numInterfaces,
        secondaryIp,
        linkSpeedMbps: readU32(payload, 12),
        interfaces: fixedRecords ? interfaces : [],
        redundancy
      };
    }

    case SETTINGS_MESSAGES.SWITCH_STATUS: {
      // A table of 148-byte choices (code, pad, 128-byte label, ...) and the
      // codes of the running and the configured choice.
      if (payload.length < 24) return { commandId, mac };
      const count = readU16(payload, 8);
      const table = readU16(payload, 10);
      if (table < 24 || count > 16 || table + count * 148 > payload.length) return { commandId, mac };
      const modes = new Map();
      for (let i = 0; i < count; i++) {
        const at = table + i * 148;
        modes.set(readU16(payload, at), redundancyModeForLabel(fieldString(payload, at + 4, at + 132)));
      }
      const mode = modes.get(readU16(payload, 20)) || null;
      return { commandId, mac, redundancy: mode ? { mode, configured: modes.get(readU16(payload, 22)) || null } : null };
    }

    case SETTINGS_MESSAGES.INTERFACE_STATS_STATUS: {
      // One group per network port, each pointing at one or more 24-byte
      // records: Tx / Rx bytes per second, Tx / Rx errors, a status word and
      // the link speed in Mbit/s. Pointers are relative to the payload.
      if (payload.length < 12) return { commandId, mac };
      const groups = readU16(payload, 8);
      if (!groups || groups > 8 || 10 + groups * 2 > payload.length) return { commandId, mac };
      const ports = [];
      for (let g = 0; g < groups; g++) {
        const at = readU16(payload, 10 + g * 2);
        if (at + 2 > payload.length) return { commandId, mac };
        const records = readU16(payload, at);
        if (!records || records > 8 || at + 2 + records * 2 > payload.length) return { commandId, mac };
        let chosen = null;
        for (let r = 0; r < records; r++) {
          const rec = readU16(payload, at + 2 + r * 2);
          if (rec + 24 > payload.length) return { commandId, mac };
          // The record whose status word has no high bits is the port itself.
          if (chosen === null || (readU32(payload, chosen + 16) & 0xffff0000 && !(readU32(payload, rec + 16) & 0xffff0000))) chosen = rec;
        }
        ports.push({
          txBitsPerSec: readU32(payload, chosen) * 8,
          rxBitsPerSec: readU32(payload, chosen + 4) * 8,
          txErrors: readU32(payload, chosen + 8),
          rxErrors: readU32(payload, chosen + 12),
          speedMbps: readU32(payload, chosen + 20)
        });
      }
      return { commandId, mac, portStats: ports };
    }

    case SETTINGS_MESSAGES.AES67_STATUS: {
      // One byte: bit 0 = running in AES67 mode, bit 1 = configured for it
      // (they differ until the device is rebooted).
      if (payload.length < 10 || payload[9] > 3) return { commandId, mac };
      return { commandId, mac, aes67: { enabled: Boolean(payload[9] & 1), configured: Boolean(payload[9] & 2) } };
    }

    case SETTINGS_MESSAGES.DANTE_MODEL_STATUS: {
      if (payload.length < 0x1c) return { commandId, mac };
      const revision = readU16(payload, 0);
      const fourth = (at) => (revision >= 0x0701 && payload.length >= at + 4 ? readU32(payload, at) : 0);
      return {
        commandId,
        mac,
        danteModel: {
          firmwareVersion: versionString(readU32(payload, 0x08), fourth(0x28)),
          hardwareVersion: versionString(readU32(payload, 0x0c), fourth(0x2c)),
          romVersion: revision >= 0x0704 && payload.length >= 0x34 ? versionString(readU32(payload, 0x30)) : null,
          // The fastest link the module is built for (100 on Ultimo, 1000 on Brooklyn).
          preferredLinkSpeedMbps: revision >= 0x0200 && payload.length >= 0x24 ? readU32(payload, 0x20) || null : null,
          modelId: fieldString(payload, 0x14, 0x1c),
          modelName: revision >= 0x070c ? fieldString(payload, 0x40, 0xc0) : null
        }
      };
    }

    case SETTINGS_MESSAGES.MAKE_MODEL_STATUS: {
      if (payload.length < 0x28) return { commandId, mac };
      const revision = readU16(payload, 0);
      const named = revision >= 0x0701;
      const word = revision >= 0x0704 && payload.length >= 0x138 ? readU32(payload, 0x134) : 0;
      return {
        commandId,
        mac,
        makeModel: {
          manufacturer: (named && fieldString(payload, 0x34, 0xb4)) || fieldString(payload, 0x08, 0x10),
          modelName: (named && fieldString(payload, 0xb4, 0x134)) || fieldString(payload, 0x10, 0x18),
          productVersion: (revision >= 0x0712 && fieldString(payload, 0x138, payload.length)) || versionString(word)
        }
      };
    }

    default:
      return { commandId, mac };
  }
}

// ---------------------------------------------------------------------------
// CMC (UDP 8800)
// ---------------------------------------------------------------------------

function cmcSettingsPortQuery(seq, mac) {
  return Buffer.concat([u16(PROTOCOL.CMC), u16(20), u16(seq), u16(0x1001), u16(0x0000), u16(0x3520), mac, u16(0x0000)]);
}

function parseCmcReply(buf) {
  if (readU16(buf, 0) !== PROTOCOL.CMC) return null;
  const commandId = readU16(buf, 6);
  if (commandId === 0x1001 && buf.length >= 30) return { commandId, settingsPort: readU16(buf, 28) };
  return { commandId };
}

/**
 * Ask a device to stream its meters to `subscriberIp:port` (CMC 0x3010).
 * Layout matches Dante Controller's own request (as documented by the
 * public-domain netaudio project). Each subscriber is keyed by its MAC, so
 * this coexists with any number of Dante Controller instances.
 */
function cmcMeteringRequest(seq, { deviceName, subscriberIp, mac, port }) {
  let name = nameBuffer(deviceName);
  if (name.length % 2) name = Buffer.concat([name, Buffer.alloc(1)]);
  const nameField = name.length + 0x0a;
  const channelField = name.length + 0x0c;

  const body = Buffer.concat([
    u16(0x3010),
    u16(0),
    u16(0),
    mac,
    u16(0),
    u16(4),
    u16(nameField),
    u16(2),
    u16(channelField),
    u16(0x000a),
    name,
    u16(1),
    u16(1),
    u16(channelField + 4),
    u16(1),
    u16(port),
    // destinations (16 bytes) — all zero means "stop"
    u16(1),
    u16(0),
    ipv4ToBuffer(subscriberIp),
    u16(port),
    Buffer.alloc(6),
    u16(port),
    Buffer.alloc(2)
  ]);
  return Buffer.concat([u16(PROTOCOL.CMC), u16(body.length + 6), u16(seq), body]);
}

function cmcMeteringStop(seq, { deviceName, mac, port }) {
  const pkt = cmcMeteringRequest(seq, { deviceName, subscriberIp: null, mac, port });
  pkt.fill(0, pkt.length - 16);
  return pkt;
}

// ---------------------------------------------------------------------------
// Heartbeats (multicast 224.0.0.233:8708)
// ---------------------------------------------------------------------------

/**
 * Sum the per-flow u32 counters in a heartbeat monitoring record (e.g. late
 * packets). Layout per netaudio: [len, type, subheaderLen, payloadLen, ...];
 * payload = count, first index, offset-of-counters (from record start).
 */
function sumMonitoringCounters(record) {
  if (record.length < 8) return null;
  const payload = 8 + record.readUInt16BE(4);
  if (payload + 6 > record.length) return null;
  const count = record.readUInt16BE(payload);
  const countersAt = record.readUInt16BE(payload + 4);
  if (!count || countersAt < payload || countersAt + count * 4 > record.length) return null;
  let total = 0;
  for (let i = 0; i < count; i++) total += record.readUInt32BE(countersAt + i * 4);
  return total;
}

function parseHeartbeat(buf) {
  if (readU16(buf, 0) !== PROTOCOL.HEARTBEAT || readCString(buf, 16) !== 'Audinate') return null;

  const result = { mac: headerMac(buf), ports: null, levels: null, clockOffsetPpb: null, latePackets: null };
  let offset = 32;
  while (offset + 4 <= buf.length) {
    const recLen = buf.readUInt16BE(offset);
    const recType = buf.readUInt16BE(offset + 2);
    if (recLen < 4 || offset + recLen > buf.length) break;

    if (recType === HEARTBEAT_RECORDS.PORT_STATUS && recLen >= 52) {
      const numPorts = buf.readUInt16BE(offset + 16);
      const p2 = offset + 36;
      result.ports = {
        numPorts,
        secondaryLinkUp: numPorts >= 2 ? buf.readUInt32BE(p2) !== 0 || buf.readUInt32BE(p2 + 4) !== 0 : null
      };
    } else if (recType === HEARTBEAT_RECORDS.CLOCK_OFFSET && recLen >= 16 && buf.readUInt16BE(offset + 4) === 4) {
      result.clockOffsetPpb = buf.readInt32BE(offset + 12);
    } else if (recType === HEARTBEAT_RECORDS.LATE_PACKETS) {
      const total = sumMonitoringCounters(buf.subarray(offset, offset + recLen));
      if (total !== null) result.latePackets = (result.latePackets || 0) + total;
    } else if (recType === HEARTBEAT_RECORDS.SIGNAL_PRESENCE && recLen >= 22) {
      const txCount = buf.readUInt16BE(offset + 12);
      const txFirst = buf.readUInt16BE(offset + 14);
      const rxCount = buf.readUInt16BE(offset + 16);
      const rxFirst = buf.readUInt16BE(offset + 18);
      const vecStart = offset + buf.readUInt16BE(offset + 20);
      if (vecStart + txCount + rxCount <= offset + recLen) {
        result.levels = {
          txFirst: txFirst + 1,
          tx: Array.from(buf.subarray(vecStart, vecStart + txCount)),
          rxFirst: rxFirst + 1,
          rx: Array.from(buf.subarray(vecStart + txCount, vecStart + txCount + rxCount))
        };
      }
    }
    offset += recLen;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Metering stream (UDP 8751)
// ---------------------------------------------------------------------------

/**
 * Metering frame: 0xFFFF, length, seq, 0, sender EUI-64 (8), "Audinate",
 * then version (1-2: u8 counts at 25/26, levels at 27; 3: u16 counts at
 * 26/28, levels at 30), Tx levels, Rx levels.
 */
function parseMeteringPacket(buf) {
  if (buf.length < 27 || readU16(buf, 0) !== 0xffff || readU16(buf, 2) !== buf.length) return null;
  if (buf.toString('latin1', 16, 24) !== 'Audinate') return null;

  const version = buf[24];
  let numTx;
  let numRx;
  let start;
  if (version === 1 || version === 2) {
    numTx = buf[25];
    numRx = buf[26];
    start = 27;
  } else if (version === 3 && buf.length >= 30) {
    numTx = readU16(buf, 26);
    numRx = readU16(buf, 28);
    start = 30;
  } else {
    return null;
  }
  if (start + numTx + numRx > buf.length) return null;
  return {
    mac: headerMac(buf),
    tx: Array.from(buf.subarray(start, start + numTx)),
    rx: Array.from(buf.subarray(start + numTx, start + numTx + numRx))
  };
}

module.exports = {
  readCString,
  pageCount,
  arcCommand,
  arcRequest,
  arcProtocolFromVersion,
  isModernArc,
  channelStatusQuery,
  txNamesArgs,
  txChannelsArgs,
  rxSubscribeArgs,
  rxUnsubscribeArgs,
  rxChannelsArgs,
  latencySettingsArgs,
  parseArcReply,
  settingsCommand,
  clockingQuery,
  clockRefreshQuery,
  interfaceControlQuery,
  interfaceStatusQuery,
  makeModelQuery,
  danteModelQuery,
  interfaceStatsQuery,
  switchConfigQuery,
  aes67Query,
  parseSettingsReply,
  cmcSettingsPortQuery,
  parseCmcReply,
  cmcMeteringRequest,
  cmcMeteringStop,
  parseHeartbeat,
  parseMeteringPacket
};
