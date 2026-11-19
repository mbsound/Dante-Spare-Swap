'use strict';

/**
 * The swap: move a main channel's receiver onto a spare transmitter.
 *
 *   0. If this main was on another spare, put that spare's own Tx back into
 *      its monitor input first.
 *   1. If the spare's Tx is patched to any receiver, break those patches.
 *   2. Break the main's own Tx -> Rx patch.
 *   3. Patch the spare's Tx into the main's Rx (re-sent once if the receiver
 *      doesn't report it).
 *   4. If the spare has a monitor path and "monitor main" is on, patch the
 *      main's Tx into the spare's monitor input so the faulty pack can be
 *      worked on from the console.
 *   5. Record the swap in the show file and verify the receiver(s) took it.
 *
 * Restore puts the main's own Tx back into its Rx (or clears the Rx when the
 * main has no Tx), puts the spare's own Tx back into its monitor input (if it
 * has one), and frees the spare. Every step is reported so the operator can
 * see exactly what was sent.
 *
 * A spare already carrying another main is refused unless `force` is given:
 * taking it would put that main off air, and the operator must say so.
 */

const { EventEmitter } = require('events');
const { ShowError, samePath } = require('./store');
const { RX_CONNECTED_STATUSES } = require('../dante/constants');

const STEP_GAP_MS = 120;
const VERIFY_AFTER_MS = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pathText = (p) => `${p.device} / ${p.channel}`;

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

  /** Refuse combinations that cannot work before anything is sent. */
  checkSwap(main, spare, force) {
    if (!main.rx) throw new ShowError(`"${main.name}" has no receive path set`);
    if (!spare.tx) throw new ShowError(`Spare "${spare.name}" has no transmit path set`);
    if (main.tx && samePath(main.tx, spare.tx)) throw new ShowError(`Spare "${spare.name}" uses the same transmitter as "${main.name}"`);
    if (spare.rx && samePath(spare.rx, main.rx)) {
      throw new ShowError(`Spare "${spare.name}"'s monitor input is the same receiver as "${main.name}"'s receive path`);
    }
    if (spare.rx && spare.monitorMain) {
      const clash = this.store.show.channels.find((c) => c.id !== main.id && c.rx && samePath(c.rx, spare.rx));
      if (clash) throw new ShowError(`Spare "${spare.name}"'s monitor input is "${clash.name}"'s receive path; monitoring the main there would take "${clash.name}" off air`);
    }
    if (spare.inUseBy && spare.inUseBy !== main.id) {
      const other = this.store.show.channels.find((c) => c.id === spare.inUseBy);
      if (other && !force) {
        const err = new ShowError(`Spare "${spare.name}" is carrying "${other.name}". Taking it would leave "${other.name}" unpatched.`, 409);
        err.code = 'spare-in-use';
        err.inUseBy = { id: other.id, name: other.name };
        throw err;
      }
    }
  }

  /** Main `channelId` goes onto spare `spareId`. `force` takes the spare away from another main. */
  async swap(channelId, spareId, { force = false } = {}) {
    if (this.busy) throw new ShowError('Another swap is in progress', 409);
    // Work from copies: the show file can be edited by another screen while
    // the steps run, and every step must use the paths the operator saw.
    const main = structuredClone(this.store.channel(channelId));
    const spare = structuredClone(this.store.spare(spareId));
    this.checkSwap(main, spare, force);

    this.busy = true;
    const steps = [];
    const started = Date.now();
    const result = { type: 'swap', at: started, channelId: main.id, spareId: spare.id, title: `${main.name} -> spare ${spare.name}`, steps };
    try {
      const monitorMain = Boolean(spare.monitorMain && spare.rx && main.tx);

      // 0. Leaving another spare: give that spare its monitor input back.
      if (main.spareId && main.spareId !== spare.id) {
        const prev = this.store.show.spares.find((s) => s.id === main.spareId);
        if (prev && prev.rx && prev.tx && this.monitorsMain(prev, main)) {
          const back = this.engine.subscribe({ rxDevice: prev.rx.device, rxChannel: prev.rx.channel, txDevice: prev.tx.device, txChannel: prev.tx.channel });
          steps.push(step(`Spare ${pathText(prev.tx)} back -> ${prev.rx.device} Rx ${prev.rx.channel} (leaving ${prev.name})`, back));
          await sleep(this.stepGapMs);
        }
      }

      // 1. Break anything the spare currently feeds (other than this main's Rx).
      if (!this.engine.findDeviceByName(spare.tx.device)) {
        steps.push({ text: `Transmitter "${spare.tx.device}" has not been seen on the network; any existing patches from it were not cleared`, ok: false, warning: true });
      }
      const receivers = this.engine.receiversOf(spare.tx.device, spare.tx.channel);
      for (const r of receivers) {
        if (samePath({ device: r.device, channel: r.channel }, main.rx)) continue;
        if (monitorMain && samePath({ device: r.device, channel: r.channel }, spare.rx)) continue; // repatched below
        if (r.online === false) {
          // Can't be told right now; it keeps its subscription until it returns. Not a failure of this swap.
          steps.push({ text: `Spare also feeds ${r.device} Rx ${r.channel}, which is offline: left as is`, ok: false, warning: true });
          continue;
        }
        const res = this.engine.unsubscribe({ rxDevice: r.device, rxChannel: r.channel });
        steps.push(step(`Break spare patch ${pathText(spare.tx)} -> ${r.device} Rx ${r.channel}`, res));
        await sleep(this.stepGapMs);
      }
      // The main that was on this spare (force): it is now off air and must say so.
      const bumped = spare.inUseBy && spare.inUseBy !== main.id ? this.store.show.channels.find((c) => c.id === spare.inUseBy) : null;

      // 2. Break the main's own patch.
      const broke = this.engine.unsubscribe({ rxDevice: main.rx.device, rxChannel: main.rx.channel });
      steps.push(step(`Break main patch -> ${main.rx.device} Rx ${main.rx.channel}`, broke));
      if (!broke.ok) throw new ShowError(broke.error, 502);
      await sleep(this.stepGapMs);

      // 3. Patch spare Tx -> main Rx.
      const patch = () => this.engine.subscribe({ rxDevice: main.rx.device, rxChannel: main.rx.channel, txDevice: spare.tx.device, txChannel: spare.tx.channel });
      const made = patch();
      steps.push(step(`Patch spare ${pathText(spare.tx)} -> ${main.rx.device} Rx ${main.rx.channel}`, made));
      if (!made.ok) throw new ShowError(made.error, 502);
      if (!made.txOnline) steps.push({ text: `Transmitter "${spare.tx.device}" is not on the network right now`, ok: false, warning: true });

      // 4. Main Tx -> spare's monitor input, if the operator asked for it.
      let monitor = null;
      if (monitorMain) {
        await sleep(this.stepGapMs);
        monitor = this.engine.subscribe({ rxDevice: spare.rx.device, rxChannel: spare.rx.channel, txDevice: main.tx.device, txChannel: main.tx.channel });
        steps.push(step(`Monitor main ${pathText(main.tx)} -> ${spare.rx.device} Rx ${spare.rx.channel}`, monitor));
        if (!monitor.ok) monitor = null; // the swap itself still stands
      }

      // 5. Bookkeeping, then verify (re-sending the main patch once if it didn't land).
      this.store.setOnSpare(main.id, spare.id);
      if (bumped) {
        this.record({ type: 'swap', at: Date.now(), ok: false, channelId: bumped.id, spareId: spare.id, title: `${bumped.name} taken off spare ${spare.name}`, steps: [{ text: `${bumped.name} is now UNPATCHED: ${spare.name} went to ${main.name}. Restore or swap it to another spare.`, ok: false }] });
      }
      steps.push(await this.verifyWithRetry(main.rx, { device: made.txName, channel: made.txChannelName }, patch, steps));
      if (monitor) steps.push(await this.verify(spare.rx, { device: monitor.txName, channel: monitor.txChannelName }, 0));
      return this.record({ ...result, ok: steps.every((s) => s.ok || s.warning) });
    } catch (err) {
      this.record({ ...result, ok: false, error: err.message });
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** Put `channelId` back on its own transmitter (or clear its Rx) and free its spare. */
  async restore(channelId) {
    if (this.busy) throw new ShowError('Another swap is in progress', 409);
    const main = structuredClone(this.store.channel(channelId));
    if (!main.rx) throw new ShowError(`"${main.name}" has no receive path set`);

    this.busy = true;
    const steps = [];
    const started = Date.now();
    const spareId = main.spareId;
    const result = { type: 'restore', at: started, channelId: main.id, spareId, title: `${main.name} back on main`, steps };
    try {
      let patch = null;
      let made;
      if (main.tx) {
        patch = () => this.engine.subscribe({ rxDevice: main.rx.device, rxChannel: main.rx.channel, txDevice: main.tx.device, txChannel: main.tx.channel });
        made = patch();
        steps.push(step(`Patch main ${pathText(main.tx)} -> ${main.rx.device} Rx ${main.rx.channel}`, made));
        if (!made.ok) throw new ShowError(made.error, 502);
        if (!made.txOnline) steps.push({ text: `Transmitter "${main.tx.device}" is not on the network right now`, ok: false, warning: true });
      } else {
        // No transmitter of its own: just take the spare out of its receiver.
        made = this.engine.unsubscribe({ rxDevice: main.rx.device, rxChannel: main.rx.channel });
        steps.push(step(`Clear ${main.rx.device} Rx ${main.rx.channel} ("${main.name}" has no transmit path)`, made));
        if (!made.ok) throw new ShowError(made.error, 502);
      }
      const spare = spareId ? this.store.show.spares.find((s) => s.id === spareId) : null;
      let back = null;
      if (spare && spare.rx && spare.tx && this.monitorsMain(spare, main)) {
        await sleep(this.stepGapMs);
        back = this.engine.subscribe({ rxDevice: spare.rx.device, rxChannel: spare.rx.channel, txDevice: spare.tx.device, txChannel: spare.tx.channel });
        steps.push(step(`Spare ${pathText(spare.tx)} back -> ${spare.rx.device} Rx ${spare.rx.channel}`, back));
        if (!back.ok) back = null;
      }
      this.store.setOnSpare(main.id, null);
      if (patch) steps.push(await this.verifyWithRetry(main.rx, { device: made.txName, channel: made.txChannelName }, patch, steps));
      else steps.push(await this.verifyCleared(main.rx));
      if (back) steps.push(await this.verify(spare.rx, { device: back.txName, channel: back.txChannelName }, 0));
      return this.record({ ...result, ok: steps.every((s) => s.ok || s.warning) });
    } catch (err) {
      this.record({ ...result, ok: false, error: err.message });
      throw err;
    } finally {
      this.busy = false;
    }
  }

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

  /** Verify; if the receiver reports something else, send the patch once more and verify again. */
  async verifyWithRetry(rxPath, expected, resend, steps) {
    const first = await this.verify(rxPath, expected);
    if (first.ok) return first;
    steps.push({ ...first, text: `${first.text}; sending again`, ok: false, warning: true });
    const again = resend();
    if (!again.ok) return { text: `Re-send failed: ${again.error}`, ok: false };
    return this.verify(rxPath, expected);
  }

  /** Wait for the receiver to re-report and compare against what we asked for. */
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

  async verifyCleared(rxPath, delay = this.verifyAfterMs) {
    await sleep(delay);
    const state = this.engine.rxState(rxPath.device, rxPath.channel);
    if (!state) return { text: 'Verify: receiver did not report back', ok: false };
    if (state.subscribedDevice) return { text: `Verify: receiver still reports ${state.subscribedDevice}/${state.subscribedChannel}`, ok: false };
    return { text: `Verified: ${rxPath.device} Rx ${rxPath.channel} is clear`, ok: true };
  }
}

function step(text, res) {
  return res.ok ? { text, ok: true } : { text: `${text}: ${res.error}`, ok: false };
}

module.exports = { SwapController };
