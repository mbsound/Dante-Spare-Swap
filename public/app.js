/**
 * Dante Spare Swap — browser UI.
 *
 * Server messages (WebSocket /ws):
 *   hello   { version, boundIp, name, interfaces[], history[] }
 *   devices [ device structure … ]
 *   show    { name, channels[], spares[] }
 *   meters  { t, d: { ip: { tx:[byte|null], rx:[byte|null] } } }  (20 Hz)
 *   result  { type, ok, title, steps[] }
 */
(function () {
  'use strict';

  const { byteToDbfs, dbfsToNormalized, isClipByte } = window.DanteLevels;

  const CLIP_LATCH_MS = 1500;
  const PEAK_HOLD_MS = 1000;
  const PEAK_DECAY_PER_SEC = 0.6;
  const SEGMENTS = 30;
  const IMAGE_MAX_PX = 640;
  const EDIT_KEY = 'dss.editing';

  const COLORS = { track: '#0a0c10', off: '#161922', red: '#ff1744', amber: '#ff9100', yellow: '#ffd600', green: '#00e676', hold: '#ffffff' };

  const state = {
    devices: new Map(), // ip -> device
    devicesByName: new Map(), // lower-case name -> device
    meters: {},
    show: { name: 'Untitled Show', channels: [], spares: [] },
    selectedChannel: null,
    selectedSpare: null,
    interfaces: [],
    activeIp: null,
    history: [],
    holds: new Map(),
    clipUntil: new Map(),
    editing: false,
    swapping: false,
    rf: {}, // receiverId -> { online, model, deviceId, channels }
    brands: {}
  };

  const drag = { id: null, kind: null, container: null }; // in-progress card drag

  const $ = (id) => document.getElementById(id);
  const els = {
    statusDot: $('statusDot'),
    statusText: $('statusText'),
    nicSelect: $('nicSelect'),
    showName: $('showName'),
    showCounts: $('showCounts'),
    addChannel: $('btnAddChannel'),
    addSpare: $('btnAddSpare'),
    edit: $('btnEdit'),
    refresh: $('btnRefresh'),
    fullscreen: $('btnFullscreen'),
    grid: $('cardsGrid'),
    channelsEmpty: $('channelsEmpty'),
    sparesList: $('sparesList'),
    sparesEmpty: $('sparesEmpty'),
    selMain: $('selMain'),
    selMainText: $('selMainText'),
    selSpare: $('selSpare'),
    selSpareText: $('selSpareText'),
    swap: $('btnSwap'),
    restore: $('btnRestore'),
    resultText: $('resultText'),
    historyDrawer: $('historyDrawer'),
    historyList: $('historyList'),
    closeHistory: $('btnCloseHistory'),
    toast: $('toast'),
    receivers: $('btnReceivers')
  };

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return parts.slice(0, 2).map((p) => p[0].toUpperCase()).join('');
  }

  function pathText(p) {
    return p ? `${p.device} / ${p.channel}` : '— not set —';
  }

  function samePath(a, b) {
    return Boolean(a && b) && a.device.toLowerCase() === b.device.toLowerCase() && Number(a.channel) === Number(b.channel);
  }

  function deviceByName(name) {
    return name ? state.devicesByName.get(String(name).trim().toLowerCase()) || null : null;
  }

  /** Name a receiver uses to refer to this Tx channel (friendly or canonical). */
  function txSubName(path) {
    const dev = deviceByName(path.device);
    const ch = dev && dev.tx.channels[path.channel];
    return (ch && ch.subscriptionName) || String(path.channel).padStart(2, '0');
  }

  function txChannelLabel(path) {
    const dev = deviceByName(path.device);
    const ch = dev && dev.tx.channels[path.channel];
    return ch ? ch.name : `Tx ${path.channel}`;
  }

  /** Does the Rx subscription record point at this Tx path? */
  function rxPointsAt(rxRec, txPath) {
    if (!rxRec || !rxRec.subscribedDevice || !txPath) return false;
    if (rxRec.subscribedDevice.toLowerCase() !== txPath.device.toLowerCase()) return false;
    const have = String(rxRec.subscribedChannel || '').toLowerCase();
    return have === txSubName(txPath).toLowerCase() || have === String(txPath.channel).padStart(2, '0');
  }

  function levelFor(path, dir) {
    if (!path) return null;
    const dev = deviceByName(path.device);
    if (!dev) return null;
    const frame = state.meters[dev.ip];
    const arr = frame && frame[dir];
    const v = arr ? arr[path.channel - 1] : undefined;
    return v === undefined ? null : v;
  }

  function formatDbfs(dbfs, clip, hasData) {
    if (!hasData) return '—';
    if (clip) return 'CLIP';
    if (!isFinite(dbfs) || dbfs <= -60) return '-∞';
    return `${dbfs.toFixed(0)} dB`;
  }

  function spareById(id) {
    return state.show.spares.find((s) => s.id === id) || null;
  }

  function channelById(id) {
    return state.show.channels.find((c) => c.id === id) || null;
  }

  /**
   * Live status of a main channel, derived from what its receiver reports.
   *   main      — receiver is on the channel's own transmitter
   *   on-spare  — receiver is on one of the declared spares
   *   unpatched — receiver has no subscription
   *   other     — receiver is on something else
   *   unknown   — receiver not on the network / no Rx path set
   */
  function channelStatus(ch) {
    if (!ch.rx) return { kind: 'unknown', label: 'NO RX PATH', detail: 'Set a receive path in settings' };
    const rxDev = deviceByName(ch.rx.device);
    if (!rxDev) return { kind: 'unknown', label: 'RX OFFLINE', detail: `${ch.rx.device} not found on the network` };
    if (!rxDev.online) return { kind: 'unknown', label: 'RX OFFLINE', detail: `${rxDev.name} is offline` };
    const rec = rxDev.rx.channels[ch.rx.channel];
    if (!rec) return { kind: 'unknown', label: 'RX ?', detail: `${rxDev.name} has not reported Rx ${ch.rx.channel}` };
    if (!rec.subscribedDevice) return { kind: 'unpatched', label: 'UNPATCHED', detail: `${rxDev.name} Rx ${ch.rx.channel} has no source` };
    if (ch.tx && rxPointsAt(rec, ch.tx)) {
      return { kind: 'main', label: rec.connected ? 'MAIN' : 'MAIN · connecting', detail: `On own transmitter ${pathText(ch.tx)}`, connected: rec.connected };
    }
    const spare = state.show.spares.find((s) => s.tx && rxPointsAt(rec, s.tx));
    if (spare) {
      return { kind: 'on-spare', label: `ON SPARE · ${spare.name}`, detail: `Running on ${spare.name} (${pathText(spare.tx)})`, spare, connected: rec.connected };
    }
    return { kind: 'other', label: 'OTHER SOURCE', detail: `Receiver is on ${rec.subscribedDevice} / ${rec.subscribedChannel}`, connected: rec.connected };
  }

  function spareStatus(sp) {
    const main = sp.inUseBy ? channelById(sp.inUseBy) : null;
    if (!sp.tx) return { kind: 'unknown', label: 'NO TX PATH', main };
    const dev = deviceByName(sp.tx.device);
    const online = dev && dev.online;
    if (main) return { kind: 'in-use', label: `→ ${main.name}`, main, online };
    // Anything on the network currently fed by this spare?
    let fedBy = null;
    for (const d of state.devices.values()) {
      for (const rec of Object.values(d.rx.channels || {})) {
        if (rxPointsAt(rec, sp.tx)) fedBy = `${d.name} Rx ${rec.number}`;
      }
    }
    if (fedBy) return { kind: 'in-use', label: `PATCHED · ${fedBy}`, main: null, online, fedBy };
    return { kind: 'free', label: online ? 'FREE' : 'FREE · tx offline', main: null, online };
  }

  // ---------------------------------------------------------------------------
  // WebSocket + API
  // ---------------------------------------------------------------------------

  let ws = null;
  let reconnectDelay = 1000;

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);
    ws.onopen = () => {
      reconnectDelay = 1000;
      setStatus('live', 'Live');
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleMessage(msg);
    };
    ws.onclose = () => {
      setStatus('warning', 'Disconnected — reconnecting…');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
    };
  }

  function send(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
    return data;
  }

  function setStatus(kind, text) {
    els.statusDot.className = `status-dot ${kind}`;
    els.statusText.textContent = text;
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'hello':
        state.activeIp = msg.data.boundIp;
        state.interfaces = msg.data.interfaces || [];
        if (msg.data.brands) state.brands = msg.data.brands;
        if (Array.isArray(msg.data.history)) {
          state.history = msg.data.history;
          renderResult(state.history[0]);
        }
        populateNicSelect();
        if (ws && ws.readyState === WebSocket.OPEN) setStatus('live', 'Live');
        break;
      case 'devices':
        state.devices = new Map(msg.data.map((d) => [d.ip, d]));
        state.devicesByName = new Map();
        for (const d of msg.data) state.devicesByName.set(d.name.toLowerCase(), d);
        renderAll();
        if (modal.open) refreshModalDeviceLists();
        break;
      case 'show':
        state.show = msg.data;
        if (document.activeElement !== els.showName) els.showName.value = state.show.name;
        if (state.selectedChannel && !channelById(state.selectedChannel)) state.selectedChannel = null;
        if (state.selectedSpare && !spareById(state.selectedSpare)) state.selectedSpare = null;
        renderAll();
        if (rxModal.open) renderRxList();
        if (modal.open) fillRfEditor(readRfLink());
        break;
      case 'meters':
        state.meters = msg.d || {};
        break;
      case 'rf':
        state.rf = msg.d || {};
        if (rxModal.open) renderRxList();
        break;
      case 'result':
        state.history.unshift(msg.data);
        state.history.length = Math.min(state.history.length, 50);
        renderResult(msg.data);
        if (!els.historyDrawer.hidden) renderHistory();
        break;
    }
  }

  // ---------------------------------------------------------------------------
  // Header controls
  // ---------------------------------------------------------------------------

  function populateNicSelect() {
    const select = els.nicSelect;
    select.textContent = '';
    const all = el('option', null, 'All Interfaces');
    all.value = 'all';
    select.appendChild(all);
    for (const nic of state.interfaces) {
      const opt = el('option', null, `${nic.name} - ${nic.address}${nic.isDanteLinkLocal ? ' [Dante]' : ''}`);
      opt.value = nic.address;
      select.appendChild(opt);
    }
    select.value = state.activeIp && state.interfaces.some((i) => i.address === state.activeIp) ? state.activeIp : 'all';
  }

  els.nicSelect.addEventListener('change', () => {
    setStatus('warning', 'Switching interface…');
    const ip = els.nicSelect.value;
    if (!send({ type: 'select_interface', ip })) api('POST', '/api/interface', { ip }).catch(() => {});
  });

  els.refresh.addEventListener('click', () => {
    els.refresh.disabled = true;
    setTimeout(() => (els.refresh.disabled = false), 800);
    if (!send({ type: 'refresh' })) api('POST', '/api/refresh').catch(() => {});
  });

  els.fullscreen.addEventListener('click', () => {
    const doc = document;
    const root = doc.documentElement;
    if (doc.fullscreenElement || doc.webkitFullscreenElement) (doc.exitFullscreen || doc.webkitExitFullscreen).call(doc);
    else {
      const request = root.requestFullscreen || root.webkitRequestFullscreen;
      if (request) Promise.resolve(request.call(root)).catch(() => {});
    }
  });

  els.showName.addEventListener('change', () => {
    api('PATCH', '/api/show', { name: els.showName.value }).catch((e) => toast(e.message, true));
  });
  els.showName.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') els.showName.blur();
  });

  function setEditing(on) {
    state.editing = on;
    document.body.classList.toggle('editing', on);
    els.edit.setAttribute('aria-pressed', String(on));
    if (initialized) renderAll();
    try {
      localStorage.setItem(EDIT_KEY, on ? '1' : '0');
    } catch {
      // ignore
    }
  }
  els.edit.addEventListener('click', () => setEditing(!state.editing));

  els.addChannel.addEventListener('click', () => openModal('channel', null));
  els.addSpare.addEventListener('click', () => openModal('spare', null));

  // ---------------------------------------------------------------------------
  // Rendering: cards
  // ---------------------------------------------------------------------------

  const cardViews = new Map(); // channel id -> view
  const spareViews = new Map(); // spare id -> view

  // Masonry packing: the grid has 8px auto rows (see style.css); each card
  // spans as many as its content needs, measured whenever its size changes.
  const ROW_PX = 8;
  const GAP_PX = 12;
  const sizer = typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => {
        for (const entry of entries) spanRows(entry.target);
      })
    : null;

  function spanRows(card) {
    const h = card.getBoundingClientRect().height;
    if (!h) return;
    // rows are 8px with a 12px gap: n rows cover n*8 + (n-1)*12 px
    const rows = Math.max(1, Math.ceil((h + GAP_PX) / (ROW_PX + GAP_PX)));
    const value = `span ${rows}`;
    if (card.style.gridRowEnd !== value) card.style.gridRowEnd = value;
  }

  function renderAll() {
    renderChannels();
    renderSpares();
    renderSelection();
    els.showCounts.textContent = `${state.show.channels.length} ch · ${state.show.spares.length} spare${state.show.spares.length === 1 ? '' : 's'}`;
  }

  function createMeterRow(label) {
    const row = el('div', 'meter-row');
    const lab = row.appendChild(el('span', 'meter-label', label));
    const canvas = row.appendChild(el('canvas', 'meter-canvas'));
    const readout = row.appendChild(el('span', 'readout', '—'));
    return { row, label: lab, canvas, ctx: canvas.getContext('2d'), readout, drawn: '' };
  }

  function createPic() {
    const pic = el('div', 'card-pic');
    const img = el('img');
    img.alt = '';
    img.hidden = true;
    img.draggable = false;
    const init = el('span', 'pic-initials', '?');
    const badge = el('span', 'card-badge unknown', '');
    const gear = el('button', 'card-gear', '⚙');
    gear.type = 'button';
    gear.title = 'Settings';
    pic.append(img, init, badge, gear);
    return { pic, img, init, badge, gear };
  }

  function setPic(view, image, name) {
    const src = image ? `/images/${encodeURIComponent(image)}` : '';
    if (src) {
      if (view.img.dataset.src !== src) {
        view.img.src = src;
        view.img.dataset.src = src;
      }
      view.img.hidden = false;
      view.init.hidden = true;
    } else {
      view.img.hidden = true;
      view.img.removeAttribute('src');
      view.img.dataset.src = '';
      view.init.hidden = false;
      view.init.textContent = initials(name);
    }
  }

  function renderChannels() {
    const ids = new Set(state.show.channels.map((c) => c.id));
    for (const [id, view] of cardViews) {
      if (!ids.has(id)) {
        if (sizer) sizer.unobserve(view.root);
        view.root.remove();
        cardViews.delete(id);
      }
    }
    els.channelsEmpty.hidden = state.show.channels.length > 0;

    let previous = null;
    for (const ch of state.show.channels) {
      let view = cardViews.get(ch.id);
      if (!view) {
        view = createChannelCard(ch.id);
        cardViews.set(ch.id, view);
      }
      updateChannelCard(view, ch);
      if (drag.kind) continue; // keep the operator's drag preview in place
      if (previous ? previous.nextSibling !== view.root : els.grid.firstChild !== view.root) {
        if (previous) previous.after(view.root);
        else els.grid.prepend(view.root);
      }
      previous = view.root;
    }
  }

  function createChannelCard(id) {
    const root = el('article', 'card');
    root.dataset.id = id;
    const p = createPic();
    const body = el('div', 'card-body');
    const name = body.appendChild(el('div', 'card-name'));
    const sub = body.appendChild(el('div', 'card-sub'));
    const txMeter = createMeterRow('TX');
    const rxMeter = createMeterRow('RX');
    body.append(txMeter.row, rxMeter.row);
    const paths = body.appendChild(el('div', 'card-sub'));
    const rf = createRfBlock();
    body.appendChild(rf.root);
    root.append(p.pic, body);

    root.addEventListener('click', (e) => {
      if (e.target.closest('.card-gear')) return;
      state.selectedChannel = state.selectedChannel === id ? null : id;
      renderSelection();
    });
    p.gear.addEventListener('click', (e) => {
      e.stopPropagation();
      openModal('channel', id);
    });
    makeDraggable(root, 'channel', id);
    attachImageDrop(root, (file) => setPictureFromFile('channel', id, file), () => state.editing);
    if (sizer) sizer.observe(root);
    return { id, root, ...p, name, sub, txMeter, rxMeter, paths, rf, status: null };
  }

  function updateChannelCard(view, ch) {
    const status = channelStatus(ch);
    view.status = status;
    view.root.className = `card ${status.kind}${state.selectedChannel === ch.id ? ' selected' : ''}${drag.id === ch.id ? ' dragging' : ''}`;
    view.root.draggable = state.editing;
    setPic(view, ch.image, ch.name);
    view.badge.className = `card-badge ${status.kind}`;
    view.badge.textContent = status.label;
    view.badge.title = status.detail;
    view.name.textContent = ch.name;
    view.name.title = ch.name;

    view.sub.textContent = '';
    if (status.kind === 'on-spare') {
      const sp = status.spare;
      const monitored = sp.monitorMain && sp.rx && ch.tx ? ` · main pack at ${pathText(sp.rx)}` : '';
      view.sub.appendChild(el('span', 'warn', `Running on spare: ${sp.name}${monitored}`));
    } else if (status.kind === 'unpatched' || status.kind === 'other' || status.kind === 'unknown') {
      view.sub.appendChild(el('span', 'err', status.detail));
    } else {
      view.sub.textContent = ch.notes || status.detail;
    }

    const txDev = ch.tx && deviceByName(ch.tx.device);
    const rxDev = ch.rx && deviceByName(ch.rx.device);
    view.paths.textContent = '';
    view.paths.append(
      el('span', ch.tx && !(txDev && txDev.online) ? 'err' : '', `TX ${pathText(ch.tx)}`),
      '  →  ',
      el('span', ch.rx && !(rxDev && rxDev.online) ? 'err' : '', `RX ${pathText(ch.rx)}`)
    );
    view.paths.title = `Transmit: ${ch.tx ? `${ch.tx.device} / ${txChannelLabel(ch.tx)}` : 'not set'}\nReceive: ${pathText(ch.rx)}`;

    applyView(view, ch, [view.txMeter.row, view.rxMeter.row, view.paths]);
    const standby = status.kind === 'on-spare';
    view.txMeter.row.classList.toggle('standby', standby);
    view.txMeter.label.textContent = standby ? 'MAIN' : 'TX';
    view.txMeter.row.title = standby ? "The main transmitter's own level (not feeding the receiver right now)" : 'Transmitter level';
    view.rxMeter.row.title = 'Level arriving at the receiver';
  }

  function renderSpares() {
    const ids = new Set(state.show.spares.map((s) => s.id));
    for (const [id, view] of spareViews) {
      if (!ids.has(id)) {
        view.root.remove();
        spareViews.delete(id);
      }
    }
    els.sparesEmpty.hidden = state.show.spares.length > 0;
    let previous = null;
    for (const sp of state.show.spares) {
      let view = spareViews.get(sp.id);
      if (!view) {
        view = createSpareCard(sp.id);
        spareViews.set(sp.id, view);
      }
      updateSpareCard(view, sp);
      if (drag.kind) continue;
      if (previous ? previous.nextSibling !== view.root : els.sparesList.firstChild !== view.root) {
        if (previous) previous.after(view.root);
        else els.sparesList.prepend(view.root);
      }
      previous = view.root;
    }
  }

  function createSpareCard(id) {
    const root = el('article', 'card spare-card');
    root.dataset.id = id;
    const p = createPic();
    const body = el('div', 'card-body');
    const name = body.appendChild(el('div', 'card-name'));
    const sub = body.appendChild(el('div', 'card-sub'));
    const meter = createMeterRow('TX');
    const rxMeter = createMeterRow('RX');
    rxMeter.row.hidden = true;
    const rf = createRfBlock();
    body.append(meter.row, rxMeter.row, rf.root);
    root.append(p.pic, body);
    root.addEventListener('click', (e) => {
      if (e.target.closest('.card-gear')) return;
      state.selectedSpare = state.selectedSpare === id ? null : id;
      renderSelection();
    });
    p.gear.addEventListener('click', (e) => {
      e.stopPropagation();
      openModal('spare', id);
    });
    makeDraggable(root, 'spare', id);
    attachImageDrop(root, (file) => setPictureFromFile('spare', id, file), () => state.editing);
    return { id, root, ...p, name, sub, meter, rxMeter, rf, status: null };
  }

  function updateSpareCard(view, sp) {
    const status = spareStatus(sp);
    view.status = status;
    view.root.className = `card spare-card ${status.kind}${state.selectedSpare === sp.id ? ' selected' : ''}${drag.id === sp.id ? ' dragging' : ''}`;
    view.root.draggable = state.editing;
    // A spare in use inherits the main's picture (and shows the main's name).
    const main = status.main;
    setPic(view, main && main.image ? main.image : sp.image, main ? main.name : sp.name);
    view.badge.className = `card-badge ${status.kind}`;
    view.badge.textContent = status.label;
    view.name.textContent = main ? `${sp.name} → ${main.name}` : sp.name;
    view.sub.textContent = '';
    const txDev = sp.tx && deviceByName(sp.tx.device);
    view.sub.appendChild(el('span', sp.tx && !(txDev && txDev.online) ? 'err' : '', `TX ${pathText(sp.tx)}`));
    if (status.fedBy) view.sub.append(' · ', el('span', 'warn', status.fedBy));
    applyView(view, sp, [view.meter.row]);
    view.rxMeter.row.hidden = !sp.rx || view.danteHidden;
    if (sp.rx) {
      const monitoring = main && sp.monitorMain;
      view.rxMeter.label.textContent = monitoring ? 'MON' : 'RX';
      view.rxMeter.row.classList.toggle('standby', Boolean(monitoring));
      view.rxMeter.row.title = monitoring ? `${main.name}'s main pack, monitored at ${pathText(sp.rx)}` : `Monitor input ${pathText(sp.rx)}`;
      view.sub.append(' · ', el('span', monitoring ? 'warn' : '', monitoring ? `monitoring ${main.name} @ ${pathText(sp.rx)}` : `MON ${pathText(sp.rx)}`));
    }
  }

  // ---------------------------------------------------------------------------
  // Drag-to-reorder (Edit mode only, so a show-time touch can't shuffle cards)
  // ---------------------------------------------------------------------------

  function makeDraggable(root, kind, id) {
    root.addEventListener('dragstart', (e) => {
      if (!state.editing) {
        e.preventDefault();
        return;
      }
      drag.id = id;
      drag.kind = kind;
      drag.container = root.parentNode;
      root.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', id);
      } catch {
        // some browsers reject setData with unusual types
      }
    });
    root.addEventListener('dragend', () => {
      root.classList.remove('dragging');
      finishDrag();
    });
  }

  function dragTargets(container, kind) {
    container.addEventListener('dragover', (e) => {
      if (drag.kind !== kind) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const dragged = container.querySelector('.card.dragging');
      const over = e.target.closest('.card');
      if (!dragged || !over || over === dragged) return;
      // Insert before or after the hovered card depending on which half the pointer is in.
      const rect = over.getBoundingClientRect();
      const horizontal = kind === 'channel' || getComputedStyle(container).flexDirection === 'row';
      const after = horizontal ? e.clientX > rect.left + rect.width / 2 : e.clientY > rect.top + rect.height / 2;
      if (after) over.after(dragged);
      else over.before(dragged);
    });
    container.addEventListener('drop', (e) => {
      if (drag.kind !== kind) return;
      e.preventDefault();
      const ids = [...container.querySelectorAll('.card')].map((c) => c.dataset.id);
      const list = kind === 'channel' ? state.show.channels : state.show.spares;
      const changed = ids.some((id, i) => !list[i] || list[i].id !== id);
      finishDrag();
      if (!changed) return;
      // Apply locally first so the grid doesn't snap back before the server echoes the show.
      const byId = new Map(list.map((x) => [x.id, x]));
      const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
      if (kind === 'channel') state.show.channels = ordered;
      else state.show.spares = ordered;
      api('POST', '/api/reorder', kind === 'channel' ? { channels: ids } : { spares: ids }).catch((err) => toast(err.message, true));
    });
  }

  function finishDrag() {
    drag.id = null;
    drag.kind = null;
    drag.container = null;
  }

  dragTargets(els.grid, 'channel');
  dragTargets(els.sparesList, 'spare');

  // ---------------------------------------------------------------------------
  // Selection + swap bar
  // ---------------------------------------------------------------------------

  function renderSelection() {
    for (const [id, view] of cardViews) view.root.classList.toggle('selected', state.selectedChannel === id);
    for (const [id, view] of spareViews) view.root.classList.toggle('selected', state.selectedSpare === id);

    const ch = channelById(state.selectedChannel);
    const sp = spareById(state.selectedSpare);
    els.selMain.classList.toggle('filled', Boolean(ch));
    els.selSpare.classList.toggle('filled', Boolean(sp));
    els.selMainText.textContent = ch ? `${ch.name}  ·  RX ${pathText(ch.rx)}` : 'Tap a channel';
    els.selSpareText.textContent = sp ? `${sp.name}  ·  TX ${pathText(sp.tx)}` : 'Tap a spare';

    const chStatus = ch ? channelStatus(ch) : null;
    const alreadyOnIt = Boolean(ch && sp && chStatus && chStatus.kind === 'on-spare' && chStatus.spare.id === sp.id);
    const canSwap = Boolean(ch && sp && ch.rx && sp.tx && !alreadyOnIt && !state.swapping);
    els.swap.disabled = !canSwap;
    els.swap.textContent = state.swapping ? 'SWAPPING…' : alreadyOnIt ? 'ALREADY ON SPARE' : 'SWAP';
    els.swap.title = !ch || !sp ? 'Select a channel and a spare' : !ch.rx ? 'Channel has no receive path' : !sp.tx ? 'Spare has no transmit path' : `Patch ${sp.name} into ${ch.name}'s receiver`;

    const canRestore = Boolean(ch && ch.tx && ch.rx && chStatus && chStatus.kind !== 'main' && !state.swapping);
    els.restore.disabled = !canRestore;
    els.restore.title = ch && ch.tx ? `Patch ${ch.name}'s own transmitter back into its receiver` : 'Select a channel with a transmit path';
  }

  els.swap.addEventListener('click', async () => {
    const ch = channelById(state.selectedChannel);
    const sp = spareById(state.selectedSpare);
    if (!ch || !sp) return;
    await runRouting(() => api('POST', '/api/swap', { channelId: ch.id, spareId: sp.id }));
  });

  els.restore.addEventListener('click', async () => {
    const ch = channelById(state.selectedChannel);
    if (!ch) return;
    await runRouting(() => api('POST', '/api/restore', { channelId: ch.id }));
  });

  async function runRouting(fn) {
    state.swapping = true;
    els.swap.classList.add('working');
    renderSelection();
    try {
      const result = await fn();
      if (result && result.ok) {
        state.selectedSpare = null;
        state.selectedChannel = null;
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      state.swapping = false;
      els.swap.classList.remove('working');
      renderSelection();
    }
  }

  function resultClass(r) {
    if (!r) return '';
    if (r.error || !r.ok) return 'fail';
    return r.steps && r.steps.some((s) => s.warning) ? 'warn' : 'ok';
  }

  function renderResult(r) {
    if (!r) {
      els.resultText.textContent = '';
      els.resultText.className = 'result-text';
      return;
    }
    const last = r.steps && r.steps.length ? r.steps[r.steps.length - 1].text : '';
    const time = new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    els.resultText.textContent = `${time}  ${r.title}: ${r.error || last}`;
    els.resultText.className = `result-text ${resultClass(r)}`;
  }

  function renderHistory() {
    els.historyList.textContent = '';
    if (!state.history.length) els.historyList.appendChild(el('li', 'history-item', 'No swaps yet.'));
    for (const r of state.history) {
      const li = el('li', `history-item ${resultClass(r)}`);
      const head = el('div');
      head.append(el('span', 'h-title', r.title), el('span', 'h-time', new Date(r.at).toLocaleTimeString()));
      li.appendChild(head);
      const ul = el('ul');
      for (const s of r.steps || []) ul.appendChild(el('li', s.ok ? (s.warning ? 'warn' : 'ok') : 'fail', s.text));
      if (r.error) ul.appendChild(el('li', 'fail', r.error));
      li.appendChild(ul);
      els.historyList.appendChild(li);
    }
  }

  els.resultText.addEventListener('click', () => {
    els.historyDrawer.hidden = !els.historyDrawer.hidden;
    if (!els.historyDrawer.hidden) renderHistory();
  });
  els.closeHistory.addEventListener('click', () => (els.historyDrawer.hidden = true));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (modal.open) closeModal();
      else if (rxModal.open) closeRxModal();
      else if (!els.historyDrawer.hidden) els.historyDrawer.hidden = true;
      else {
        state.selectedChannel = null;
        state.selectedSpare = null;
        renderSelection();
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Meters (every animation frame)
  // ---------------------------------------------------------------------------

  function segmentColor(ratio) {
    if (ratio >= 0.94) return COLORS.red;
    if (ratio >= 0.82) return COLORS.amber;
    if (ratio >= 0.55) return COLORS.yellow;
    return COLORS.green;
  }

  function drawMeter(m, norm, holdNorm, clip) {
    const canvas = m.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (!w || !h) return;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const key = `${Math.round(norm * SEGMENTS)}|${Math.round(holdNorm * SEGMENTS)}|${clip}|${w}x${h}`;
    if (key === m.drawn) return;
    m.drawn = key;

    const ctx = m.ctx;
    const gap = Math.max(1, Math.round(dpr));
    const segW = (w - (SEGMENTS - 1) * gap) / SEGMENTS;
    const lit = Math.round(norm * SEGMENTS);
    ctx.fillStyle = COLORS.track;
    ctx.fillRect(0, 0, w, h);
    for (let s = 0; s < SEGMENTS; s++) {
      const x = s * (segW + gap);
      ctx.fillStyle = s < lit ? (clip && s === SEGMENTS - 1 ? COLORS.red : segmentColor(s / (SEGMENTS - 1))) : COLORS.off;
      ctx.fillRect(x, 0, segW, h);
    }
    if (holdNorm > norm && holdNorm > 0.04) {
      const seg = Math.min(SEGMENTS - 1, Math.floor(holdNorm * SEGMENTS));
      ctx.fillStyle = COLORS.hold;
      ctx.fillRect(seg * (segW + gap), 0, segW, h);
    }
  }

  function peakHold(key, norm, now) {
    const hold = state.holds.get(key);
    if (!hold || norm >= hold.norm) {
      state.holds.set(key, { norm, at: now });
      return norm;
    }
    const age = now - hold.at;
    if (age <= PEAK_HOLD_MS) return hold.norm;
    return Math.max(norm, hold.norm - ((age - PEAK_HOLD_MS) / 1000) * PEAK_DECAY_PER_SEC);
  }

  function renderOneMeter(m, key, peak, now) {
    const hasData = peak !== null && peak !== undefined;
    if (hasData && isClipByte(peak)) state.clipUntil.set(key, now + CLIP_LATCH_MS);
    const clip = (state.clipUntil.get(key) || 0) > now;
    const dbfs = hasData ? byteToDbfs(peak) : -Infinity;
    const norm = dbfsToNormalized(dbfs);
    drawMeter(m, norm, peakHold(key, norm, now), clip);
    m.row.classList.toggle('no-data', !hasData);
    const text = formatDbfs(dbfs, clip, hasData);
    if (m.readout.textContent !== text) m.readout.textContent = text;
    const cls = `readout ${clip ? 'clip' : norm > 0.05 ? 'active' : ''}`;
    if (m.readout.className !== cls) m.readout.className = cls;
    return clip;
  }

  function renderMeters() {
    const now = performance.now();
    for (const [id, view] of cardViews) {
      const ch = channelById(id);
      if (!ch) continue;
      const clipTx = renderOneMeter(view.txMeter, `${id}|tx`, levelFor(ch.tx, 'tx'), now);
      const clipRx = renderOneMeter(view.rxMeter, `${id}|rx`, levelFor(ch.rx, 'rx'), now);
      view.root.classList.toggle('clipped', clipTx || clipRx);
      renderRfBlock(view.rf, ch);
    }
    for (const [id, view] of spareViews) {
      const sp = spareById(id);
      if (!sp) continue;
      renderOneMeter(view.meter, `${id}|tx`, levelFor(sp.tx, 'tx'), now);
      if (sp.rx) renderOneMeter(view.rxMeter, `${id}|rx`, levelFor(sp.rx, 'rx'), now);
      renderRfBlock(view.rf, sp);
    }
  }

  function frame() {
    try {
      renderMeters();
    } catch (err) {
      console.error('[meters]', err);
    }
    requestAnimationFrame(frame);
  }

  // Status badges depend on routing, which arrives with "devices"; but the
  // devices message is only sent when structure changes, so re-derive statuses
  // every second as well (cheap).
  setInterval(() => {
    for (const [id, view] of cardViews) {
      const ch = channelById(id);
      if (ch) updateChannelCard(view, ch);
    }
    for (const [id, view] of spareViews) {
      const sp = spareById(id);
      if (sp) updateSpareCard(view, sp);
    }
    renderSelection();
  }, 1000);

  // ---------------------------------------------------------------------------
  // Settings modal
  // ---------------------------------------------------------------------------

  const modal = {
    open: false,
    kind: 'channel',
    id: null,
    image: null, // file name on server (or null)
    pendingDataUrl: null // new picture awaiting upload
  };
  const f = {
    backdrop: $('modal'),
    form: $('settingsForm'),
    title: $('modalTitle'),
    close: $('btnCloseModal'),
    cancel: $('btnCancel'),
    del: $('btnDelete'),
    save: $('btnSave'),
    picRow: $('picRow'),
    picPreview: $('picPreview'),
    picInitials: $('picInitials'),
    picFile: $('picFile'),
    removePic: $('btnRemovePic'),
    name: $('fName'),
    txDevice: $('fTxDevice'),
    txManualWrap: $('fTxManualWrap'),
    txManual: $('fTxManual'),
    txChannel: $('fTxChannel'),
    rxFieldset: $('rxFieldset'),
    rxDevice: $('fRxDevice'),
    rxManualWrap: $('fRxManualWrap'),
    rxManual: $('fRxManual'),
    rxChannel: $('fRxChannel'),
    rxCurrent: $('rxCurrent'),
    rxLegend: $('rxLegend'),
    monitorWrap: $('monitorWrap'),
    monitor: $('fMonitor'),
    rfReceiver: $('fRfReceiver'),
    rfChannel: $('fRfChannel'),
    viewRadios: () => [...document.querySelectorAll('input[name="view"]')],
    notesWrap: $('notesWrap'),
    notes: $('fNotes')
  };

  function openModal(kind, id) {
    modal.open = true;
    modal.kind = kind;
    modal.id = id;
    modal.pendingDataUrl = null;
    const item = id ? (kind === 'channel' ? channelById(id) : spareById(id)) : null;
    modal.image = item ? item.image : null;

    f.title.textContent = `${kind === 'channel' ? 'Channel' : 'Spare'} ${item ? 'settings' : '— new'}`;
    f.name.value = item ? item.name : '';
    f.notes.value = item && item.notes ? item.notes : '';
    f.rxFieldset.hidden = false;
    f.rxLegend.textContent = kind === 'channel' ? 'Receive path (where it lands, e.g. the console input)' : 'Monitor path (optional: where this spare pack is normally patched for monitoring)';
    f.monitorWrap.hidden = kind !== 'spare';
    f.monitor.checked = Boolean(item && item.monitorMain);
    f.notesWrap.hidden = kind !== 'channel';
    f.del.hidden = !item;
    f.picFile.value = '';

    fillPathEditor('tx', item ? item.tx : null);
    fillPathEditor('rx', item ? item.rx : null);
    fillRfEditor(item ? item.rf : null);
    for (const r of f.viewRadios()) r.checked = r.value === ((item && item.view) || 'dante');
    updatePicPreview();
    f.backdrop.hidden = false;
    setTimeout(() => f.name.focus(), 30);
  }

  function closeModal() {
    modal.open = false;
    f.backdrop.hidden = true;
  }

  f.close.addEventListener('click', closeModal);
  f.cancel.addEventListener('click', closeModal);
  f.backdrop.addEventListener('click', (e) => {
    if (e.target === f.backdrop) closeModal();
  });

  function updatePicPreview() {
    const src = modal.pendingDataUrl || (modal.image ? `/images/${encodeURIComponent(modal.image)}` : null);
    f.picPreview.textContent = '';
    if (src) {
      const img = el('img');
      img.src = src;
      img.alt = '';
      f.picPreview.appendChild(img);
    } else {
      f.picPreview.appendChild(el('span', 'pic-initials', initials(f.name.value)));
    }
  }
  f.name.addEventListener('input', () => {
    if (!modal.pendingDataUrl && !modal.image) updatePicPreview();
  });

  f.removePic.addEventListener('click', () => {
    modal.pendingDataUrl = null;
    modal.image = null;
    f.picFile.value = '';
    updatePicPreview();
  });

  f.picFile.addEventListener('change', async () => {
    const file = f.picFile.files && f.picFile.files[0];
    if (!file) return;
    try {
      modal.pendingDataUrl = await shrinkImage(file, IMAGE_MAX_PX);
      updatePicPreview();
    } catch (err) {
      toast(`Could not read picture: ${err.message}`, true);
    }
  });

  /** Downscale to fit `max` px on the long side and encode as JPEG (or PNG when transparent). */
  function shrinkImage(file, max) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(file.type === 'image/png' ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.86));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('not a readable image'));
      };
      img.src = url;
    });
  }

  // --- picture drag-and-drop / paste ---

  function imageFileFrom(dataTransfer) {
    if (!dataTransfer) return null;
    for (const f of dataTransfer.files || []) if (f.type.startsWith('image/')) return f;
    for (const item of dataTransfer.items || []) {
      if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
    }
    return null;
  }

  function hasFiles(e) {
    return Boolean(e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files'));
  }

  /** Make `element` accept a dropped image; `onFile(file)` is called with it. `allowed()` can veto. */
  function attachImageDrop(element, onFile, allowed = () => true) {
    let depth = 0;
    element.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || !allowed()) return;
      e.preventDefault();
      depth++;
      element.classList.add('drop-target');
    });
    element.addEventListener('dragover', (e) => {
      if (!hasFiles(e) || !allowed()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    element.addEventListener('dragleave', () => {
      if (--depth <= 0) {
        depth = 0;
        element.classList.remove('drop-target');
      }
    });
    element.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      depth = 0;
      element.classList.remove('drop-target');
      if (!allowed()) return;
      const file = imageFileFrom(e.dataTransfer);
      if (!file) return toast('That is not an image file', true);
      onFile(file);
    });
  }

  /** Shrink, upload and store a picture on a card without opening its settings. */
  async function setPictureFromFile(kind, id, file) {
    try {
      const dataUrl = await shrinkImage(file, IMAGE_MAX_PX);
      const up = await api('POST', '/api/images', { dataUrl });
      const base = kind === 'channel' ? '/api/channels' : '/api/spares';
      await api('PATCH', `${base}/${encodeURIComponent(id)}`, { image: up.file });
      toast('Picture updated');
    } catch (err) {
      toast(`Could not set picture: ${err.message}`, true);
    }
  }

  // Settings dialog: drop onto the picture area, or paste an image anywhere while it is open.
  attachImageDrop(f.picRow, async (file) => {
    try {
      modal.pendingDataUrl = await shrinkImage(file, IMAGE_MAX_PX);
      updatePicPreview();
    } catch (err) {
      toast(`Could not read picture: ${err.message}`, true);
    }
  });
  document.addEventListener('paste', async (e) => {
    if (!modal.open) return;
    const file = imageFileFrom(e.clipboardData);
    if (!file) return;
    e.preventDefault();
    try {
      modal.pendingDataUrl = await shrinkImage(file, IMAGE_MAX_PX);
      updatePicPreview();
    } catch (err) {
      toast(`Could not read picture: ${err.message}`, true);
    }
  });

  // --- device / channel pickers ---

  const MANUAL = '__manual__';

  function onlineSortedDevices() {
    return [...state.devices.values()].sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  function fillDeviceSelect(select, manualWrap, manualInput, current, dir) {
    select.textContent = '';
    const none = el('option', null, '— none —');
    none.value = '';
    select.appendChild(none);
    let matched = !current;
    for (const d of onlineSortedDevices()) {
      const count = d[dir].count;
      if (!count && d.online) continue; // no channels in this direction
      const opt = el('option', null, `${d.name}${d.online ? '' : ' (offline)'} · ${count} ${dir.toUpperCase()}`);
      opt.value = d.name;
      if (current && d.name.toLowerCase() === current.device.toLowerCase()) {
        opt.selected = true;
        matched = true;
      }
      select.appendChild(opt);
    }
    const manual = el('option', null, 'Type a device name…');
    manual.value = MANUAL;
    select.appendChild(manual);
    if (!matched) {
      select.value = MANUAL;
      manualInput.value = current.device;
    } else if (select.value !== MANUAL) {
      manualInput.value = '';
    }
    manualWrap.hidden = select.value !== MANUAL;
  }

  function fillChannelSelect(select, deviceName, dir, current) {
    select.textContent = '';
    const dev = deviceByName(deviceName);
    const count = dev && dev[dir].count ? dev[dir].count : 64;
    const wanted = current ? Number(current.channel) : 1;
    for (let i = 1; i <= Math.max(count, wanted); i++) {
      const ch = dev && dev[dir].channels[i];
      let label = String(i).padStart(2, '0');
      if (ch && ch.name && ch.name !== `${dir === 'tx' ? 'Tx' : 'Rx'} ${i}`) label += `  ${ch.name}`;
      if (dir === 'rx' && ch && ch.subscribedDevice) label += `  ← ${ch.subscribedDevice}/${ch.subscribedChannel}`;
      const opt = el('option', null, label);
      opt.value = String(i);
      if (i === wanted) opt.selected = true;
      select.appendChild(opt);
    }
  }

  function fillPathEditor(dir, current) {
    const dev = dir === 'tx' ? f.txDevice : f.rxDevice;
    const manualWrap = dir === 'tx' ? f.txManualWrap : f.rxManualWrap;
    const manual = dir === 'tx' ? f.txManual : f.rxManual;
    const chan = dir === 'tx' ? f.txChannel : f.rxChannel;
    fillDeviceSelect(dev, manualWrap, manual, current, dir);
    fillChannelSelect(chan, currentDeviceName(dir), dir, current);
    if (dir === 'rx') updateRxCurrent();
  }

  function currentDeviceName(dir) {
    const dev = dir === 'tx' ? f.txDevice : f.rxDevice;
    const manual = dir === 'tx' ? f.txManual : f.rxManual;
    return dev.value === MANUAL ? manual.value.trim() : dev.value;
  }

  function readPath(dir) {
    const device = currentDeviceName(dir);
    const chan = Number((dir === 'tx' ? f.txChannel : f.rxChannel).value);
    if (!device) return null;
    return { device, channel: chan };
  }

  function updateRxCurrent() {
    const p = readPath('rx');
    const dev = p && deviceByName(p.device);
    const rec = dev && dev.rx.channels[p.channel];
    if (!p) f.rxCurrent.textContent = '';
    else if (!dev) f.rxCurrent.textContent = `${p.device} is not on the network right now.`;
    else if (!rec || !rec.subscribedDevice) f.rxCurrent.textContent = `Currently: ${dev.name} Rx ${p.channel} has no source.`;
    else f.rxCurrent.textContent = `Currently: ${dev.name} Rx ${p.channel} ← ${rec.subscribedDevice} / ${rec.subscribedChannel}${rec.connected ? '' : ' (not connected)'}`;
  }

  for (const dir of ['tx', 'rx']) {
    const dev = dir === 'tx' ? f.txDevice : f.rxDevice;
    const manualWrap = dir === 'tx' ? f.txManualWrap : f.rxManualWrap;
    const manual = dir === 'tx' ? f.txManual : f.rxManual;
    const chan = dir === 'tx' ? f.txChannel : f.rxChannel;
    dev.addEventListener('change', () => {
      manualWrap.hidden = dev.value !== MANUAL;
      if (dev.value === MANUAL) manual.focus();
      fillChannelSelect(chan, currentDeviceName(dir), dir, { channel: Number(chan.value) || 1 });
      if (dir === 'rx') updateRxCurrent();
    });
    manual.addEventListener('input', () => {
      fillChannelSelect(chan, currentDeviceName(dir), dir, { channel: Number(chan.value) || 1 });
      if (dir === 'rx') updateRxCurrent();
    });
    chan.addEventListener('change', () => dir === 'rx' && updateRxCurrent());
  }

  /** Keep pickers current while the dialog is open without losing the operator's choices. */
  function refreshModalDeviceLists() {
    const tx = readPath('tx');
    fillPathEditor('tx', tx);
    fillPathEditor('rx', readPath('rx'));
  }

  f.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    f.save.disabled = true;
    try {
      let image = modal.image;
      if (modal.pendingDataUrl) {
        const up = await api('POST', '/api/images', { dataUrl: modal.pendingDataUrl });
        image = up.file;
      }
      const body = { name: f.name.value.trim(), image, tx: readPath('tx'), rx: readPath('rx'), rf: readRfLink(), view: (f.viewRadios().find((r) => r.checked) || {}).value || 'dante' };
      if (modal.kind === 'channel') body.notes = f.notes.value;
      else body.monitorMain = f.monitor.checked;
      const base = modal.kind === 'channel' ? '/api/channels' : '/api/spares';
      if (modal.id) await api('PATCH', `${base}/${encodeURIComponent(modal.id)}`, body);
      else await api('POST', base, body);
      closeModal();
    } catch (err) {
      toast(err.message, true);
    } finally {
      f.save.disabled = false;
    }
  });

  f.del.addEventListener('click', async () => {
    if (!modal.id) return;
    const label = modal.kind === 'channel' ? 'channel' : 'spare';
    if (!window.confirm(`Delete this ${label} card? This does not change any Dante routing.`)) return;
    try {
      const base = modal.kind === 'channel' ? '/api/channels' : '/api/spares';
      await api('DELETE', `${base}/${encodeURIComponent(modal.id)}`);
      closeModal();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------------------------------------------------------------------------
  // RF telemetry on cards (optional per card: view = dante | rf | all)
  // ---------------------------------------------------------------------------

  function rfChannelFor(item) {
    if (!item || !item.rf) return null;
    const rx = state.rf[item.rf.receiverId];
    if (!rx) return { receiverOffline: true, ch: null };
    const ch = rx.channels && rx.channels[item.rf.channel];
    return { receiverOffline: !rx.online, ch: ch || null };
  }

  /** Show / hide the Dante rows and the RF block according to the card's view setting. */
  function applyView(view, item, danteRows) {
    const mode = item.rf ? item.view || 'dante' : 'dante';
    const showDante = mode !== 'rf';
    const showRf = Boolean(item.rf) && mode !== 'dante';
    view.danteHidden = !showDante;
    for (const row of danteRows) row.hidden = !showDante;
    view.rf.root.hidden = !showRf;
  }

  function createRfBlock() {
    const root = el('div', 'rf-block');
    root.hidden = true;
    const af = createMeterRow('AF');
    const bar = (label, cls) => {
      const row = el('div', 'rf-row');
      const lab = row.appendChild(el('span', 'meter-label', label));
      const track = row.appendChild(el('div', `rf-bar ${cls}`));
      const fill = track.appendChild(el('i'));
      const readout = row.appendChild(el('span', 'readout', '—'));
      return { row, lab, track, fill, readout };
    };
    const a = bar('RF A', 'rssi');
    const b = bar('RF B', 'rssi');
    const q = bar('Q', 'quality');
    const bat = bar('BATT', 'battery');
    const info = el('div', 'rf-info');
    root.append(af.row, a.row, b.row, q.row, bat.row, info);
    return { root, af, a, b, q, bat, info, infoKey: '' };
  }

  const RSSI_MIN = -110;
  const RSSI_MAX = -20;

  function renderRssi(bar, dbm, active) {
    const has = typeof dbm === 'number';
    const pct = has ? Math.max(0, Math.min(1, (dbm - RSSI_MIN) / (RSSI_MAX - RSSI_MIN))) : 0;
    bar.fill.style.width = `${Math.round(pct * 100)}%`;
    bar.lab.classList.toggle('active', Boolean(active));
    const text = has ? `${Math.round(dbm)} dBm` : '—';
    if (bar.readout.textContent !== text) bar.readout.textContent = text;
  }

  function renderRfBlock(block, item) {
    if (block.root.hidden) return;
    const r = rfChannelFor(item);
    const ch = r && r.ch;
    block.root.classList.toggle('offline', !r || r.receiverOffline);
    const now = performance.now();
    const stale = !ch || (ch.updatedAt && Date.now() - ch.updatedAt > 5000);
    // AF: dBFS from the receiver (Sennheiser gives -138.5..0, Shure -120..0).
    const afByte = ch && typeof ch.af === 'number' && !stale ? Math.max(1, Math.min(253, Math.round(1 - ch.af * 2))) : null;
    renderOneMeter(block.af, `${item.id}|af`, afByte, now);
    renderRssi(block.a, ch && !stale ? ch.rssi[0] : null, ch && ch.antennas[0] === 'B');
    renderRssi(block.b, ch && !stale ? ch.rssi[1] : null, ch && ch.antennas[1] === 'B');
    const q = ch && !stale && typeof ch.quality === 'number' ? ch.quality : null;
    block.q.fill.style.width = `${q === null ? 0 : q}%`;
    block.q.readout.textContent = q === null ? '—' : `${Math.round(q)}%`;
    const pct = ch && typeof ch.battery.percent === 'number' ? ch.battery.percent : ch && typeof ch.battery.bars === 'number' ? ch.battery.bars * 20 : null;
    block.bat.fill.style.width = `${pct === null ? 0 : pct}%`;
    block.bat.track.classList.toggle('low', pct !== null && pct <= 30);
    block.bat.track.classList.toggle('critical', pct !== null && pct <= 12);
    const mins = ch && typeof ch.battery.minutes === 'number' ? ch.battery.minutes : null;
    block.bat.readout.textContent = pct === null ? '—' : mins !== null ? `${pct}% ${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}` : `${pct}%`;
    block.bat.readout.title = mins !== null ? `${mins} min remaining` : '';

    const bits = [];
    if (!r) bits.push(['off', 'no receiver']);
    else if (r.receiverOffline) bits.push(['off', 'RECEIVER OFFLINE']);
    else if (!ch) bits.push(['off', `no channel ${item.rf.channel}`]);
    if (ch) {
      if (ch.txName || ch.txModel) bits.push(['', [ch.txName, ch.txModel].filter(Boolean).join(' · ')]);
      if (ch.frequencyKHz) bits.push(['', `${(ch.frequencyKHz / 1000).toFixed(3)} MHz`]);
      if (ch.mute === true) bits.push(['mute', 'MUTE']);
      for (const w of ch.warnings || []) bits.push(['warn', w]);
    }
    const key = JSON.stringify(bits);
    if (key !== block.infoKey) {
      block.infoKey = key;
      block.info.textContent = '';
      for (const [cls, text] of bits) block.info.appendChild(el('span', cls ? `tag ${cls}` : '', text));
    }
  }

  // --- settings dialog: RF link ---

  function fillRfEditor(current) {
    const sel = f.rfReceiver;
    sel.textContent = '';
    const none = el('option', null, '— none —');
    none.value = '';
    sel.appendChild(none);
    for (const r of state.show.receivers || []) {
      const live = state.rf[r.id];
      const opt = el('option', null, `${r.name}${live && live.online ? '' : ' (offline)'} · ${brandLabel(r.brand)}`);
      opt.value = r.id;
      if (current && current.receiverId === r.id) opt.selected = true;
      sel.appendChild(opt);
    }
    fillRfChannels(current ? current.channel : 1);
  }

  function fillRfChannels(wanted) {
    const sel = f.rfChannel;
    sel.textContent = '';
    const id = f.rfReceiver.value;
    const cfg = (state.show.receivers || []).find((r) => r.id === id);
    const live = id ? state.rf[id] : null;
    const known = live && live.channels ? Object.keys(live.channels).map(Number) : [];
    const spec = cfg && state.brands[cfg.brand];
    const count = known.length ? Math.max(...known) : (cfg && cfg.channels) || (spec && Math.min(spec.channels, 8)) || 4;
    for (let i = 1; i <= Math.max(count, wanted || 1); i++) {
      const ch = live && live.channels && live.channels[i];
      let label = String(i).padStart(2, '0');
      if (ch && ch.name) label += `  ${ch.name}`;
      if (ch && ch.txName && ch.txName !== ch.name) label += `  (${ch.txName})`;
      const opt = el('option', null, label);
      opt.value = String(i);
      if (i === wanted) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.disabled = !id;
  }

  f.rfReceiver.addEventListener('change', () => fillRfChannels(Number(f.rfChannel.value) || 1));

  function readRfLink() {
    const receiverId = f.rfReceiver.value;
    if (!receiverId) return null;
    return { receiverId, channel: Number(f.rfChannel.value) || 1 };
  }

  function brandLabel(brand) {
    return (state.brands[brand] && state.brands[brand].label.split(' (')[0]) || brand;
  }

  // ---------------------------------------------------------------------------
  // Receivers dialog
  // ---------------------------------------------------------------------------

  const rxModal = { open: false, id: null };
  const rx = {
    backdrop: $('rxModal'),
    close: $('btnCloseRx'),
    list: $('rxList'),
    found: $('rxFound'),
    newBtn: $('btnNewRx'),
    form: $('rxForm'),
    title: $('rxFormTitle'),
    brand: $('rxBrand'),
    brandHint: $('rxBrandHint'),
    name: $('rxName'),
    host: $('rxHost'),
    port: $('rxPort'),
    authRow: $('rxAuthRow'),
    user: $('rxUser'),
    pass: $('rxPass'),
    channels: $('rxChannels'),
    del: $('btnDeleteRx'),
    save: $('btnSaveRx')
  };

  els.receivers.addEventListener('click', () => openRxModal(null));
  rx.close.addEventListener('click', closeRxModal);
  rx.backdrop.addEventListener('click', (e) => {
    if (e.target === rx.backdrop) closeRxModal();
  });
  rx.newBtn.addEventListener('click', () => fillRxForm(null));

  function openRxModal(id) {
    rxModal.open = true;
    rx.brand.textContent = '';
    for (const [key, spec] of Object.entries(state.brands)) {
      const opt = el('option', null, spec.label);
      opt.value = key;
      rx.brand.appendChild(opt);
    }
    fillRxForm(id ? (state.show.receivers || []).find((r) => r.id === id) : null);
    renderRxList();
    rx.backdrop.hidden = false;
    refreshDiscovered();
  }

  function closeRxModal() {
    rxModal.open = false;
    rx.backdrop.hidden = true;
  }

  async function refreshDiscovered() {
    try {
      const data = await api('GET', '/api/receivers');
      rxModal.discovered = data.discovered || [];
      renderRxList();
    } catch {
      // ignore
    }
  }

  function fillRxForm(r, preset) {
    rxModal.id = r ? r.id : null;
    rx.title.textContent = r ? `Edit ${r.name}` : 'New receiver';
    rx.brand.value = r ? r.brand : preset ? preset.brand : Object.keys(state.brands)[0] || 'shure-ad';
    rx.name.value = r ? r.name : preset ? preset.name : '';
    rx.host.value = r ? r.host : preset ? preset.ip : '';
    rx.port.value = r && r.port ? r.port : '';
    rx.user.value = r ? r.username || '' : '';
    rx.pass.value = '';
    rx.pass.placeholder = r && r.hasPassword ? '(unchanged)' : '';
    rx.channels.value = r && r.channels ? r.channels : '';
    rx.del.hidden = !r;
    updateBrandHint();
    renderRxList();
  }

  function updateBrandHint() {
    const spec = state.brands[rx.brand.value];
    if (!spec) return;
    rx.authRow.hidden = !spec.auth;
    rx.port.placeholder = String(spec.port);
    rx.user.placeholder = spec.user || '';
    rx.channels.placeholder = 'auto';
    const hints = {
      'shure-ad': 'Command strings over TCP 2202. Enable them on the unit: Device Configuration › Network Services. Audio and RF levels, quality, transmitter battery, mute, interference.',
      'sennheiser-ewdx': 'HTTPS on port 443 with the "api" user. Allow third-party access on the receiver and set its password there.',
      'sennheiser-ewdx-v1': 'Sound Control over UDP 45 (firmware before 4.0). No credentials.',
      'sennheiser-6000': 'Sound Control over UDP 45, using the EW-DX address layout. Unverified: paths may need adjusting for this unit.',
      'sennheiser-spectera': 'HTTPS on port 443 with the "controlSennheiser" user. One channel per paired mobile device, in the order the base station lists them.'
    };
    rx.brandHint.textContent = hints[rx.brand.value] || '';
  }
  rx.brand.addEventListener('change', updateBrandHint);

  function renderRxList() {
    rx.list.textContent = '';
    const receivers = state.show.receivers || [];
    if (!receivers.length) rx.list.appendChild(el('li', 'hint', 'No receivers yet.'));
    for (const r of receivers) {
      const live = state.rf[r.id];
      const li = el('li', `rx-item${rxModal.id === r.id ? ' selected' : ''}`);
      const name = el('div', 'rx-name');
      name.append(el('span', `dot${live && live.online ? ' on' : ''}`), r.name);
      const chans = live && live.channels ? Object.keys(live.channels).length : 0;
      li.append(name, el('div', 'rx-sub', `${brandLabel(r.brand)} · ${r.host}${live && live.model ? ` · ${live.model}` : ''}${chans ? ` · ${chans} ch` : ''}${live && live.lastError ? ` · ${live.lastError}` : ''}`));
      li.addEventListener('click', () => fillRxForm(r));
      rx.list.appendChild(li);
    }
    rx.found.textContent = '';
    const found = (rxModal.discovered || []).filter((d) => !receivers.some((r) => r.host === d.ip));
    if (!found.length) rx.found.appendChild(el('li', 'hint', 'Nothing found yet. Shure units answer SLP, Sennheiser units mDNS; you can always add by IP.'));
    for (const d of found) {
      const li = el('li', 'rx-item');
      li.append(el('div', 'rx-name', `${d.name || d.model}`), el('div', 'rx-sub', `${d.model} · ${d.ip} — click to add`));
      li.addEventListener('click', () => fillRxForm(null, d));
      rx.found.appendChild(li);
    }
  }

  rx.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    rx.save.disabled = true;
    try {
      const body = { brand: rx.brand.value, name: rx.name.value.trim() || rx.host.value.trim(), host: rx.host.value.trim(), port: rx.port.value || null, username: rx.user.value.trim(), channels: rx.channels.value || null };
      if (rx.pass.value) body.password = rx.pass.value;
      if (rxModal.id) await api('PATCH', `/api/receivers/${encodeURIComponent(rxModal.id)}`, body);
      else {
        const created = await api('POST', '/api/receivers', body);
        rxModal.id = created.id;
      }
      rx.pass.value = '';
      toast('Receiver saved');
    } catch (err) {
      toast(err.message, true);
    } finally {
      rx.save.disabled = false;
    }
  });

  rx.del.addEventListener('click', async () => {
    if (!rxModal.id) return;
    if (!window.confirm('Remove this receiver? Cards linked to it lose their RF readouts.')) return;
    try {
      await api('DELETE', `/api/receivers/${encodeURIComponent(rxModal.id)}`);
      fillRxForm(null);
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------------------------------------------------------------------------
  // Toast
  // ---------------------------------------------------------------------------

  let toastTimer = null;
  function toast(text, isError) {
    els.toast.textContent = text;
    els.toast.className = `toast${isError ? ' error' : ''}`;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.hidden = true), isError ? 6000 : 3000);
  }

  let initialized = false;
  try {
    setEditing(localStorage.getItem(EDIT_KEY) !== '0');
  } catch {
    setEditing(true);
  }
  initialized = true;
  connect();
  requestAnimationFrame(frame);
})();
