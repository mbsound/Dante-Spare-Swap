# Dante Spare Swap

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18-brightgreen.svg)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/Dependencies-0-orange.svg)](package.json)

Fast main / spare patching for theatrical **Audinate Dante** networks. When an RF pack goes bad mid-show, tap the channel, tap a spare, hit **SWAP**: the spare's transmitter is patched into the channel's receiver and the show carries on.

Built on the [Dante Audio Meter Bridge](https://github.com/mbsound/Dante-Meter-Bridge): the same discovery and metering engine, plus receiver-side routing control.

- **No Dante Controller required.** Discovery, meters and routing talk to the devices directly.
- **Zero dependencies.** Pure Node.js core modules. No `npm install`, no build step.
- **Any browser.** Run it on a laptop at the RF position; use it from an iPad at the mix position too.

---

## How a show is set up

1. **Channels** are cards, one per RF mic (or any Dante path). Each card has a picture (choose, drag-and-drop or paste a headshot; in Edit mode you can drop an image straight onto a card), a name, and two paths:
   - **Transmit path**: the Dante transmitter channel the mic arrives on (e.g. `RF-Rack-A` Tx 3).
   - **Receive path**: where it lands (e.g. `FOH-Console` Rx 12).
2. **Spares** live in the tray on the right. In **Edit** mode, drag cards (and spares) to reorder them. Each spare is a transmit path you hold in reserve (e.g. the spare pack on `RF-Rack-B` Tx 7).
3. Each card shows two meters: **TX** (the mic's own transmitter) and **RX** (what is actually arriving at the receiver), plus a status badge read live from the receiver's subscription:
   `MAIN` (on its own transmitter), `ON SPARE · name`, `UNPATCHED`, or `OTHER SOURCE`.

## The swap

Tap a channel, tap a spare, press **SWAP**. In the background:

1. If the spare's transmitter is patched to any receiver, those patches are broken.
2. The channel's own transmitter → receiver patch is broken.
3. The spare's transmitter is patched into the channel's receiver.
4. The receiver is re-read and the result is verified (and logged in the swap history).

Afterwards the channel's card goes grey with an **ON SPARE** badge. Its TX meter keeps showing the *main* transmitter, so you can diagnose the faulty pack while the spare carries the show. In the tray, the spare inherits the channel's picture and name so everyone can see what it is now doing.

**RESTORE MAIN** puts the channel's own transmitter back into its receiver and frees the spare.

### Monitoring the faulty pack

Spare packs are often patched to a console input or listen bus so they can be checked. Give a spare a **Monitor path** in its settings and tick **patch the main mic's transmitter into this input when swapped in**. Then a swap also does:

5. The channel's own (faulty) transmitter is patched into the spare's monitor input, so the console can listen to the bad pack while the spare carries the show. The spare card shows a **MON** meter for it.

On restore, the spare's own transmitter is patched back into its monitor input. Leave the option off and the spare's monitor patch is simply cleared during a swap, as before. The option is per spare, so you can mix both behaviours.

Every step is a standard Dante receiver subscription change, the same thing Dante Controller does when you click a crosspoint. Nothing else on the network is touched.

### Wireless receivers (optional)

A card can also be linked to a channel on an RF receiver, so the operator sees the pack itself, not just its Dante audio. This is a choice per card: **Dante meters**, **RF parameters** (AF, RF A/B with the active antenna, link quality, transmitter battery with time remaining, transmitter name, frequency, mute and warnings), or **both**. Cards with no receiver link behave as before.

Add receivers with the **Receivers** button (they are also found on the network: Shure units via SLP, Sennheiser units via mDNS), then pick the receiver and channel in the card's settings.

| Receiver | How it is read |
|---|---|
| **Shure Axient Digital AD4D, AD4Q, ANX4** | Shure's documented *command strings* over TCP 2202: `METER_RATE` + `SAMPLE` for audio, RF per antenna and channel quality; `TX_*` reports for the transmitter and its battery. Turn command strings on in the unit's Network Services menu. |
| **Sennheiser EW-DX EM 2 / EM 4, firmware 4.0+** | SSCv2 (HTTPS 443, user `api`, SSE subscriptions). Allow third-party access on the receiver and set its password. EW-D transmitters paired to an EW-DX receiver are covered. |
| **Sennheiser EW-DX, firmware before 4.0** | Sound Control v1 (JSON over UDP 45) with subscriptions. |
| **Sennheiser Spectera** | SSCv2 (HTTPS 443, user `controlSennheiser`). One channel per paired mobile device, in the base station's order. Audio level mapping is best effort. |
| **Sennheiser EM 6000** | Sound Control v1 over UDP 45 using the EW-DX address layout. The public docs do not list the EM 6000 methods, so treat this as unverified. |

EW-D receivers themselves (non-DX) have no network control and cannot be linked.

Receiver credentials live in the show file in the data folder, nowhere else.

---

## Quick start

| Platform | First time (installs Node.js if needed) | Every day after |
|---|---|---|
| **macOS** | `First Time Running - Click Here - Mac.command` | `Start Dante Spare Swap - Mac.command` |
| **Windows** | `First Time Running - Click Here - Windows.bat` | `Start Dante Spare Swap - Windows.bat` |

Or from a terminal:

```bash
npm start
```

Then open <http://localhost:8753>. From another device on the same network use `http://<this-computer's-ip>:8753` (the addresses are printed at startup).

### Rehearse without hardware

```bash
node server.js --demo
```

Demo mode simulates two RF racks and two consoles with moving meters and a working routing table. Build your show file against it, then start normally on the real network.

## Options

```
node server.js [options]

  -i, --nic <ip|name>   Network interface to use for Dante (IP address or name, e.g. en6)
  -p, --port <port>     Web UI port (default: 8753)
      --host <address>  Address the web UI listens on (default: 0.0.0.0, all interfaces)
  -d, --data <dir>      Folder for the show file and pictures (default: ./data)
  -c, --config <file>   Config file (default: ./dante-swap.config.json if present)
      --open            Open the UI in the default browser once started
      --demo            Simulated Dante network (rehearse the UI with no hardware)
      --debug           Verbose logging
  -v, --version         Print version and exit
  -h, --help            Show help
```

Environment variables `DANTE_IP`, `PORT`, `HOST`, `DATA_DIR` and `DEBUG=1` work too. Copy `dante-swap.config.example.json` to `dante-swap.config.json` for a persistent config (git-ignored).

### Show file

Everything you set up lives in `data/show.json`, with pictures in `data/images/`. Copy the `data` folder to move a show between computers, or point `--data` at a folder per production. The folder is git-ignored.

---

## How it works

```
Dante devices ──(UDP)──▶ Spare Swap (Node.js) ──(WebSocket)──▶ Browsers
```

| What | How |
|---|---|
| Discovery | mDNS (`_netaudio-arc._udp`, `_netaudio-cmc._udp`), Dante heartbeats, device-info multicast and ARP probing |
| Names, channels, routing | ARC queries (UDP 4440) every 3 s, including canonical Tx channel names (`0x2000`) which receivers use to subscribe |
| Levels | A metering subscription to each device (UDP 8800); devices stream levels to UDP 8751 |
| Routing changes | An ARC subscription message (`0x3010`) to the **receiver**, naming the transmitter device and channel; an empty name clears the subscription |

The receiver is always the device that is told. Transmitters are never configured. Verified on Yamaha Rio3224-D and Dante Virtual Soundcard 4.x (both modern-ARC devices): swap, monitor-main and restore all read back as connected.

### JSON API

| Endpoint | Description |
|---|---|
| `GET /api/show` | Channels, spares and swap state |
| `POST /api/channels`, `PATCH /api/channels/:id`, `DELETE /api/channels/:id` | Manage cards (`{ name, image, tx:{device,channel}, rx:{device,channel}, notes }`) |
| `POST /api/spares`, `PATCH /api/spares/:id`, `DELETE /api/spares/:id` | Manage spares (`{ name, image, tx, rx, monitorMain }`; `rx` is the optional monitor path) |
| `POST /api/reorder` | `{ channels: [ids] }` or `{ spares: [ids] }` (the UI does this when you drag cards in Edit mode) |
| `GET /api/receivers`, `POST /api/receivers`, `PATCH /api/receivers/:id`, `DELETE /api/receivers/:id` | Wireless receivers (`{ name, brand, host, port, username, password, channels }`); GET includes live state and discovered units |
| `GET /api/rf` | Current telemetry for every receiver channel |
| `POST /api/images` | `{ dataUrl }` → `{ file }` (picture stored in the data folder) |
| `POST /api/swap` | `{ channelId, spareId }` → result with each step |
| `POST /api/restore` | `{ channelId }` |
| `POST /api/patch` | `{ rx: {device, channel}, tx: {device, channel} | null }`: set or clear one subscription directly (setup, testing, show control); replies with the receiver's state after 1.5 s |
| `GET /api/history` | Recent swap results |
| `GET /api/devices`, `GET /api/status`, `GET /api/interfaces`, `POST /api/interface`, `POST /api/refresh`, `GET /api/diagnostics` | Network, as in the Meter Bridge (diagnostics: per-device ports, ARC protocol, packet counters, multicast health, plus receiver state) |

These make it straightforward to trigger a swap from a Stream Deck or a show-control system.

## Network & firewall

Allow Node.js to accept incoming connections. The server listens on UDP 8751 (metering), UDP 8702 / 8708 (Dante multicast), UDP 5353 (mDNS) and TCP 8753 (web UI). It sends to devices on UDP 4440, 8700, 8702 and 8800.

## Development

```bash
npm test      # unit + integration tests (node:test)
npm run dev   # restart on file changes
```

`lib/dante/` is the protocol layer, kept in step with the [Dante Meter Bridge](https://github.com/mbsound/Dante-Meter-Bridge) (currently its v2.3.0: modern ARC for Dante Virtual Soundcard and newer devices, the Rx query fix, NIC recovery, trusted mDNS names) plus this app's routing control (`0x3010` subscriptions, canonical Tx names). `packets.js` is pure and unit-tested byte-for-byte. `lib/show/` holds the show file (`store.js`) and the swap sequence (`swap.js`). `lib/rf/` talks to wireless receivers: `shure.js` (command strings), `ssc1.js` (Sound Control over UDP), `ssc2.js` (SSCv2 REST + SSE), `discovery.js` (SLP + mDNS) and `manager.js`. `lib/web/` is the HTTP / WebSocket layer. `public/` is the browser UI.

## License

[MIT](LICENSE)

*Dante is a registered trademark of Audinate Pty Ltd. This project is independent and not affiliated with or endorsed by Audinate.*
