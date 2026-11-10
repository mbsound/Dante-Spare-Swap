'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFrame, parseSample, ShureReceiver } = require('../lib/rf/shure');
const { SscUdpReceiver } = require('../lib/rf/ssc1');
const { SscRestReceiver } = require('../lib/rf/ssc2');
const { parseAttrRply, buildSrvRqst } = require('../lib/rf/discovery');
const { ShowStore, ShowError } = require('../lib/show/store');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

test('Shure SAMPLE frames decode per the AD4 / ANX4 command-strings reference', () => {
  const std = parseSample('005 031 102 102 BB 31 086 31 065');
  assert.deepEqual(std, { quality: 100, afPeak: -18, afRms: -18, antennas: ['B', 'B'], rssi: [-34, -55] });
  const quad = parseSample('003 031 100 090 BBBB 31 083 31 068 31 069 31 072');
  assert.equal(quad.quality, 60);
  assert.deepEqual(quad.rssi, [-37, -52, -51, -48]);
  const fdc = parseSample('005 031 102 102 BB 31 082 31 060 BB 31 090 31 050');
  assert.deepEqual(fdc.rssi, [-30, -60], 'FD-C keeps the stronger of the two frequencies');
  const rep = parseFrame('< REP 12 TX_BATT_MINS 00125 >');
  assert.deepEqual(rep, { channel: 12, prop: 'TX_BATT_MINS', args: ['00125'] });
  assert.equal(parseFrame('< REP ERR >').prop, 'ERR');
  assert.deepEqual(parseFrame('< REP 1 CHAN_NAME {Lead Vox                       } >').args, ['Lead Vox']);
});

