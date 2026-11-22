'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ShowStore, ShowError } = require('../lib/show/store');
const { SwapController } = require('../lib/show/swap');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-'));
  const store = new ShowStore({ dataDir: dir, log: quiet });
  store.load();
  return { store, dir };
}

/** Fake engine: a routing table keyed by "rxDevice|rxCh" -> { device, channel } */
function fakeEngine({ txNames = {} } = {}) {
  const routes = new Map();
  const log = [];
  const subName = (dev, ch) => (txNames[`${dev}|${ch}`] !== undefined ? txNames[`${dev}|${ch}`] : String(ch).padStart(2, '0'));
  return {
    routes,
    log,
    patch(rxDevice, rxChannel, txDevice, txChannel) {
      routes.set(`${rxDevice.toLowerCase()}|${rxChannel}`, { rxDevice, device: txDevice, channel: subName(txDevice, txChannel), status: 9 });
    },
    receiversOf(txDevice, txChannel) {
      const name = subName(txDevice, txChannel).toLowerCase();
      const out = [];
      for (const [key, r] of routes) {
        if (r.device.toLowerCase() === txDevice.toLowerCase() && r.channel.toLowerCase() === name) {
          out.push({ device: r.rxDevice, channel: Number(key.split('|')[1]) });
        }
      }
      return out;
    },
    txSubscriptionName(dev, ch) {
      return subName(dev, ch);
    },
    findDeviceByName(name) {
      return name === 'Unknown-Tx' ? null : { name };
    },
    rxState(rxDevice, rxChannel) {
      const r = routes.get(`${rxDevice.toLowerCase()}|${rxChannel}`);
      return r ? { subscribedDevice: r.device, subscribedChannel: r.channel, status: r.status, connected: r.status === 9 } : { subscribedDevice: null, status: 0 };
    },
    subscribe({ rxDevice, rxChannel, txDevice, txChannel }) {
      if (rxDevice === 'Offline') return { ok: false, error: 'Receiver "Offline" is offline' };
      log.push(`sub ${rxDevice}/${rxChannel} <- ${txDevice}/${txChannel}`);
      this.patch(rxDevice, rxChannel, txDevice, txChannel);
      return { ok: true, txName: txDevice, txChannelName: subName(txDevice, txChannel), txOnline: true };
    },
    unsubscribe({ rxDevice, rxChannel }) {
      log.push(`unsub ${rxDevice}/${rxChannel}`);
      routes.delete(`${rxDevice.toLowerCase()}|${rxChannel}`);
      return { ok: true };
    }
  };
}

test('store validates, persists and reloads channels and spares', () => {
  const { store, dir } = tmpStore();
  const ch = store.addChannel({ name: '  Vocal 1 ', tx: { device: 'RF-Rack', channel: '1' }, rx: { device: 'Console', channel: 5 } });
  assert.equal(ch.name, 'Vocal 1');
  assert.deepEqual(ch.tx, { device: 'RF-Rack', channel: 1 });
  const sp = store.addSpare({ name: 'Spare A', tx: { device: 'RF-Rack', channel: 4 } });
  assert.throws(() => store.addChannel({ tx: { device: '', channel: 1 } }), ShowError);
  assert.throws(() => store.updateChannel(ch.id, { rx: { device: 'X', channel: 0 } }), ShowError);
  assert.throws(() => store.channel('nope'), /not found/);

  store.setOnSpare(ch.id, sp.id);
  store.saveNow();
  const again = new ShowStore({ dataDir: dir, log: quiet });
  again.load();
  assert.equal(again.show.channels[0].spareId, sp.id);
  assert.equal(again.show.spares[0].inUseBy, ch.id);

  assert.throws(() => again.removeSpare(sp.id), /restore it first/);
  assert.throws(() => again.removeChannel(ch.id), /restore it first/);
  again.setOnSpare(ch.id, null);
  again.removeSpare(sp.id);
  assert.equal(again.show.channels[0].spareId, null);
});

test('images are stored from data URLs and references are validated', () => {
  const { store, dir } = tmpStore();
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  const file = store.saveImage(`data:image/png;base64,${png}`);
  assert.match(file, /^img_[0-9a-f]+\.png$/);
  assert.ok(fs.existsSync(path.join(dir, 'images', file)));
  assert.throws(() => store.saveImage('data:text/html;base64,AAAA'), ShowError);
  assert.equal(store.imagePath('../show.json'), null);
  assert.ok(store.imagePath(file).endsWith(file));
  const ch = store.addChannel({ name: 'A', image: file });
  assert.equal(ch.image, file);
  assert.throws(() => store.updateChannel(ch.id, { image: '../../etc/passwd' }), ShowError);
});

