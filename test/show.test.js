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
  assert.deepEqual(engine.log, ['unsub Console/30', 'unsub Console/5', 'sub Console/5 <- RF-Rack/4']);
  assert.deepEqual(engine.rxState('Console', 5).subscribedChannel, 'Spare A');
  assert.equal(store.channel(main.id).spareId, spare.id);
  assert.equal(store.spare(spare.id).inUseBy, main.id);
  assert.match(result.steps[result.steps.length - 1].text, /^Verified/);

  // Restore puts the main's own Tx back and frees the spare.
  const restored = await swap.restore(main.id);
  assert.equal(restored.ok, true);
  assert.equal(engine.rxState('Console', 5).subscribedChannel, 'Vocal 1');
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
  await swap.swap(b.id, spare.id);
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

test('spare with a monitor path: swap patches the main Tx into it, restore puts the spare Tx back', async () => {
  const { store } = tmpStore();
  const engine = fakeEngine({ txNames: { 'RF|1': 'Vocal 1', 'RF|9': 'Spare A' } });
  const main = store.addChannel({ name: 'Vocal 1', tx: { device: 'RF', channel: 1 }, rx: { device: 'Console', channel: 1 } });
  const spare = store.addSpare({ name: 'Spare A', tx: { device: 'RF', channel: 9 }, rx: { device: 'Console', channel: 31 }, monitorMain: true });
  engine.patch('Console', 1, 'RF', 1);
  engine.patch('Console', 31, 'RF', 9); // spare normally monitored on input 31
  const swap = new SwapController({ engine, store, log: quiet, stepGapMs: 1, verifyAfterMs: 1 });

  const result = await swap.swap(main.id, spare.id);
  assert.equal(result.ok, true);
  assert.deepEqual(engine.log, ['unsub Console/1', 'sub Console/1 <- RF/9', 'sub Console/31 <- RF/1']);
  assert.equal(engine.rxState('Console', 1).subscribedChannel, 'Spare A');
  assert.equal(engine.rxState('Console', 31).subscribedChannel, 'Vocal 1', 'main pack is on the monitor input');
  assert.equal(result.steps.filter((s) => /^Verified/.test(s.text)).length, 2);

  engine.log.length = 0;
  const restored = await swap.restore(main.id);
  assert.equal(restored.ok, true);
  assert.deepEqual(engine.log, ['sub Console/1 <- RF/1', 'sub Console/31 <- RF/9']);
  assert.equal(engine.rxState('Console', 31).subscribedChannel, 'Spare A');
});

test('spare with a monitor path but the option off: monitor input is simply cleared', async () => {
  const { store } = tmpStore();
  const engine = fakeEngine();
  const main = store.addChannel({ name: 'A', tx: { device: 'RF', channel: 1 }, rx: { device: 'Console', channel: 1 } });
  const spare = store.addSpare({ name: 'S', tx: { device: 'RF', channel: 9 }, rx: { device: 'Console', channel: 31 }, monitorMain: false });
  engine.patch('Console', 1, 'RF', 1);
  engine.patch('Console', 31, 'RF', 9);
  const swap = new SwapController({ engine, store, log: quiet, stepGapMs: 1, verifyAfterMs: 1 });
  await swap.swap(main.id, spare.id);
  assert.deepEqual(engine.log, ['unsub Console/31', 'unsub Console/1', 'sub Console/1 <- RF/9']);
  engine.log.length = 0;
  await swap.restore(main.id);
  assert.deepEqual(engine.log, ['sub Console/1 <- RF/1'], 'nothing is re-patched into the monitor input');
});
