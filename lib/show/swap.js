'use strict';

/**
 * The swap: move a main channel's receiver onto a spare transmitter.
 *
 *   1. If the spare's Tx is patched to any receiver, break those patches.
 *   2. Break the main's own Tx -> Rx patch.
 *   3. Patch the spare's Tx into the main's Rx.
 *   4. If the spare has a monitor path and "monitor main" is on, patch the
 *      main's Tx into the spare's monitor input so the faulty pack can be
 *      worked on from the console.
 *   5. Record the swap in the show file and verify the receiver(s) took it.
 *
 * Restore puts the main's own Tx back into its Rx, puts the spare's own Tx
 * back into its monitor input (if it has one), and frees the spare.
 * Every step is reported so the operator can see exactly what was sent.
 */

const { EventEmitter } = require('events');
const { ShowError, samePath } = require('./store');
const { RX_CONNECTED_STATUSES } = require('../dante/constants');

const STEP_GAP_MS = 120;
const VERIFY_AFTER_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class SwapController extends EventEmitter {
  constructor({ engine, store, log = console, stepGapMs = STEP_GAP_MS, verifyAfterMs = VERIFY_AFTER_MS } = {}) {
    super();
    this.engine = engine;
    this.store = store;
    this.log = log;
    this.stepGapMs = stepGapMs;
    this.verifyAfterMs = verifyAfterMs;
    this.busy = false;
    this.history = [];
  }

  record(entry) {
    this.history.unshift(entry);
    this.history.length = Math.min(this.history.length, 50);
    this.emit('result', entry);
    return entry;
  }

  /** Main `channelId` goes onto spare `spareId`. */
  async swap(channelId, spareId) {
    if (this.busy) throw new ShowError('Another swap is in progress', 409);
    const main = this.store.channel(channelId);
    const spare = this.store.spare(spareId);
    if (!main.rx) throw new ShowError(`"${main.name}" has no receive path set`);
    if (!spare.tx) throw new ShowError(`Spare "${spare.name}" has no transmit path set`);
    if (main.tx && samePath(main.tx, spare.tx)) throw new ShowError(`Spare "${spare.name}" uses the same transmitter as "${main.name}"`);

    this.busy = true;
    const steps = [];
    const started = Date.now();
    try {
      // 1. Break anything the spare currently feeds (other than this main's Rx).
      const monitorMain = Boolean(spare.monitorMain && spare.rx && main.tx);
      const receivers = this.engine.receiversOf(spare.tx.device, spare.tx.channel);
      for (const r of receivers) {
        if (samePath({ device: r.device, channel: r.channel }, main.rx)) continue;
        if (monitorMain && samePath({ device: r.device, channel: r.channel }, spare.rx)) continue; // repatched below
        const res = this.engine.unsubscribe({ rxDevice: r.device, rxChannel: r.channel });
        steps.push(step(`Break spare patch ${spare.tx.device}/${spare.tx.channel} -> ${r.device} Rx ${r.channel}`, res));
        await sleep(this.stepGapMs);
      }
      // 2. Break the main's own patch.
      const broke = this.engine.unsubscribe({ rxDevice: main.rx.device, rxChannel: main.rx.channel });
      steps.push(step(`Break main patch -> ${main.rx.device} Rx ${main.rx.channel}`, broke));
      if (!broke.ok) throw new ShowError(broke.error, 502);
      await sleep(this.stepGapMs);
      // 3. Patch spare Tx -> main Rx.
      const made = this.engine.subscribe({
        rxDevice: main.rx.device,
        rxChannel: main.rx.channel,
        txDevice: spare.tx.device,
        txChannel: spare.tx.channel
      });
      steps.push(step(`Patch spare ${spare.tx.device}/${spare.tx.channel} -> ${main.rx.device} Rx ${main.rx.channel}`, made));
      if (!made.ok) throw new ShowError(made.error, 502);
      if (!made.txOnline) steps.push({ text: `Transmitter "${spare.tx.device}" is not on the network right now`, ok: false, warning: true });

      // 4. Main Tx -> spare's monitor input, if the operator asked for it.
      let monitor = null;
      if (monitorMain) {
        await sleep(this.stepGapMs);
        monitor = this.engine.subscribe({ rxDevice: spare.rx.device, rxChannel: spare.rx.channel, txDevice: main.tx.device, txChannel: main.tx.channel });
        steps.push(step(`Monitor main ${main.tx.device}/${main.tx.channel} -> ${spare.rx.device} Rx ${spare.rx.channel}`, monitor));
        if (!monitor.ok) monitor = null; // the swap itself still stands
      }

      // 5. Bookkeeping, then verify.
      this.store.setOnSpare(main.id, spare.id);
      const verify = await this.verify(main.rx, { device: made.txName, channel: made.txChannelName });
      steps.push(verify);
      if (monitor) steps.push(await this.verify(spare.rx, { device: monitor.txName, channel: monitor.txChannelName }, 0));
      return this.record({
        type: 'swap',
        at: started,
        ok: steps.every((s) => s.ok || s.warning),
        channelId: main.id,
        spareId: spare.id,
        title: `${main.name} -> spare ${spare.name}`,
        steps
      });
    } catch (err) {
      this.record({ type: 'swap', at: started, ok: false, channelId: main.id, spareId: spare.id, title: `${main.name} -> spare ${spare.name}`, steps, error: err.message });
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** Put `channelId` back on its own transmitter and free its spare. */
  async restore(channelId) {
    if (this.busy) throw new ShowError('Another swap is in progress', 409);
    const main = this.store.channel(channelId);
    if (!main.rx) throw new ShowError(`"${main.name}" has no receive path set`);
    if (!main.tx) throw new ShowError(`"${main.name}" has no transmit path set`);

    this.busy = true;
    const steps = [];
    const started = Date.now();
    try {
      const made = this.engine.subscribe({ rxDevice: main.rx.device, rxChannel: main.rx.channel, txDevice: main.tx.device, txChannel: main.tx.channel });
      steps.push(step(`Patch main ${main.tx.device}/${main.tx.channel} -> ${main.rx.device} Rx ${main.rx.channel}`, made));
      if (!made.ok) throw new ShowError(made.error, 502);
      if (!made.txOnline) steps.push({ text: `Transmitter "${main.tx.device}" is not on the network right now`, ok: false, warning: true });
      const spareId = main.spareId;
      const spare = spareId ? this.store.show.spares.find((s) => s.id === spareId) : null;
      let back = null;
      if (spare && spare.rx && spare.tx && this.monitorsMain(spare, main)) {
        await sleep(this.stepGapMs);
        back = this.engine.subscribe({ rxDevice: spare.rx.device, rxChannel: spare.rx.channel, txDevice: spare.tx.device, txChannel: spare.tx.channel });
        steps.push(step(`Spare ${spare.tx.device}/${spare.tx.channel} back -> ${spare.rx.device} Rx ${spare.rx.channel}`, back));
        if (!back.ok) back = null;
      }
      this.store.setOnSpare(main.id, null);
      const verify = await this.verify(main.rx, { device: made.txName, channel: made.txChannelName });
      steps.push(verify);
      if (back) steps.push(await this.verify(spare.rx, { device: back.txName, channel: back.txChannelName }, 0));
      return this.record({
        type: 'restore',
        at: started,
        ok: steps.every((s) => s.ok || s.warning),
        channelId: main.id,
        spareId,
        title: `${main.name} back on main`,
        steps
      });
    } catch (err) {
      this.record({ type: 'restore', at: started, ok: false, channelId: main.id, title: `${main.name} back on main`, steps, error: err.message });
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** Wait for the receiver to re-report and compare against what we asked for. */
  /** Is the spare's monitor input currently carrying this main's transmitter? */
  monitorsMain(spare, main) {
    if (!spare.rx || !main.tx) return false;
    const state = this.engine.rxState(spare.rx.device, spare.rx.channel);
    if (!state || !state.subscribedDevice) return Boolean(spare.monitorMain);
    const txName = this.engine.txSubscriptionName(main.tx.device, main.tx.channel);
    return (
      state.subscribedDevice.toLowerCase() === String(main.tx.device).toLowerCase() &&
      String(state.subscribedChannel || '').toLowerCase() === String(txName).toLowerCase()
    );
  }

  async verify(rxPath, expected, delay = this.verifyAfterMs) {
    await sleep(delay);
    const state = this.engine.rxState(rxPath.device, rxPath.channel);
    if (!state) return { text: 'Verify: receiver did not report back', ok: false };
    const devOk = state.subscribedDevice && state.subscribedDevice.toLowerCase() === String(expected.device).toLowerCase();
    const chOk = state.subscribedChannel && state.subscribedChannel.toLowerCase() === String(expected.channel).toLowerCase();
    if (!devOk || !chOk) {
      const have = state.subscribedDevice ? `${state.subscribedDevice}/${state.subscribedChannel}` : 'nothing';
      return { text: `Verify: receiver reports ${have}, expected ${expected.device}/${expected.channel}`, ok: false };
    }
    const connected = RX_CONNECTED_STATUSES.has(state.status);
    return connected
      ? { text: `Verified: ${rxPath.device} Rx ${rxPath.channel} <- ${expected.device}/${expected.channel} (audio flowing)`, ok: true }
      : { text: `Patched: ${rxPath.device} Rx ${rxPath.channel} <- ${expected.device}/${expected.channel}, not yet connected (status ${state.status})`, ok: true, warning: true };
  }
}

function step(text, res) {
  return res.ok ? { text, ok: true } : { text: `${text}: ${res.error}`, ok: false };
}

module.exports = { SwapController };