test('swap breaks the spare patch, breaks the main patch, patches spare into main Rx, verifies', async () => {
  const { store } = tmpStore();
  const engine = fakeEngine({ txNames: { 'RF-Rack|1': 'Vocal 1', 'RF-Rack|4': 'Spare A' } });
  const main = store.addChannel({ name: 'Vocal 1', tx: { device: 'RF-Rack', channel: 1 }, rx: { device: 'Console', channel: 5 } });
  const spare = store.addSpare({ name: 'Spare A', tx: { device: 'RF-Rack', channel: 4 } });
  engine.patch('Console', 5, 'RF-Rack', 1); // main on its own path
  engine.patch('Console', 30, 'RF-Rack', 4); // spare parked on a listen input

  const swap = new SwapController({ engine, store, log: quiet, stepGapMs: 1, verifyAfterMs: 1 });
  const result = await swap.swap(main.id, spare.id);
  assert.equal(result.ok, true);
  // Console/30 is on the same device as the main's receiver: it is exchanged, not broken.
  assert.deepEqual(engine.log, ['unsub Console/5', 'sub Console/5 <- RF-Rack/4', 'sub Console/30 <- RF-Rack/1']);
  assert.deepEqual(engine.rxState('Console', 5).subscribedChannel, 'Spare A');
  assert.equal(store.channel(main.id).spareId, spare.id);
  assert.equal(store.spare(spare.id).inUseBy, main.id);
  assert.match(result.steps[result.steps.length - 1].text, /^Verified/);

  // Restore puts the main's own Tx back and frees the spare.
  const restored = await swap.restore(main.id);
  assert.equal(restored.ok, true);
  assert.equal(engine.rxState('Console', 5).subscribedChannel, 'Vocal 1');
  assert.equal(engine.rxState('Console', 30).subscribedChannel, 'Spare A', 'the exchange is undone');
  assert.equal(store.channel(main.id).spareId, null);
  assert.equal(store.spare(spare.id).inUseBy, null);
});

test('moving a spare from one main to another frees the first main', async () => {
  const { store } = tmpStore();
  const engine = fakeEngine();
  const a = store.addChannel({ name: 'A', tx: { device: 'RF', channel: 1 }, rx: { device: 'Console', channel: 1 } });
  const b = store.addChannel({ name: 'B', tx: { device: 'RF', channel: 2 }, rx: { device: 'Console', channel: 2 } });
  const spare = store.addSpare({ name: 'S', tx: { device: 'RF', channel: 9 } });
  engine.patch('Console', 1, 'RF', 1);
  engine.patch('Console', 2, 'RF', 2);
  const swap = new SwapController({ engine, store, log: quiet, stepGapMs: 1, verifyAfterMs: 1 });

  await swap.swap(a.id, spare.id);
  await assert.rejects(swap.swap(b.id, spare.id), (err) => err.status === 409 && err.code === 'spare-in-use' && err.inUseBy.name === 'A');
  assert.equal(engine.rxState('Console', 1).subscribedChannel, '09', 'A untouched when refused');
  const forced = await swap.swap(b.id, spare.id, { force: true });
  assert.equal(forced.ok, true);
  assert.equal(swap.history[1].title, 'A taken off spare S', 'the bumped main gets its own history entry');
  assert.equal(engine.rxState('Console', 1).subscribedDevice, null, 'A lost its spare feed');
  assert.equal(engine.rxState('Console', 2).subscribedChannel, '09');
  assert.equal(store.channel(a.id).spareId, null);
  assert.equal(store.channel(b.id).spareId, spare.id);
  assert.equal(store.spare(spare.id).inUseBy, b.id);
});

test('swap refuses bad input and reports engine failures', async () => {
  const { store } = tmpStore();
  const engine = fakeEngine();
  const noRx = store.addChannel({ name: 'NoRx', tx: { device: 'RF', channel: 1 } });
  const sameTx = store.addChannel({ name: 'Same', tx: { device: 'RF', channel: 9 }, rx: { device: 'Console', channel: 1 } });
  const offline = store.addChannel({ name: 'Off', tx: { device: 'RF', channel: 3 }, rx: { device: 'Offline', channel: 1 } });
  const spare = store.addSpare({ name: 'S', tx: { device: 'RF', channel: 9 } });
  const swap = new SwapController({ engine, store, log: quiet, stepGapMs: 1, verifyAfterMs: 1 });
  await assert.rejects(swap.swap(noRx.id, spare.id), /no receive path/);
  await assert.rejects(swap.swap(sameTx.id, spare.id), /same transmitter/);
  await assert.rejects(swap.restore(offline.id), /offline/);
  assert.equal(swap.history[0].ok, false);
});

