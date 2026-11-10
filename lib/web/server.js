'use strict';

/**
 * HTTP API + static UI + WebSocket push.
 *
 * WebSocket messages to clients:
 *   hello   { version, boundIp, name, interfaces[] }
 *   devices [ device structure … ]
 *   show    { name, channels[], spares[] }
 *   meters  { t, d: { ip: { tx:[], rx:[] } } }        (20 Hz)
 *   result  { type: 'swap'|'restore', ok, title, steps[] }
 *   rf      { t, d: { receiverId: { online, model, deviceId, channels: { n: telemetry } } } }  (5 Hz)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('./websocket');
const { listInterfaces } = require('../dante/network');
const { ShowError } = require('../show/store');
const { BRANDS } = require('../rf/telemetry');

const PUBLIC_DIR = path.resolve(__dirname, '..', '..', 'public');
const METER_INTERVAL_MS = 50; // 20 Hz
const STRUCTURE_INTERVAL_MS = 250;
const RF_INTERVAL_MS = 200;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_IMAGE_BODY_BYTES = 6 * 1024 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const HTML_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'"
};

function sendJson(res, status, body) {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': MIME_TYPES['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!parsed || typeof parsed !== 'object') throw new Error('expected an object');
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function resolveStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, rel);
  return filePath.startsWith(PUBLIC_DIR + path.sep) ? filePath : null;
}

function sendFile(req, res, filePath, { cache = 'no-cache' } = {}) {
  const notFound = () => {
    res.writeHead(404, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  };
  if (!filePath) return notFound();
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return notFound();
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      ...BASE_HEADERS,
      ...(ext === '.html' ? HTML_HEADERS : {}),
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': cache
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
  });
}

function publicInterfaces() {
  return listInterfaces().map(({ name, address, isDanteLinkLocal }) => ({ name, address, isDanteLinkLocal }));
}

/**
 * @param {object} opts
 * @param {import('../dante/engine').DanteEngine} opts.engine
 * @param {import('../show/store').ShowStore} opts.store
 * @param {import('../show/swap').SwapController} opts.swap
 */
