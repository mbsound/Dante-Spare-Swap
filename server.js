#!/usr/bin/env node
'use strict';

/**
 * Dante Spare Swap — entry point.
 * Zero runtime dependencies: Node.js core modules only.
 */

const { loadConfig, ConfigError, USAGE } = require('./lib/config');
const { createLogger } = require('./lib/log');
const { DanteEngine } = require('./lib/dante/engine');
const { DemoEngine } = require('./lib/dante/simulator');
const { IdentityResolver } = require('./lib/dante/identity');
const { listInterfaces, openBrowser, resolveInterface } = require('./lib/dante/network');
const { ShowStore } = require('./lib/show/store');
const { SwapController } = require('./lib/show/swap');
const { RfManager } = require('./lib/rf/manager');
const { ReceiverDiscovery } = require('./lib/rf/discovery');
const { createWebServer } = require('./lib/web/server');
const { version } = require('./package.json');

function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  if (config.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (config.version) {
    console.log(version);
    return;
  }

  const log = createLogger({ debug: config.debug });
  if (config.configFile) log.info(`[Config] Loaded ${config.configFile}`);

  const identity = new IdentityResolver({ overrides: config.deviceOverrides });
  const engine = config.demo ? new DemoEngine({ log }) : new DanteEngine({ nic: config.nic, log, identity });
  const store = new ShowStore({ dataDir: config.dataDir, log });
  store.load();
  const swap = new SwapController({ engine, store, log });
  /**
   * The adapter receivers are reached and browsed on: the show's rfInterface
   * setting (an adapter name or address, or "all"), else the adapter Dante is
   * bound to. Returns { preferred, interfaces } for the manager and discovery.
   */
  const rfNetwork = () => {
    const setting = (store.show.settings && store.show.settings.rfInterface) || '';
    if (setting.toLowerCase() === 'all') return { preferred: null, interfaces: null };
    const chosen = setting ? resolveInterface(setting) : null;
    if (setting && !chosen) log.warn(`[RF] Receiver adapter "${setting}" is not present; using Dante's adapter until it is.`);
    const iface = chosen || engine.iface || null;
    return { preferred: iface, interfaces: iface ? [iface.address] : null };
  };
  const rf = new RfManager({ store, log, simulate: config.demo, preferredInterface: () => rfNetwork().preferred });
  const discovery = config.demo ? null : new ReceiverDiscovery({ log, interfaces: rfNetwork().interfaces, shure: store.show.settings.shureDiscovery });
  const applyRfNetwork = () => {
    if (!discovery) return;
    discovery.setInterfaces(rfNetwork().interfaces);
    discovery.setTargets(store.show.receivers.filter((r) => r.brand === 'shure-ad').map((r) => r.host));
  };
  applyRfNetwork();
  store.on('change', (show) => {
    if (discovery) discovery.setShureEnabled(show.settings && show.settings.shureDiscovery);
    applyRfNetwork();
  });
  engine.on('interface', () => {
    applyRfNetwork();
    rf.sync();
  });
  const web = createWebServer({ engine, store, swap, rf, discovery, version, log });
  const localUrl = `http://localhost:${config.port}`;

  web.server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${config.port} is already in use. Is Dante Spare Swap already running?`);
      log.error('Close the other instance, or start this one with --port <another port>.');
      if (config.open) openBrowser(localUrl);
    } else {
      log.error(`Web server failed: ${err.message}`);
    }
    engine.stop();
    process.exit(1);
  });

  engine.start();
  rf.start();
  if (discovery) discovery.start();

  web.server.listen(config.port, config.host, () => {
    const lanUrls =
      config.host === '0.0.0.0'
        ? listInterfaces().map((i) => `http://${i.address}:${config.port}`)
        : [`http://${config.host}:${config.port}`];
    console.log('');
    console.log(`  Dante Spare Swap v${version}${config.demo ? '  (DEMO — simulated network)' : ''}`);
    console.log(`  Show file: ${store.file}`);
    console.log(`  Local:     ${localUrl}`);
    for (const url of lanUrls) console.log(`  Network:   ${url}`);
    console.log('  Press Ctrl+C to stop.');
    console.log('');
    if (config.open) openBrowser(localUrl);
  });

  // Last resort: a bug in a packet handler or timer must not take the show
  // down. Log it, make sure the show file is on disk, and keep running.
  for (const event of ['uncaughtException', 'unhandledRejection']) {
    process.on(event, (err) => {
      log.error(`[Server] ${event}:`, err && err.stack ? err.stack : err);
      try {
        store.saveNow();
      } catch {
        // nothing more to do
      }
    });
  }

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[Server] ${signal} received, shutting down.`);
    store.saveNow();
    rf.stop();
    if (discovery) discovery.stop();
    engine.stop();
    web.close();
    setTimeout(() => process.exit(0), 500).unref();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => shutdown(signal));
}

main();
