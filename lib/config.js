'use strict';

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');

const APP_DIR = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_FILE = 'dante-swap.config.json';

const DEFAULTS = {
  port: 8753,
  host: '0.0.0.0',
  nic: null,
  open: false,
  debug: false,
  dataDir: path.join(APP_DIR, 'data'),
  deviceOverrides: {}
};

const USAGE = `Dante Spare Swap

Usage: node server.js [options]

Options:
  -i, --nic <ip|name>   Network interface to use for Dante (IP address or name, e.g. en6)
  -p, --port <port>     Web UI port (default: ${DEFAULTS.port})
      --host <address>  Address the web UI listens on (default: ${DEFAULTS.host}, all interfaces)
  -d, --data <dir>      Folder for the show file and pictures (default: ./data)
  -c, --config <file>   Config file (default: ./${DEFAULT_CONFIG_FILE} if present)
      --open            Open the UI in the default browser once started
      --demo            Simulated Dante network (rehearse the UI with no hardware)
      --debug           Verbose logging
  -v, --version         Print version and exit
  -h, --help            Show this help

Environment variables: DANTE_IP, PORT, HOST, DATA_DIR, DEBUG=1
Precedence: command line > environment > config file > defaults.
`;

class ConfigError extends Error {}

function parseCli(argv) {
  try {
    return parseArgs({
      args: argv,
      options: {
        nic: { type: 'string', short: 'i' },
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        data: { type: 'string', short: 'd' },
        config: { type: 'string', short: 'c' },
        open: { type: 'boolean' },
        demo: { type: 'boolean' },
        debug: { type: 'boolean' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' }
      },
      strict: true,
      allowPositionals: false
    }).values;
  } catch (err) {
    throw new ConfigError(`${err.message}\n\n${USAGE}`);
  }
}

function readConfigFile(file, explicit) {
  if (!fs.existsSync(file)) {
    if (explicit) throw new ConfigError(`Config file not found: ${file}`);
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a JSON object');
    return parsed;
  } catch (err) {
    throw new ConfigError(`Could not read config file ${file}: ${err.message}`);
  }
}

function parsePort(value, source) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`Invalid port from ${source}: ${value}`);
  return port;
}

function firstDefined(...values) {
  return values.find((v) => v !== undefined && v !== null && v !== '');
}

function loadConfig({ argv = process.argv.slice(2), env = process.env, appDir = APP_DIR } = {}) {
  const cli = parseCli(argv);
  const explicitFile = cli.config ? path.resolve(cli.config) : null;
  const configFile = explicitFile || path.join(appDir, DEFAULT_CONFIG_FILE);
  const file = cli.help || cli.version ? {} : readConfigFile(configFile, Boolean(explicitFile));

  const portSource = firstDefined(cli.port, env.PORT, file.port);
  const overrides = file.deviceOverrides || {};
  if (typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new ConfigError('"deviceOverrides" in the config file must be an object keyed by device name');
  }
  const dataDir = firstDefined(cli.data, env.DATA_DIR, file.dataDir);

  return {
    port: portSource === undefined ? DEFAULTS.port : parsePort(portSource, cli.port ? '--port' : env.PORT ? 'PORT' : 'config'),
    host: firstDefined(cli.host, env.HOST, file.host) || DEFAULTS.host,
    nic: firstDefined(cli.nic, env.DANTE_IP, file.nic) || DEFAULTS.nic,
    dataDir: dataDir ? path.resolve(appDir, dataDir) : DEFAULTS.dataDir,
    open: Boolean(cli.open || file.open),
    demo: Boolean(cli.demo || env.DEMO === '1' || file.demo),
    debug: Boolean(cli.debug || env.DEBUG === '1' || env.DEBUG === 'true' || file.debug),
    deviceOverrides: overrides,
    configFile: fs.existsSync(configFile) ? configFile : null,
    help: Boolean(cli.help),
    version: Boolean(cli.version)
  };
}

module.exports = { loadConfig, ConfigError, USAGE, DEFAULTS, DEFAULT_CONFIG_FILE };