function createWebServer({ engine, store, swap, rf = null, discovery = null, version, log }) {
  const wss = new WebSocketServer({ path: '/ws' });
  const startedAt = Date.now();
  let lastStructure = '';

  const devicesMessage = () => {
    lastStructure = JSON.stringify(engine.getDevices());
    return `{"type":"devices","data":${lastStructure}}`;
  };
  const showMessage = () => JSON.stringify({ type: 'show', data: store.publicSnapshot() });
  const helloMessage = () =>
    JSON.stringify({ type: 'hello', data: { version, ...engine.interfaceInfo(), interfaces: publicInterfaces(), history: swap.history.slice(0, 20), brands: BRANDS } });

  const refresh = () =>
    new Promise((resolve) => {
      engine.refresh();
      setTimeout(() => {
        wss.broadcast(devicesMessage());
        resolve();
      }, 300);
    });

  async function handleApi(req, res, urlPath) {
    const parts = urlPath.split('/').filter(Boolean); // ['api', ...]
    const method = req.method;
    const route = `${method} /${parts.slice(0, 2).join('/')}`;
    const id = parts[2];

    switch (route) {
      // --- network -----------------------------------------------------------
      case 'GET /api/devices':
        return sendJson(res, 200, engine.getSnapshot());
      case 'GET /api/status': {
        const devices = engine.getDevices();
        return sendJson(res, 200, {
          status: 'ok',
          version,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          boundIp: engine.boundIp,
          deviceCount: devices.length,
          onlineCount: devices.filter((d) => d.online).length,
          wsClients: wss.clients.size,
          health: engine.getHealth ? engine.getHealth() : null,
          show: { name: store.show.name, channels: store.show.channels.length, spares: store.show.spares.length }
        });
      }
      case 'GET /api/diagnostics':
        return sendJson(res, 200, { ...engine.getDiagnostics(), receivers: rf ? rf.getFrame() : {} });
      case 'GET /api/interfaces':
        return sendJson(res, 200, { activeIp: engine.boundIp, interfaces: publicInterfaces() });
      case 'POST /api/interface': {
        const body = await readJsonBody(req);
        return sendJson(res, 200, engine.selectInterface(typeof body.ip === 'string' ? body.ip : 'all'));
      }
      case 'POST /api/refresh':
        await refresh();
        return sendJson(res, 200, { success: true });

      // --- show ----------------------------------------------------------------
      case 'GET /api/show':
        return sendJson(res, 200, store.publicSnapshot());
      case 'PATCH /api/show': {
        const body = await readJsonBody(req);
        if ('name' in body) store.rename(body.name);
        return sendJson(res, 200, store.publicSnapshot());
      }
      case 'POST /api/channels':
        return sendJson(res, 201, store.addChannel(await readJsonBody(req)));
      case 'PATCH /api/channels':
        return sendJson(res, 200, store.updateChannel(id, await readJsonBody(req)));
      case 'DELETE /api/channels':
        return sendJson(res, 200, store.removeChannel(id));
      case 'POST /api/reorder': {
        const body = await readJsonBody(req);
        if (body.spares) store.reorderSpares(body.spares);
        else store.reorderChannels(body.channels || body.ids);
        return sendJson(res, 200, store.publicSnapshot());
      }

      // --- wireless receivers --------------------------------------------------
      case 'GET /api/receivers':
        return sendJson(res, 200, { brands: BRANDS, receivers: store.publicSnapshot().receivers, state: rf ? rf.getFrame() : {}, discovered: discovery ? discovery.list() : [] });
      case 'POST /api/receivers': {
        const r = store.addReceiver(await readJsonBody(req));
        return sendJson(res, 201, { ...r, password: undefined, hasPassword: Boolean(r.password) });
      }
      case 'PATCH /api/receivers': {
        const r = store.updateReceiver(id, await readJsonBody(req));
        return sendJson(res, 200, { ...r, password: undefined, hasPassword: Boolean(r.password) });
      }
      case 'DELETE /api/receivers':
        return sendJson(res, 200, { removed: store.removeReceiver(id).id });
      case 'GET /api/rf':
        return sendJson(res, 200, rf ? rf.getFrame() : {});
      case 'POST /api/spares':
        return sendJson(res, 201, store.addSpare(await readJsonBody(req)));
      case 'PATCH /api/spares':
        return sendJson(res, 200, store.updateSpare(id, await readJsonBody(req)));
      case 'DELETE /api/spares':
        return sendJson(res, 200, store.removeSpare(id));
      case 'POST /api/images': {
        const body = await readJsonBody(req, MAX_IMAGE_BODY_BYTES);
        return sendJson(res, 201, { file: store.saveImage(body.dataUrl) });
      }

      // --- swap ----------------------------------------------------------------
      case 'POST /api/swap': {
        const body = await readJsonBody(req);
        return sendJson(res, 200, await swap.swap(String(body.channelId || ''), String(body.spareId || '')));
      }
      case 'POST /api/restore': {
        const body = await readJsonBody(req);
        return sendJson(res, 200, await swap.restore(String(body.channelId || '')));
      }
      case 'POST /api/patch': {
        // Direct patch for setup and testing: { rx: {device, channel}, tx: {device, channel} | null }.
        const body = await readJsonBody(req);
        const rxPath = body.rx || {};
        if (!rxPath.device || !rxPath.channel) return sendJson(res, 400, { error: 'rx.device and rx.channel are required' });
        const result = body.tx
          ? engine.subscribe({ rxDevice: rxPath.device, rxChannel: rxPath.channel, txDevice: body.tx.device, txChannel: body.tx.channel })
          : engine.unsubscribe({ rxDevice: rxPath.device, rxChannel: rxPath.channel });
        if (!result.ok) return sendJson(res, 502, { error: result.error });
        await new Promise((r) => setTimeout(r, 1500));
        return sendJson(res, 200, { ...result, state: engine.rxState(rxPath.device, rxPath.channel) });
      }
      case 'GET /api/history':
        return sendJson(res, 200, swap.history);

      default:
        return sendJson(res, 404, { error: 'Not found' });
    }
  }

  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath.startsWith('/api/')) {
      handleApi(req, res, urlPath).catch((err) => {
        const status = err instanceof ShowError ? err.status : err.status;
        if (!res.headersSent) sendJson(res, status || 500, { error: status ? err.message : 'Internal error' });
        if (!status) log.error('[HTTP]', err);
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { ...BASE_HEADERS, Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    if (urlPath.startsWith('/images/')) {
      let file = null;
      try {
        file = store.imagePath(decodeURIComponent(urlPath.slice('/images/'.length)));
      } catch {
        file = null;
      }
      return sendFile(req, res, file, { cache: 'public, max-age=31536000, immutable' });
    }
    sendFile(req, res, resolveStaticPath(urlPath));
  });

  server.on('upgrade', (req, socket) => wss.handleUpgrade(req, socket));
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  wss.on('connection', (client, req) => {
    log.info(`[WebSocket] Client connected from ${req.socket.remoteAddress} (${wss.clients.size} active)`);
    client.send(helloMessage());
    client.send(devicesMessage());
    client.send(showMessage());
    client.on('message', (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'select_interface') engine.selectInterface(typeof msg.ip === 'string' ? msg.ip : 'all');
      else if (msg.type === 'refresh') refresh();
    });
  });
  wss.on('disconnect', () => log.info(`[WebSocket] Client disconnected (${wss.clients.size} active)`));

  engine.on('interface', () => {
    wss.broadcast(helloMessage());
    wss.broadcast(devicesMessage());
  });
  engine.on('interfaces-changed', () => wss.broadcast(helloMessage()));
  store.on('change', () => wss.broadcast(showMessage()));
  swap.on('result', (entry) => wss.broadcast(JSON.stringify({ type: 'result', data: entry })));

  const timers = [
    setInterval(() => {
      if (wss.clients.size === 0) return;
      wss.broadcast(JSON.stringify({ type: 'meters', t: Date.now(), d: engine.getMeterFrame() }), { droppable: true });
    }, METER_INTERVAL_MS),
    setInterval(() => {
      if (wss.clients.size === 0) return;
      if (JSON.stringify(engine.getDevices()) !== lastStructure) wss.broadcast(devicesMessage());
    }, STRUCTURE_INTERVAL_MS),
    setInterval(() => {
      if (wss.clients.size === 0 || !rf || !(store.show.receivers || []).length) return;
      wss.broadcast(JSON.stringify({ type: 'rf', t: Date.now(), d: rf.getFrame() }), { droppable: true });
    }, RF_INTERVAL_MS)
  ];

  function close() {
    for (const t of timers) clearInterval(t);
    wss.close();
    server.close();
    server.closeAllConnections?.();
  }

  return { server, wss, close };
}

module.exports = { createWebServer, resolveStaticPath, PUBLIC_DIR };
