'use strict';

/**
 * The swap: move a main channel's receiver onto a spare transmitter.
 *
 * A main is its receive path; the transmitter it carries (its `tx`) was learned
 * from the receiver's subscription when the card was saved. A spare is its
 * transmit path, which may be feeding any number of receivers right now.
 *
 *   0. If this main was on another spare, exchange that spare's paths back.
 *   1. Receivers the spare feeds on the SAME device as the main's receiver
 *      (a console's "spare" input, say) will be exchanged below. Receivers on
 *      OTHER devices (a listen station) are left alone, unless the spare's
 *      "breakOthers" setting says to clear them.
 *   2. Break the main's own patch, then patch the spare's Tx into the main's Rx
 *      (re-sent once if the receiver doesn't report it).
 *   3. Exchange: each same-device receiver the spare fed now gets the main's
 *      Tx, so the faulty pack can be heard and worked on where the spare used
 *      to be. The list is remembered for restore.
 *   4. Record the swap and verify what the receivers report.
 *
 * Restore puts the main's own Tx back into its Rx (or clears the Rx when no Tx
 * was ever learned), puts the spare's Tx back into every exchanged receiver,
 * and frees the spare.
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
const sameDevice = (a, b) => String(a.device).toLowerCase() === String(b.device).toLowerCase();

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

  /** The receivers a spare's Tx feeds, split into the main's device and the rest. */
  spareReceivers(spare, main) {
    const carried = spare.inUseBy && spare.inUseBy !== main.id ? this.store.show.channels.find((c) => c.id === spare.inUseBy) : null;
    const all = this.engine
      .receiversOf(spare.tx.device, spare.tx.channel)
      .filter((r) => !samePath(r, main.rx) && !(carried && carried.rx && samePath(r, carried.rx)));
    return { same: all.filter((r) => sameDevice(r, main.rx)), others: all.filter((r) => !sameDevice(r, main.rx)) };
  }

  /** Refuse combinations that cannot work before anything is sent. */
  checkSwap(main, spare, force) {
    if (!main.rx) throw new ShowError(`"${main.name}" has no receive path set`);
    if (!spare.tx) throw new ShowError(`Spare "${spare.name}" has no transmit path set`);
    if (main.tx && samePath(main.tx, spare.tx)) throw new ShowError(`Spare "${spare.name}" is the same transmitter "${main.name}" already carries`);
    const { same } = this.spareReceivers(spare, main);
    for (const r of same) {
      const other = this.store.show.channels.find((c) => c.id !== main.id && c.rx && samePath(c.rx, r));
      if (other) throw new ShowError(`Spare "${spare.name}" is feeding "${other.name}"'s receive path (${pathText(r)}); the exchange would take "${other.name}" off air`);
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
      // 0. Leaving another spare: give that spare its exchanged receivers back.
      if (main.spareId && main.spareId !== spare.id) {
        const prev = this.store.show.spares.find((s) => s.id === main.spareId);
        if (prev && prev.tx) await this.exchangeBack(prev, main, steps, `leaving ${prev.name}`);
      }

      // 1. What the spare feeds now.
      if (!this.engine.findDeviceByName(spare.tx.device)) {
        steps.push({ text: `Transmitter "${spare.tx.device}" has not been seen on the network; its existing patches are unknown`, ok: false, warning: true });
      }
      const { same, others } = this.spareReceivers(spare, main);
      for (const r of others) {
        if (!spare.breakOthers) {
          steps.push({ text: `Spare also feeds ${r.device} Rx ${r.channel}: left as is`, ok: true, warning: true });
          continue;
        }
        if (r.online === false) {
          steps.push({ text: `Spare also feeds ${r.device} Rx ${r.channel}, which is offline: left as is`, ok: false, warning: true });
          continue;
        }
        const res = this.engine.unsubscribe({ rxDevice: r.device, rxChannel: r.channel });
        steps.push(step(`Break spare patch ${pathText(spare.tx)} -> ${r.device} Rx ${r.channel}`, res));
        await sleep(this.stepGapMs);
      }
      // The main that was on this spare (force): its receiver is cleared; it is now off air and must say so.
      const bumped = spare.inUseBy && spare.inUseBy !== main.id ? this.store.show.channels.find((c) => c.id === spare.inUseBy) : null;
      if (bumped && bumped.rx) {
        const cleared = this.engine.unsubscribe({ rxDevice: bumped.rx.device, rxChannel: bumped.rx.channel });
        steps.push(step(`Take spare away from ${bumped.name}: clear ${bumped.rx.device} Rx ${bumped.rx.channel}`, cleared));
        await sleep(this.stepGapMs);
      }

      // 2. Break the main's own patch, then patch spare Tx -> main Rx.
      const broke = this.engine.unsubscribe({ rxDevice: main.rx.device, rxChannel: main.rx.channel });
      steps.push(step(`Break main patch -> ${main.rx.device} Rx ${main.rx.channel}`, broke));
      if (!broke.ok) throw new ShowError(broke.error, 502);
      await sleep(this.stepGapMs);
      const patch = () => this.engine.subscribe({ rxDevice: main.rx.device, rxChannel: main.rx.channel, txDevice: spare.tx.device, txChannel: spare.tx.channel });
      const made = patch();
      steps.push(step(`Patch spare ${pathText(spare.tx)} -> ${main.rx.device} Rx ${main.rx.channel}`, made));
      if (!made.ok) throw new ShowError(made.error, 502);
      if (!made.txOnline) steps.push({ text: `Transmitter "${spare.tx.device}" is not on the network right now`, ok: false, warning: true });

      // 3. Exchange: the main's Tx goes where the spare's Tx was on the same device.
      const exchanged = [];
      const verifies = [];
      for (const r of same) {
        if (!main.tx) {
          steps.push({ text: `Spare also feeds ${r.device} Rx ${r.channel}; "${main.name}" has no transmitter to exchange, left as is`, ok: true, warning: true });
          continue;
        }
        await sleep(this.stepGapMs);
        const ex = this.engine.subscribe({ rxDevice: r.device, rxChannel: r.channel, txDevice: main.tx.device, txChannel: main.tx.channel });
        steps.push(step(`Exchange: main ${pathText(main.tx)} -> ${r.device} Rx ${r.channel}`, ex));
        if (ex.ok) {
          exchanged.push({ device: r.device, channel: r.channel });
          verifies.push([{ device: r.device, channel: r.channel }, { device: ex.txName, channel: ex.txChannelName }]);
        }
      }

      // 4. Bookkeeping, then verify (re-sending the main patch once if it didn't land).
      this.store.setOnSpare(main.id, spare.id, exchanged);
      if (bumped) {
        this.record({ type: 'swap', at: Date.now(), ok: false, channelId: bumped.id, spareId: spare.id, title: `${bumped.name} taken off spare ${spare.name}`, steps: [{ text: `${bumped.name} is now UNPATCHED: ${spare.name} went to ${main.name}. Restore or swap it to another spare.`, ok: false }] });
      }
      steps.push(await this.verifyWithRetry(main.rx, { device: made.txName, channel: made.txChannelName }, patch, steps));
      for (const [rxPath, expected] of verifies) steps.push(await this.verify(rxPath, expected, 0));
      return this.record({ ...result, ok: steps.every((s) => s.ok || s.warning) });
    } catch (err) {
      this.record({ ...result, ok: false, error: err.message });
      throw err;
    } finally {
      this.busy = false;
    }
  }

  /** Put the spare's Tx back into every receiver the swap exchanged. */
  async exchangeBack(spare, main, steps, why) {
    for (const r of main.exchanged || []) {
      await sleep(this.stepGapMs);
      const back = this.engine.subscribe({ rxDevice: r.device, rxChannel: r.channel, txDevice: spare.tx.device, txChannel: spare.tx.channel });
      steps.push(step(`Spare ${pathText(spare.tx)} back -> ${r.device} Rx ${r.channel}${why ? ` (${why})` : ''}`, back));
      if (back.ok) steps.push(await this.verify(r, { device: back.txName, channel: back.txChannelName }));
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
        // No transmitter was ever learned for this main: just take the spare out of its receiver.
        made = this.engine.unsubscribe({ rxDevice: main.rx.device, rxChannel: main.rx.channel });
        steps.push(step(`Clear ${main.rx.device} Rx ${main.rx.channel} ("${main.name}" has no transmitter on record)`, made));
        if (!made.ok) throw new ShowError(made.error, 502);
      }
      const spare = spareId ? this.store.show.spares.find((s) => s.id === spareId) : null;
      if (spare && spare.tx) await this.exchangeBack(spare, main, steps, '');
      this.store.setOnSpare(main.id, null);
      if (patch) steps.push(await this.verifyWithRetry(main.rx, { device: made.txName, channel: made.txChannelName }, patch, steps));
      else steps.push(await this.verifyCleared(main.rx));
      return this.record({ ...result, ok: steps.every((s) => s.ok || s.warning) });
    } catch (err) {
      this.record({ ...result, ok: false, error: err.message });
      throw err;
    } finally {
      this.busy = false;
    }
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