test('channels and spares can be reordered; unknown ids are ignored', () => {
  const { store } = tmpStore();
  const a = store.addChannel({ name: 'A' });
  const b = store.addChannel({ name: 'B' });
  const c = store.addChannel({ name: 'C' });
  store.reorderChannels([c.id, 'nope', a.id]);
  assert.deepEqual(store.show.channels.map((x) => x.name), ['C', 'A', 'B']);
  const s1 = store.addSpare({ name: 'S1' });
  const s2 = store.addSpare({ name: 'S2' });
  store.reorderSpares([s2.id, s1.id]);
  assert.deepEqual(store.show.spares.map((x) => x.name), ['S2', 'S1']);
  assert.throws(() => store.reorderSpares('x'), ShowError);
});

test('swap exchanges same-device receivers with the main Tx and leaves other devices alone', async () => {
  const { store } = tmpStore();
  const engine = fakeEngine({ txNames: { 'RF|1': 'Vocal 1', 'RF|9': 'Spare A' } });
  const main = store.addChannel({ name: 'Vocal 1', tx: { device: 'RF', channel: 1 }, rx: { device: 'Console', channel: 1 } });
  const spare = store.addSpare({ name: 'Spare A', tx: { device: 'RF', channel: 9 } });
  engine.patch('Console', 1, 'RF', 1); // main on its own transmitter
  engine.patch('Console', 31, 'RF', 9); // spare on the console's spare input (same device as the main)
  engine.patch('Listen', 2, 'RF', 9); // spare also on a listen station (other device)
  const swap = new SwapController({ engine, store, log: quiet, stepGapMs: 1, verifyAfterMs: 1 });

  const result = await swap.swap(main.id, spare.id);
  assert.equal(result.ok, true, JSON.stringify(result.steps));
  assert.deepEqual(engine.log, ['unsub Console/1', 'sub Console/1 <- RF/9', 'sub Console/31 <- RF/1']);
  assert.equal(engine.rxState('Console', 1).subscribedChannel, 'Spare A');
  assert.equal(engine.rxState('Console', 31).subscribedChannel, 'Vocal 1', 'the console spare input now carries the main pack');
  assert.equal(engine.rxState('Listen', 2).subscribedChannel, 'Spare A', 'the listen station keeps the spare');
  assert.ok(result.steps.some((s) => /Listen Rx 2 \(another device\): left as is/.test(s.text)));
  assert.deepEqual(store.channel(main.id).exchanged, [{ device: 'Console', channel: 31 }]);

  engine.log.length = 0;
  const restored = await swap.restore(main.id);
  assert.equal(restored.ok, true, JSON.stringify(restored.steps));
  assert.deepEqual(engine.log, ['sub Console/1 <- RF/1', 'sub Console/31 <- RF/9']);
  assert.equal(engine.rxState('Console', 31).subscribedChannel, 'Spare A');
  assert.deepEqual(store.channel(main.id).exchanged, []);
});

test('exchangeAll swaps every receiver hearing the spare to the main transmitter, and back on restore', async () => {
  const { store } = tmpStore();
  const engine = fakeEngine();
  const main = store.addChannel({ name: 'A', tx: { device: 'RF', channel: 1 }, rx: { device: 'Console', channel: 1 } });
  const spare = store.addSpare({ name: 'S', tx: { device: 'RF', channel: 9 }, exchangeAll: true });
  engine.patch('Console', 1, 'RF', 1);
  engine.patch('Listen', 2, 'RF', 9);
  const swap = new SwapController({ engine, store, log: quiet, stepGapMs: 1, verifyAfterMs: 1 });
  const r = await swap.swap(main.id, spare.id);
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.deepEqual(engine.log, ['unsub Console/1', 'sub Console/1 <- RF/9', 'sub Listen/2 <- RF/1']);
  assert.equal(engine.rxState('Listen', 2).subscribedChannel, '01', 'the listen station now hears the main pack');
  engine.log.length = 0;
  await swap.restore(main.id);
  assert.deepEqual(engine.log, ['sub Console/1 <- RF/1', 'sub Listen/2 <- RF/9'], 'the listen station gets the spare back');
});