test('Shure client: connects, learns channels, starts meters and decodes reports', async (t) => {
  const seen = [];
  const server = net.createServer((sock) => {
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', (d) => {
      buf += d;
      let m;
      while ((m = /<([^>]*)>/.exec(buf))) {
        buf = buf.slice(m.index + m[0].length);
        const line = m[1].trim();
        seen.push(line);
        if (line === 'GET MODEL') sock.write('< REP MODEL {AD4Q-A                          } >');
        else if (line === 'GET DEVICE_ID') sock.write('< REP DEVICE_ID {RackA                          } >');
        else if (line === 'GET AVAILABLE_CHANNELS') sock.write('< REP ERR >');
        else if (/^GET 1 CHAN_NAME$/.test(line)) sock.write('< REP 1 CHAN_NAME {Lead Vox                       } >');
        else if (/^GET 1 FREQUENCY$/.test(line)) sock.write('< REP 1 FREQUENCY 0578350 >');
        else if (/^GET 1 TX_BATT_CHARGE_PERCENT$/.test(line)) sock.write('< REP 1 TX_BATT_CHARGE_PERCENT 088 >');
        else if (/^GET 1 TX_MODEL$/.test(line)) sock.write('< REP 1 TX_MODEL ADX2 >');
        else if (/^SET (\d) METER_RATE/.test(line)) {
          sock.write(`< REP ${line.split(' ')[1]} METER_RATE 00200 >`);
          if (line.startsWith('SET 1')) sock.write('< SAMPLE 1 ALL 005 031 102 098 BX 31 086 00 040 >< REP 1 INTERFERENCE_STATUS DETECTED >');
        }
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new ShureReceiver({ host: '127.0.0.1', port: server.address().port, log: quiet });
  t.after(() => {
    client.stop();
    server.close();
  });
  client.start();
  await new Promise((r) => setTimeout(r, 400));
  const snap = client.snapshot();
  assert.equal(snap.online, true);
  assert.equal(snap.model, 'AD4Q-A');
  assert.deepEqual(Object.keys(snap.channels), ['1', '2', '3', '4'], 'AD4Q inferred as four channels');
  const ch = snap.channels[1];
  assert.equal(ch.name, 'Lead Vox');
  assert.equal(ch.frequencyKHz, 578350);
  assert.equal(ch.battery.percent, 88);
  assert.equal(ch.txModel, 'ADX2');
  assert.equal(ch.af, -22);
  assert.deepEqual(ch.rssi, [-34, -80]);
  assert.deepEqual(ch.antennas, ['B', 'X']);
  assert.deepEqual(ch.warnings, ['Interference']);
  assert.ok(seen.includes('SET 4 METER_RATE 00200'));
});

test('SSC v1: notifications map onto channels (EW-DX layout)', () => {
  const c = new SscUdpReceiver({ host: '127.0.0.1', log: quiet, brand: 'sennheiser-ewdx-v1' });
  c.applyTree({ m: { rx1: { af: -24.5, rssi: -61, rsqi: 87, divi: 2 } } });
  c.applyTree({ rx1: { name: 'VOX1', frequency: 520000, mute: false, warnings: ['AfPeak'] }, mates: { tx1: { name: 'SK-1', type: 'SKM', battery: { gauge: 65, lifetime: 312, type: 'Battery' } } } });
  const ch = c.snapshot().channels[1];
  assert.equal(ch.af, -24.5);
  assert.deepEqual(ch.rssi, [null, -61]);
  assert.deepEqual(ch.antennas, ['X', 'B']);
  assert.equal(ch.quality, 87);
  assert.equal(ch.name, 'VOX1');
  assert.equal(ch.frequencyKHz, 520000);
  assert.equal(ch.txName, 'SK-1');
  assert.equal(ch.battery.minutes, 312);
  assert.deepEqual(ch.warnings, ['AfPeak']);
  // subscription trees carry the lifetime
  const sent = [];
  c.socket = { send: (buf) => sent.push(JSON.parse(buf.toString())), close() {} };
  c.subscribeAll();
  assert.equal(sent[0].osc.state.subscribe[0]['#'].lifetime, 60);
  assert.ok(sent[0].osc.state.subscribe[0].m.rx1.rssi === null);
  assert.ok(sent[1].osc.state.subscribe[0].mates.tx1.battery.gauge === null);
});

test('SSCv2: path notifications map onto EW-DX channels (0-based ids) and Spectera devices', () => {
  const c = new SscRestReceiver({ host: '127.0.0.1', log: quiet, brand: 'sennheiser-ewdx' });
  c.applyPaths({
    '/api/channel/0': { name: 'VOX1', mute: true },
    '/api/channel/0/level': { value: -30 },
    '/api/channel/0/diversityIndicator': { value: 1 },
    '/api/channel/0/signalStrengthIndicator': { value: -55 },
    '/api/channel/0/signalQualityIndicator': { value: 92 },
    '/api/channel/0/warnings': ['LowSignal'],
    '/api/transmitters/0/battery': { gauge: 40, lifetime: 100, type: 'Battery' },
    '/api/transmitters/0': { type: 'EW_DX_SK', name: 'SK1' },
    '/api/rf/channels/0': { frequency: 606000 }
  });
  const ch = c.snapshot().channels[1];
  assert.equal(ch.name, 'VOX1');
  assert.equal(ch.af, -30);
  assert.deepEqual(ch.rssi, [-55, null]);
  assert.equal(ch.quality, 92);
  assert.equal(ch.battery.percent, 40);
  assert.equal(ch.txModel, 'EW_DX_SK');
  assert.equal(ch.frequencyKHz, 606000);
  assert.deepEqual(ch.warnings, ['LowSignal']);
  assert.ok(c.profile.subscribe(4).includes('/api/channel/3/level'));

  const s = new SscRestReceiver({ host: '127.0.0.1', log: quiet, brand: 'sennheiser-spectera' });
  s.applyPaths({
    '/api/mts/paired/all': [{ name: 'SEK', rfChannelId: 1, batteryFillLevel: 100, batteryRuntime: 65535, batteryLow: false, micLqi: 4, rssi: -42, dominantAntenna: 'd', micAudiolinkId: 39, state: 'Connected' }],
    '/api/rf/channels': [{ rfChannelId: 1, frequency: 522000 }]
  });
  const d = s.snapshot().channels[1];
  assert.equal(d.name, 'SEK');
  assert.equal(d.quality, 80);
  assert.deepEqual(d.rssi, [-42, -42]);
  assert.equal(d.battery.percent, 100);
  assert.equal(d.battery.minutes, null);
  assert.equal(d.frequencyKHz, 522000);
});

test('SLP: a service request is well-formed and an AttrRply from a Shure unit is parsed', () => {
  const req = buildSrvRqst(0x1234);
  assert.equal(req[0], 2);
  assert.equal(req[1], 1);
  assert.equal(req.readUInt16BE(10), 0x1234);
  const attrs = '(cid=0E8B91F0-AAAA-BBBB-CCCC-DDDDEEEEFFFF),(acn-fctn=AD4Q_RX),(acn-uacn=Rack A),(csl-esta.dmp=esta.sdt/192.168.1.50:57383;esta.dmp/d)';
  const lang = Buffer.from('en');
  const body = Buffer.concat([Buffer.alloc(2), Buffer.from([attrs.length >> 8, attrs.length & 0xff]), Buffer.from(attrs)]);
  const header = Buffer.alloc(14 + lang.length);
  header[0] = 2;
  header[1] = 7;
  header.writeUInt16BE(lang.length, 12);
  lang.copy(header, 14);
  const r = parseAttrRply(Buffer.concat([header, body]));
  assert.deepEqual(r, { fctn: 'AD4Q_RX', name: 'Rack A', ip: '192.168.1.50' });
});

test('store: receivers are validated, passwords kept on edit and masked in the public snapshot; links follow deletes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-rf-'));
  const store = new ShowStore({ dataDir: dir, log: quiet });
  store.load();
  const r = store.addReceiver({ brand: 'sennheiser-ewdx', name: 'EM4', host: '10.0.0.5', password: 'pw' });
  assert.equal(r.password, 'pw');
  store.updateReceiver(r.id, { name: 'EM4 FOH' });
  assert.equal(store.receiver(r.id).password, 'pw', 'password survives an edit without one');
  store.updateReceiver(r.id, { password: '' });
  assert.equal(store.receiver(r.id).password, '');
  assert.throws(() => store.addReceiver({ brand: 'nope', host: '1.2.3.4' }), ShowError);
  assert.throws(() => store.addReceiver({ brand: 'shure-ad', host: '' }), ShowError);
  const ch = store.addChannel({ name: 'A', rf: { receiverId: r.id, channel: 2 }, view: 'all' });
  assert.deepEqual(ch.rf, { receiverId: r.id, channel: 2 });
  assert.equal(ch.view, 'all');
  assert.equal(store.addChannel({ name: 'B', view: 'bogus' }).view, 'dante');
  const pub = store.publicSnapshot();
  assert.equal(pub.receivers[0].password, undefined);
  assert.equal(pub.receivers[0].hasPassword, false);
  store.removeReceiver(r.id);
  assert.equal(store.channel(ch.id).rf, null);
});
