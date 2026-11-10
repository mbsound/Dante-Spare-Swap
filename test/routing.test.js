'use strict';

/**
 * Subscription packets and the engine's routing helpers, against simulated
 * device replies (no sockets).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const packets = require('../lib/dante/packets');
const { DanteEngine } = require('../lib/dante/engine');
const { IdentityResolver, DanteDatabase } = require('../lib/dante/identity');
const { ARC_COMMANDS } = require('../lib/dante/constants');

function makeEngine() {
  const database = new DanteDatabase([]);
  database.refresh = () => [];
  const engine = new DanteEngine({ identity: new IdentityResolver({ database }) });
  engine.sent = [];
  engine.send = (sock, buf, port, host) => engine.sent.push({ sock, port, host, buf });
  engine.scheduleRxRefresh = () => {};
  return engine;
}

const from = (address) => ({ address, port: 4440 });

function arcReply(commandId, size) {
  const buf = Buffer.alloc(size);
  buf.writeUInt16BE(0x2729, 0);
  buf.writeUInt16BE(commandId, 6);
  return buf;
}
const nameReply = (name) => Buffer.concat([arcReply(ARC_COMMANDS.DEVICE_NAME, 10), Buffer.from(name + '\0')]);
function countsReply(tx, rx) {
  const buf = arcReply(ARC_COMMANDS.CHANNEL_COUNTS, 16);
  buf[13] = tx;
  buf[15] = rx;
  return buf;
}
function txNamesReply(names) {
  const buf = arcReply(ARC_COMMANDS.TX_FRIENDLY_NAMES, 12 + 6 * names.length);
  buf[11] = names.length;
  const strings = [];
  let offset = buf.length;
  names.forEach((name, i) => {
    buf.writeUInt16BE(i + 1, 12 + 6 * i + 2);
    buf.writeUInt16BE(offset, 12 + 6 * i + 4);
    strings.push(Buffer.from(name + '\0'));
    offset += name.length + 1;
  });
  return Buffer.concat([buf, ...strings]);
}
function txChannelsReply(names) {
  const buf = arcReply(ARC_COMMANDS.TX_CHANNELS, 12 + 8 * names.length);
  buf[11] = names.length;
  const strings = [];
  let offset = buf.length;
  names.forEach((name, i) => {
    buf.writeUInt16BE(i + 1, 12 + 8 * i);
    buf.writeUInt16BE(offset, 12 + 8 * i + 6);
    strings.push(Buffer.from(name + '\0'));
    offset += name.length + 1;
  });
  return Buffer.concat([buf, ...strings]);
}
function rxReply(subs) {
  const buf = arcReply(ARC_COMMANDS.RX_CHANNELS, 12 + 20 * subs.length);
  buf[11] = subs.length;
  const strings = [];
  let offset = buf.length;
  const str = (s) => {
    const at = offset;
    strings.push(Buffer.from(s + '\0'));
    offset += s.length + 1;
    return at;
  };
  subs.forEach((s, i) => {
    const rec = 12 + 20 * i;
    buf.writeUInt16BE(i + 1, rec);
    buf.writeUInt16BE(s.txChannel ? str(s.txChannel) : 0, rec + 6);
    buf.writeUInt16BE(s.txDevice ? str(s.txDevice) : 0, rec + 8);
    buf.writeUInt16BE(str(s.name), rec + 10);
    buf.writeUInt16BE(s.status, rec + 14);
  });
  return Buffer.concat([buf, ...strings]);
}

test('subscription packet matches the Dante Controller layout', () => {
  const args = packets.rxSubscribeArgs(3, '01', 'Stage-Rx');
  const pkt = packets.arcCommand(1, ARC_COMMANDS.RX_SUBSCRIBE, args);
  assert.equal(pkt.toString('hex'), '2729002300013010000000010003001600190000000030310053746167652d52780000');
  // string offsets are absolute within the packet
  assert.equal(packets.readCString(pkt, pkt.readUInt16BE(14)), '01');
  assert.equal(packets.readCString(pkt, pkt.readUInt16BE(16)), 'Stage-Rx');
});

test('unsubscribe packet has zeroed string offsets', () => {
  const pkt = packets.arcCommand(7, ARC_COMMANDS.RX_SUBSCRIBE, packets.rxUnsubscribeArgs(12));
  assert.equal(pkt.toString('hex'), '272900170007301000000001000c000000000000000000');
});

test('TX_CHANNELS replies yield canonical names', () => {
  const reply = packets.parseArcReply(txChannelsReply(['01', '02']));
  assert.deepEqual(reply.channels, [
    { number: 1, canonicalName: '01' },
    { number: 2, canonicalName: '02' }
  ]);
});

test('engine resolves the subscription name: friendly name, else canonical', () => {
  const engine = makeEngine();
  engine.handleArc(nameReply('RF-Rack'), from('169.254.1.10'));
  engine.handleArc(countsReply(2, 0), from('169.254.1.10'));
  engine.handleArc(txChannelsReply(['01', '02']), from('169.254.1.10'));
  engine.handleArc(txNamesReply(['Vocal 1', '']), from('169.254.1.10'));
  assert.equal(engine.txSubscriptionName('RF-Rack', 1), 'Vocal 1');
  assert.equal(engine.txSubscriptionName('rf-rack', 2), '02');
  assert.equal(engine.txSubscriptionName('Unknown', 5), '05');
  const [dev] = engine.getDevices();
  assert.equal(dev.tx.channels[1].name, 'Vocal 1');
  assert.equal(dev.tx.channels[2].name, '02');
  assert.equal(dev.tx.channels[2].subscriptionName, '02');
});

test('subscribe sends 0x3010 to the receiver with the resolved names', () => {
  const engine = makeEngine();
  engine.handleArc(nameReply('RF-Rack'), from('169.254.1.10'));
  engine.handleArc(countsReply(2, 0), from('169.254.1.10'));
  engine.handleArc(txNamesReply(['Vocal 1', 'Spare A']), from('169.254.1.10'));
  engine.handleArc(nameReply('Console'), from('169.254.1.20'));
  engine.handleArc(countsReply(0, 8), from('169.254.1.20'));
  engine.sent = [];

  const res = engine.subscribe({ rxDevice: 'Console', rxChannel: 5, txDevice: 'RF-Rack', txChannel: 2 });
  assert.equal(res.ok, true);
  assert.equal(res.txChannelName, 'Spare A');
  const sent = engine.sent.find((s) => s.buf.readUInt16BE(6) === 0x3010);
  assert.ok(sent);
  assert.equal(sent.host, '169.254.1.20');
  assert.equal(sent.port, 4440);
  assert.equal(sent.buf.readUInt16BE(12), 5);
  assert.ok(sent.buf.includes(Buffer.from('Spare A\0')));
  assert.ok(sent.buf.includes(Buffer.from('RF-Rack\0')));

  assert.equal(engine.subscribe({ rxDevice: 'Console', rxChannel: 9, txDevice: 'RF-Rack', txChannel: 1 }).ok, false);
  assert.equal(engine.subscribe({ rxDevice: 'Nope', rxChannel: 1, txDevice: 'RF-Rack', txChannel: 1 }).ok, false);

  engine.sent = [];
  assert.equal(engine.unsubscribe({ rxDevice: 'Console', rxChannel: 5 }).ok, true);
  const clr = engine.sent[0];
  assert.equal(clr.buf.readUInt16BE(6), 0x3010);
  assert.equal(clr.buf.readUInt16BE(14), 0);
  assert.equal(clr.buf.readUInt16BE(16), 0);
});

test('receiversOf finds every Rx fed by a Tx path, by friendly or canonical name', () => {
  const engine = makeEngine();
  engine.handleArc(nameReply('RF-Rack'), from('169.254.1.10'));
  engine.handleArc(countsReply(2, 0), from('169.254.1.10'));
  engine.handleArc(txChannelsReply(['01', '02']), from('169.254.1.10'));
  engine.handleArc(txNamesReply(['Vocal 1', '']), from('169.254.1.10'));
  engine.handleArc(nameReply('Console'), from('169.254.1.20'));
  engine.handleArc(countsReply(0, 3), from('169.254.1.20'));
  engine.handleArc(
    rxReply([
      { name: 'In 1', txDevice: 'RF-Rack', txChannel: 'Vocal 1', status: 9 },
      { name: 'In 2', txDevice: 'rf-rack', txChannel: '02', status: 9 },
      { name: 'In 3', txDevice: null, txChannel: null, status: 0 }
    ]),
    from('169.254.1.20')
  );
  assert.deepEqual(engine.receiversOf('RF-Rack', 1), [{ device: 'Console', ip: '169.254.1.20', channel: 1 }]);
  assert.deepEqual(engine.receiversOf('RF-Rack', 2), [{ device: 'Console', ip: '169.254.1.20', channel: 2 }]);
  assert.deepEqual(engine.receiversOf('RF-Rack', 3), []);
  const st = engine.rxState('Console', 3);
  assert.equal(st.subscribedDevice, null);
  assert.equal(engine.rxState('Console', 1).connected, true);
});