test('swap guards: a spare feeding another channel\'s receive path on the same device, and a main with no Tx', async () => {
  const { store } = tmpStore();
  const engine = fakeEngine();
  const a = store.addChannel({ name: 'A', tx: { device: 'RF', channel: 1 }, rx: { device: 'Console', channel: 1 } });
  const b = store.addChannel({ name: 'B', tx: { device: 'RF', channel: 2 }, rx: { device: 'Console', channel: 2 } });
  const noTx = store.addChannel({ name: 'NoTx', rx: { device: 'Console', channel: 3 } });
  const feedsB = store.addSpare({ name: 'S1', tx: { device: 'RF', channel: 9 } });
  const good = store.addSpare({ name: 'S3', tx: { device: 'RF', channel: 8 } });
  engine.patch('Console', 1, 'RF', 1);
  engine.patch('Console', 2, 'RF', 9); // S1 is what B's receiver carries right now
  engine.patch('Console', 3, 'RF', 5);
  const swap = new SwapController({ engine, store, log: quiet, stepGapMs: 1, verifyAfterMs: 1 });
  await assert.rejects(swap.swap(a.id, feedsB.id), /"B"'s receive path/);
  // A main without a transmitter on record can be swapped and restored (restore clears its Rx).
  const r = await swap.swap(noTx.id, good.id);
  assert.equal(r.ok, true);
  assert.equal(engine.rxState('Console', 3).subscribedChannel, '08');
  const back = await swap.restore(noTx.id);
  assert.equal(back.ok, true);
  assert.equal(engine.rxState('Console', 3).subscribedDevice, null);
  assert.equal(store.spare(good.id).inUseBy, null);
  void b;
});

test('swap re-sends the main patch once when the receiver does not report it', async () => {
  const { store } = tmpStore();
  const engine = fakeEngine();
  const main = store.addChannel({ name: 'A', tx: { device: 'RF', channel: 1 }, rx: { device: 'Console', channel: 1 } });
  const spare = store.addSpare({ name: 'S', tx: { device: 'RF', channel: 9 } });
  engine.patch('Console', 1, 'RF', 1);
  // First subscribe is "lost": it does not change the routing table.
  const realSubscribe = engine.subscribe.bind(engine);
  let calls = 0;
  engine.subscribe = (args) => {
    calls++;
    if (calls === 1) {
      engine.log.push('sub lost');
      return { ok: true, txName: args.txDevice, txChannelName: '09', txOnline: true };
    }
    return realSubscribe(args);
  };
  const swap = new SwapController({ engine, store, log: quiet, stepGapMs: 1, verifyAfterMs: 1 });
  const r = await swap.swap(main.id, spare.id);
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.ok(r.steps.some((s) => /sending again/.test(s.text)));
  assert.equal(engine.rxState('Console', 1).subscribedChannel, '09');
});

test('edits are refused while a swap runs and a bad field leaves a card untouched', async () => {
  const { store } = tmpStore();
  const ch = store.addChannel({ name: 'A', tx: { device: 'RF', channel: 1 } });
  assert.throws(() => store.updateChannel(ch.id, { name: 'Renamed', tx: { device: '', channel: 1 } }), ShowError);
  assert.equal(store.channel(ch.id).name, 'A', 'rename not applied when another field is invalid');
  assert.throws(() => store.addReceiver({ brand: 'constructor', host: '1.2.3.4' }), /Unknown receiver brand/);
  assert.throws(() => store.addChannel({ name: 'B', tx: { device: 'x'.repeat(70), channel: 1 } }), /too long/);
});

test('settings: Shure discovery is off by default and persists when turned on', () => {
  const { store, dir } = tmpStore();
  assert.equal(store.show.settings.shureDiscovery, false);
  assert.equal(store.publicSnapshot().settings.shureDiscovery, false);
  store.updateSettings({ shureDiscovery: true });
  store.saveNow();
  const again = new ShowStore({ dataDir: dir, log: quiet });
  again.load();
  assert.equal(again.show.settings.shureDiscovery, true);
  assert.throws(() => store.updateSettings('yes'), ShowError);
});

test('settings: receiver adapter is validated and defaults to following Dante', () => {
  const { store } = tmpStore();
  assert.equal(store.show.settings.rfInterface, '');
  store.updateSettings({ rfInterface: 'en7' });
  assert.equal(store.show.settings.rfInterface, 'en7');
  store.updateSettings({ rfInterface: 'all' });
  assert.equal(store.show.settings.rfInterface, 'all');
  store.updateSettings({ rfInterface: null });
  assert.equal(store.show.settings.rfInterface, '');
  assert.throws(() => store.updateSettings({ rfInterface: 'x'.repeat(70) }), ShowError);
  assert.throws(() => store.updateSettings({ rfInterface: 'en7; rm' }), ShowError);
});
