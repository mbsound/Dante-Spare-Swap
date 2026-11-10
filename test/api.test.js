'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const { createWebServer, resolveStaticPath, PUBLIC_DIR } = require('../lib/web/server');
const { ShowStore } = require('../lib/show/store');
const { SwapController } = require('../lib/show/swap');

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

function fakeEngine() {
  const e = new EventEmitter();
  Object.assign(e, {
    boundIp: '169.254.1.1',
    interfaceInfo: () => ({ boundIp: '169.254.1.1', name: 'en0' }),
    getDevices: () => [],
    getMeterFrame: () => ({}),
    getSnapshot: () => ({ devices: [] }),
    selectInterface: () => ({}),
    refresh() {},
    receiversOf: () => [],
    rxState: () => ({ subscribedDevice: 'RF', subscribedChannel: '02', status: 9 }),
    txSubscriptionName: (d, c) => String(c).padStart(2, '0'),
    subscribe: () => ({ ok: true, txName: 'RF', txChannelName: '02', txOnline: true }),
    unsubscribe: () => ({ ok: true })
  });
  return e;
}

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      { port, method, path: urlPath, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => {
          const isJson = String(res.headers['content-type'] || '').includes('json');
          resolve({ status: res.statusCode, headers: res.headers, body: isJson && text ? JSON.parse(text) : text });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('static paths cannot escape the public directory', () => {
  assert.equal(resolveStaticPath('/'), path.join(PUBLIC_DIR, 'index.html'));
  assert.equal(resolveStaticPath('/../server.js'), null);
  assert.equal(resolveStaticPath('/%2e%2e/server.js'), null);
});

test('REST API: channels, spares, swap and restore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dss-api-'));
  const store = new ShowStore({ dataDir: dir, log: quiet });
  store.load();
  const engine = fakeEngine();
  const swap = new SwapController({ engine, store, log: quiet, stepGapMs: 1, verifyAfterMs: 1 });
  const web = createWebServer({ engine, store, swap, version: 'test', log: quiet });
  await new Promise((r) => web.server.listen(0, '127.0.0.1', r));
  const port = web.server.address().port;

  try {
    let r = await request(port, 'POST', '/api/channels', { name: 'Vocal 1', tx: { device: 'RF', channel: 1 }, rx: { device: 'Console', channel: 5 } });
    assert.equal(r.status, 201);
    const ch = r.body;
    r = await request(port, 'POST', '/api/spares', { name: 'Spare A', tx: { device: 'RF', channel: 2 } });
    assert.equal(r.status, 201);
    const sp = r.body;

    r = await request(port, 'PATCH', `/api/channels/${ch.id}`, { notes: 'pack 7' });
    assert.equal(r.body.notes, 'pack 7');
    r = await request(port, 'PATCH', `/api/channels/${ch.id}`, { rx: { device: 'Console', channel: 'x' } });
    assert.equal(r.status, 400);

    r = await request(port, 'POST', '/api/swap', { channelId: ch.id, spareId: sp.id });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    r = await request(port, 'GET', '/api/show');
    assert.equal(r.body.channels[0].spareId, sp.id);
    assert.equal(r.body.spares[0].inUseBy, ch.id);

    r = await request(port, 'POST', '/api/restore', { channelId: ch.id });
    assert.equal(r.body.ok, true);
    r = await request(port, 'GET', '/api/history');
    assert.equal(r.body.length, 2);

    r = await request(port, 'POST', '/api/swap', { channelId: 'nope', spareId: sp.id });
    assert.equal(r.status, 404);

    r = await request(port, 'POST', '/api/images', { dataUrl: 'data:image/png;base64,iVBORw0KGgo=' });
    assert.equal(r.status, 201);
    const img = await request(port, 'GET', `/images/${r.body.file}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers['content-type'], 'image/png');
    assert.equal((await request(port, 'GET', '/images/../show.json')).status, 404);

    r = await request(port, 'DELETE', `/api/channels/${ch.id}`);
    assert.equal(r.status, 200);
    r = await request(port, 'GET', '/api/status');
    assert.equal(r.body.show.channels, 0);
  } finally {
    web.close();
  }
});
