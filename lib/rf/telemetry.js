'use strict';

/**
 * One normalised picture of a wireless receiver channel, whatever the brand:
 *
 *   {
 *     name, txName, txModel,
 *     frequencyKHz,
 *     af:        audio level in dBFS (null = unknown),
 *     rssi:      [dBm per antenna A, B (, C, D)]  (null entries = unknown),
 *     antennas:  ['B','B'] per-antenna state letters (Shure: X off, B blue, R red; Sennheiser: active antenna marked 'B'),
 *     quality:   0..100 link quality (null = unknown),
 *     battery:   { percent, minutes, bars, type } (null fields = unknown),
 *     mute:      true/false/null (transmitter or channel mute),
 *     warnings:  ['Interference', ...],
 *     updatedAt: ms timestamp of the last value
 *   }
 */

function emptyChannel(number) {
  return {
    number,
    name: null,
    txName: null,
    txModel: null,
    frequencyKHz: null,
    af: null,
    afPeak: null,
    rssi: [null, null],
    antennas: [],
    quality: null,
    battery: { percent: null, minutes: null, bars: null, type: null },
    mute: null,
    warnings: [],
    updatedAt: 0
  };
}

/** Clamp a number into [lo, hi]; non-numbers become null. */
function num(value, lo = -Infinity, hi = Infinity) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(lo, Math.min(hi, n));
}

const BRANDS = {
  'shure-ad': { label: 'Shure Axient Digital (AD4D / AD4Q / ANX4)', transport: 'shure', port: 2202, auth: false, channels: 4 },
  'sennheiser-ewdx': { label: 'Sennheiser EW-DX (firmware 4.0+)', transport: 'ssc2', port: 443, auth: true, user: 'api', channels: 4 },
  'sennheiser-ewdx-v1': { label: 'Sennheiser EW-DX (firmware < 4.0)', transport: 'ssc1', port: 45, auth: false, channels: 4 },
  'sennheiser-6000': { label: 'Sennheiser EM 6000 (SSC, unverified)', transport: 'ssc1', port: 45, auth: false, channels: 2 },
  'sennheiser-spectera': { label: 'Sennheiser Spectera base station', transport: 'ssc2', port: 443, auth: true, user: 'controlSennheiser', channels: 32 }
};

module.exports = { emptyChannel, num, BRANDS };
