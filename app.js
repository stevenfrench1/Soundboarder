// SoundBoarder UI: board, pads, editor, keyboard shortcuts, persistence.
'use strict';

(() => {
  const MAX_PADS = 12;
  const COLOURS = [
    '#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff',
    '#3e63dd', '#8e4ec6', '#d6409f', '#ad7f58', '#8b8d98', '#ffffff',
  ];
  // Three rows of four on a keyboard, matching the default 4 x 3 board.
  const DEFAULT_KEYS = ['q', 'w', 'e', 'r', 'a', 's', 'd', 'f', 'z', 'x', 'c', 'v'];

  const $ = (sel) => document.querySelector(sel);
  const board = $('#board');
  const padCountSel = $('#padCount');
  const editToggle = $('#editToggle');
  const stopAllBtn = $('#stopAll');
  const unlockEl = $('#unlock');
  const unlockStatus = $('#unlockStatus');
  const editor = $('#editor');
  const toastEl = $('#toast');

  let pads = [];
  const MAX_FILE_BYTES = 120e6; // don't even read bigger files into memory
  const failedPads = new Set(); // pads with a stored sound that couldn't be loaded
  let visibleCount = 12;
  let editMode = false;
  let unlocked = false;
  const padEls = [];

  const defaultPad = (id) => ({
    id, name: '', color: COLOURS[id % COLOURS.length], volume: 100,
    loop: false, fadeIn: 0, fadeOut: 0, key: DEFAULT_KEYS[id] || '', fileName: '',
  });

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2600);
  }

  // ---------- layout ----------
  // Pick the column count that gives the biggest, squarest pads for the space.
  function layout() {
    const n = visibleCount;
    const rect = board.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(board).gap) || 10;
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    let best = { cols: 1, score: -1 };
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      const cw = (w - gap * (cols - 1)) / cols;
      const ch = (h - gap * (rows - 1)) / rows;
      const side = Math.min(cw, ch);
      // biggest pads win; on a near tie, prefer fewer empty cells
      const score = side - (cols * rows - n) * 2;
      if (score > best.score) best = { cols, rows, score };
    }
    board.style.gridTemplateColumns = `repeat(${best.cols}, 1fr)`;
    board.style.gridTemplateRows = `repeat(${best.rows}, 1fr)`;
  }

  // ---------- rendering ----------
  function buildBoard() {
    board.innerHTML = '';
    padEls.length = 0;
    for (let i = 0; i < MAX_PADS; i++) {
      const el = document.createElement('div');
      el.className = 'pad';
      el.dataset.id = i;
      el.setAttribute('role', 'button');
      el.innerHTML = `
        <span class="pad-progress" aria-hidden="true"></span>
        <span class="pad-name"></span>
        <span class="pad-meta"><span class="pad-flags"></span><kbd class="pad-key"></kbd></span>
        <button class="pad-stop" type="button" aria-label="Stop this pad" tabindex="-1">■</button>`;
      board.appendChild(el);
      padEls.push(el);
    }
    renderAll();
  }

  function renderPad(i) {
    const pad = pads[i];
    const el = padEls[i];
    const loaded = Engine.has(i);
    el.hidden = i >= visibleCount;
    el.style.setProperty('--pad', pad.color);
    el.classList.toggle('empty', !loaded);
    el.classList.toggle('light', isLight(pad.color));
    el.classList.toggle('playing', Engine.isPlaying(i));
    el.classList.toggle('stopping', Engine.isStopping(i));
    el.querySelector('.pad-name').textContent =
      loaded ? (pad.name || pad.fileName || `Pad ${i + 1}`)
        : failedPads.has(i) ? `⚠ ${pad.name || pad.fileName} (not loaded)`
        : (editMode ? '+ Add sound' : 'Empty');
    el.querySelector('.pad-key').textContent = pad.key ? pad.key.toUpperCase() : '';
    el.querySelector('.pad-key').hidden = !pad.key;
    const flags = [];
    if (pad.loop) flags.push('Loop');
    if (pad.fadeIn > 0 || pad.fadeOut > 0) flags.push('Fade');
    if (pad.volume < 100) flags.push(`${pad.volume}%`);
    el.querySelector('.pad-flags').textContent = loaded ? flags.join(' · ') : '';
    el.setAttribute('aria-label',
      loaded ? `${pad.name || 'Pad ' + (i + 1)}${pad.key ? ', key ' + pad.key.toUpperCase() : ''}` : `Empty pad ${i + 1}`);
  }

  function renderAll() {
    for (let i = 0; i < MAX_PADS; i++) renderPad(i);
    document.body.classList.toggle('editing', editMode);
    editToggle.textContent = editMode ? 'Done' : 'Edit';
    editToggle.setAttribute('aria-pressed', String(editMode));
    $('#editHint').hidden = !editMode;
    layout();
  }

  function isLight(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.299 * r + 0.587 * g + 0.114 * b) > 165;
  }

  // Progress bar animation while anything is playing.
  let raf = 0;
  function tick() {
    const ids = Engine.playingIds();
    for (const id of ids) {
      const p = Engine.progress(id);
      if (p != null && padEls[id]) padEls[id].style.setProperty('--p', p.toFixed(4));
    }
    raf = ids.length ? requestAnimationFrame(tick) : 0;
  }
  Engine.onChange((id) => {
    if (typeof id === 'number' && padEls[id]) {
      renderPad(id);
      if (!Engine.isPlaying(id)) padEls[id].style.setProperty('--p', 0);
    }
    stopAllBtn.classList.toggle('active', Engine.playingIds().length > 0);
    if (!raf && Engine.playingIds().length) raf = requestAnimationFrame(tick);
  });

  // ---------- triggering ----------
  function trigger(i) {
    if (i >= visibleCount) return;
    if (!Engine.has(i)) { if (!editMode) openEditor(i); return; }
    Engine.play(pads[i]);
  }

  function stopPad(i) {
    Engine.stop(i, { fadeOut: pads[i].fadeOut });
  }

  function stopAll() {
    for (const id of Engine.playingIds()) stopPad(id);
  }

  board.addEventListener('pointerdown', (e) => {
    const padEl = e.target.closest('.pad');
    if (!padEl) return;
    const i = +padEl.dataset.id;
    e.preventDefault();
    if (!unlocked) doUnlock();
    if (e.target.closest('.pad-stop')) { stopPad(i); return; }
    if (editMode) { openEditor(i); return; }
    // fire on press, not release, for the lowest possible latency
    trigger(i);
    padEl.classList.add('pressed');
  });
  const release = (e) => {
    const padEl = e.target.closest && e.target.closest('.pad');
    (padEl ? [padEl] : padEls).forEach((p) => p.classList.remove('pressed'));
  };
  board.addEventListener('pointerup', release);
  board.addEventListener('pointercancel', release);
  board.addEventListener('pointerleave', release);
  board.addEventListener('contextmenu', (e) => e.preventDefault());

  stopAllBtn.addEventListener('click', stopAll);

  document.addEventListener('keydown', (e) => {
    if (editor.open) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!unlocked) doUnlock();
    if (e.key === 'Escape') { e.preventDefault(); stopAll(); return; }
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    if (!k || k.length !== 1) return;
    const i = pads.findIndex((p, idx) => idx < visibleCount && p.key === k);
    if (i < 0) return;
    e.preventDefault();
    if (e.shiftKey) stopPad(i);
    else {
      trigger(i);
      padEls[i].classList.add('pressed');
      setTimeout(() => padEls[i].classList.remove('pressed'), 120);
    }
  });

  // ---------- toolbar ----------
  for (let n = 1; n <= MAX_PADS; n++) {
    const o = document.createElement('option');
    o.value = n; o.textContent = n;
    padCountSel.appendChild(o);
  }
  padCountSel.addEventListener('change', () => {
    visibleCount = +padCountSel.value;
    // stop anything that just got hidden
    for (const id of Engine.playingIds()) if (id >= visibleCount) Engine.stop(id, { immediate: true });
    DB.putSetting('visibleCount', visibleCount);
    renderAll();
  });

  editToggle.addEventListener('click', () => { editMode = !editMode; renderAll(); });

  // ---------- editor ----------
  const f = {
    title: $('#editorTitle'), fileName: $('#fileName'), fileInput: $('#fileInput'), fileError: $('#fileError'),
    name: $('#nameInput'), swatches: $('#swatches'), volume: $('#volumeInput'), volumeOut: $('#volumeOut'),
    fadeIn: $('#fadeInInput'), fadeOut: $('#fadeOutInput'), loop: $('#loopInput'), key: $('#keyInput'),
    preview: $('#previewBtn'), clear: $('#clearBtn'), save: $('#saveBtn'),
  };
  let editing = null; // { id, color, pending: { bytes, name, type } | null }
  const PREVIEW_ID = 'preview';

  COLOURS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = c;
    b.dataset.color = c;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', `Colour ${c}`);
    b.addEventListener('click', () => selectColour(c));
    f.swatches.appendChild(b);
  });
  function selectColour(c) {
    editing.color = c;
    f.swatches.querySelectorAll('.swatch').forEach((s) => s.setAttribute('aria-checked', String(s.dataset.color === c)));
  }

  function openEditor(i) {
    const pad = pads[i];
    editing = { id: i, color: pad.color, pending: null };
    f.title.textContent = `Pad ${i + 1}`;
    f.fileName.textContent = Engine.has(i) ? `${pad.fileName || 'Sound'} (${fmtDur(Engine.duration(i))})` : 'No sound loaded';
    f.fileError.hidden = true;
    f.fileInput.value = '';
    f.name.value = pad.name;
    f.volume.value = pad.volume;
    f.volumeOut.textContent = `${pad.volume}%`;
    f.fadeIn.value = pad.fadeIn;
    f.fadeOut.value = pad.fadeOut;
    f.loop.checked = pad.loop;
    f.key.value = pad.key ? pad.key.toUpperCase() : '';
    f.clear.hidden = !Engine.has(i) && !failedPads.has(i);
    f.preview.disabled = !Engine.has(i);
    selectColour(pad.color);
    editor.returnValue = '';
    editor.showModal();
  }

  function fmtDur(s) {
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1).padStart(4, '0');
    return m ? `${m}:${sec}` : `${(+s).toFixed(1)}s`;
  }

  $('#cancelBtn').addEventListener('click', () => editor.close('cancel'));
  f.volume.addEventListener('input', () => { f.volumeOut.textContent = `${f.volume.value}%`; });
  f.key.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' || e.key === 'Enter') return;
    e.preventDefault();
    if (e.key === 'Backspace' || e.key === 'Delete') { f.key.value = ''; return; }
    if (e.key === 'Escape') return;
    if (e.key.length === 1 && e.key !== ' ') f.key.value = e.key.toUpperCase();
  });
  f.key.addEventListener('input', () => { f.key.value = f.key.value.slice(-1).toUpperCase(); });

  f.fileInput.addEventListener('change', async () => {
    const file = f.fileInput.files[0];
    if (!file) return;
    f.fileError.hidden = true;
    f.fileName.textContent = `Decoding ${file.name}…`;
    try {
      if (file.size > MAX_FILE_BYTES) throw Object.assign(new Error('too big'), { name: 'TooLongError' });
      const bytes = await file.arrayBuffer();
      const buf = await Engine.load(PREVIEW_ID, bytes);
      editing.pending = { bytes, name: file.name, type: file.type };
      f.fileName.textContent = `${file.name} (${fmtDur(buf.duration)})`;
      if (!f.name.value.trim()) f.name.value = file.name.replace(/\.[^.]+$/, '').slice(0, 40);
      f.preview.disabled = false;
    } catch (err) {
      editing.pending = null;
      f.fileName.textContent = Engine.has(editing.id) ? (pads[editing.id].fileName || 'Sound') : 'No sound loaded';
      console.warn('Could not load file', file.name, file.type, file.size, err);
      f.fileError.textContent = err && err.name === 'TooLongError' ? 'That sound is too long for a pad (10 minutes max). Try a shorter clip.'
        : file.size === 0
        ? `"${file.name}" is empty. If it's in iCloud Drive, open it once in the Files app so it downloads, then try again.`
        : `Couldn't read "${file.name}" as audio. Try an MP3 file.`;
      f.fileError.hidden = false;
    }
  });

  function formValues(ed = editing) {
    const num = (v, max) => Math.max(0, Math.min(max, parseFloat(v) || 0));
    return {
      name: f.name.value.trim(),
      color: ed.color,
      volume: Math.round(num(f.volume.value, 100)),
      fadeIn: num(f.fadeIn.value, 30),
      fadeOut: num(f.fadeOut.value, 30),
      loop: f.loop.checked,
      key: f.key.value.toLowerCase(),
    };
  }

  f.preview.addEventListener('click', () => {
    if (!unlocked) doUnlock();
    const id = editing.pending ? PREVIEW_ID : editing.id;
    if (Engine.isPlaying(id)) { Engine.stop(id, { immediate: true }); return; }
    Engine.play({ ...pads[editing.id], ...formValues(), id });
  });

  f.clear.addEventListener('click', async () => {
    const id = editing.id;
    Engine.unload(id);
    failedPads.delete(id); skipList(id, false);
    pads[id] = { ...defaultPad(id), color: pads[id].color, key: pads[id].key };
    await Promise.all([DB.deleteSound(id), DB.putPad(pads[id])]);
    editor.close('cleared');
    renderPad(id);
    toast(`Pad ${id + 1} cleared`);
  });

  editor.addEventListener('close', async () => {
    Engine.unload(PREVIEW_ID);
    const ed = editing;
    if (!ed || editor.returnValue !== 'save') { editing = null; return; }
    editing = null;
    await savePad(ed);
  });

  async function savePad(ed) {
    const id = ed.id;
    const vals = formValues(ed);
    const pad = { ...pads[id], ...vals };
    // a key can only belong to one pad
    if (pad.key) {
      pads.forEach((p, j) => {
        if (j !== id && p.key === pad.key) {
          p.key = '';
          DB.putPad(p);
          renderPad(j);
          toast(`Key ${pad.key.toUpperCase()} moved from pad ${j + 1}`);
        }
      });
    }
    try {
      if (ed.pending) {
        await Engine.load(id, ed.pending.bytes);
        await DB.putSound(id, ed.pending);
        pad.fileName = ed.pending.name;
        failedPads.delete(id); skipList(id, false);
        requestPersistence();
      }
      pads[id] = pad;
      await DB.putPad(pad);
    } catch (err) {
      console.error(err);
      toast(err && err.name === 'QuotaExceededError'
        ? 'Not enough storage space on this device for that sound'
        : err && err.name === 'TooLongError' ? 'That sound is too long for a pad (10 minutes max). Try a shorter clip.'
        : 'Could not save that pad');
    }
    renderPad(id);
  }

  // Drag and drop: drop an audio file (e.g. from the Files app in iPad
  // Split View, or from Finder) straight onto a pad. This also works when
  // the iOS file picker can't open iCloud Drive.
  async function loadDroppedFile(id, file) {
    try {
      if (file.size > MAX_FILE_BYTES) throw Object.assign(new Error('too big'), { name: 'TooLongError' });
      const bytes = await file.arrayBuffer();
      await Engine.load(id, bytes);
      failedPads.delete(id); skipList(id, false);
      const pad = pads[id];
      if (!pad.name || pad.name === (pad.fileName || '').replace(/\.[^.]+$/, '').slice(0, 40)) {
        pad.name = file.name.replace(/\.[^.]+$/, '').slice(0, 40);
      }
      pad.fileName = file.name;
      await DB.putSound(id, { bytes, name: file.name, type: file.type });
      await DB.putPad(pad);
      requestPersistence();
      toast(`Loaded "${file.name}" into pad ${id + 1}`);
    } catch (err) {
      console.warn('Could not load dropped file', file.name, err);
      toast(err && err.name === 'QuotaExceededError'
        ? 'Not enough storage space on this device for that sound'
        : err && err.name === 'TooLongError' ? 'That sound is too long for a pad (10 minutes max). Try a shorter clip.'
        : `Couldn't read "${file.name}" as audio`);
    }
    renderPad(id);
  }
  board.addEventListener('dragover', (e) => {
    const padEl = e.target.closest('.pad');
    if (!padEl || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    padEls.forEach((p) => p.classList.toggle('drop-target', p === padEl));
  });
  board.addEventListener('dragleave', (e) => {
    if (!board.contains(e.relatedTarget)) padEls.forEach((p) => p.classList.remove('drop-target'));
  });
  board.addEventListener('drop', (e) => {
    const padEl = e.target.closest('.pad');
    padEls.forEach((p) => p.classList.remove('drop-target'));
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (!padEl || !file) return;
    e.preventDefault();
    loadDroppedFile(+padEl.dataset.id, file);
  });

  // Ask the browser not to evict our stored sounds under storage pressure.
  let persistAsked = false;
  function requestPersistence() {
    if (persistAsked || !navigator.storage || !navigator.storage.persist) return;
    persistAsked = true;
    navigator.storage.persist().catch(() => {});
  }

  // ---------- unlock overlay ----------
  async function doUnlock() {
    if (unlocked) return;
    unlocked = true;
    unlockEl.classList.add('hidden');
    await Engine.unlock();
  }
  unlockEl.addEventListener('pointerdown', (e) => { e.preventDefault(); doUnlock(); });
  unlockEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') doUnlock(); });

  document.addEventListener('visibilitychange', () => { if (!document.hidden && unlocked) Engine.ensureRunning(); });
  window.addEventListener('pointerdown', () => { if (unlocked) Engine.ensureRunning(); }, { capture: true });
  window.addEventListener('resize', layout);

  // ---------- startup ----------
  const DECODING_KEY = 'soundboarder-decoding';
  const MEMORY_BUDGET = 450e6; // decoded audio; well under what iPad Safari allows a tab
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* ignore */ } };

  // Pads whose sound closed the app while loading stay skipped until replaced or cleared.
  const SKIP_KEY = 'soundboarder-skip';
  function skipList(id, add) {
    let list = [];
    try { list = JSON.parse(lsGet(SKIP_KEY) || '[]'); } catch (_) { /* ignore */ }
    if (id === undefined) return list;
    list = list.filter((x) => x !== id);
    if (add) list.push(id);
    lsSet(SKIP_KEY, list.length ? JSON.stringify(list) : null);
    return list;
  }

  async function init() {
    pads = Array.from({ length: MAX_PADS }, (_, i) => defaultPad(i));
    let stored = [];
    try {
      stored = await DB.getAllPads();
      const vc = await DB.getSetting('visibleCount');
      if (vc) visibleCount = Math.max(1, Math.min(MAX_PADS, vc));
    } catch (err) {
      console.error(err);
      toast('Storage is unavailable, so changes will not be kept');
    }
    for (const p of stored) if (p.id >= 0 && p.id < MAX_PADS) pads[p.id] = { ...defaultPad(p.id), ...p };
    padCountSel.value = visibleCount;
    buildBoard();

    // Decode every stored sound now, so triggering never waits. One at a time,
    // so memory peaks low. Before each, note which pad is decoding: if Safari
    // closes the page mid-decode (out of memory), the next launch skips that
    // pad instead of crashing again.
    const crashedOn = lsGet(DECODING_KEY);
    lsSet(DECODING_KEY, null);
    if (crashedOn !== null) skipList(+crashedOn, true);
    const skip = new Set(skipList());
    const withSound = pads.filter((p) => p.fileName);
    let done = 0;
    const skipped = [];
    unlockStatus.textContent = withSound.length ? `Loading sounds… 0 of ${withSound.length}` : 'Ready';
    for (const p of withSound) {
      if (skip.has(p.id)) {
        skipped.push(p.id);
      } else if (Engine.memoryUsed() > MEMORY_BUDGET) {
        skipped.push(p.id);
      } else {
        lsSet(DECODING_KEY, String(p.id));
        try {
          const rec = await DB.getSound(p.id);
          if (rec && rec.bytes) await Engine.load(p.id, rec.bytes);
        } catch (err) {
          console.error('Could not load pad', p.id, err);
          skipped.push(p.id);
        }
        lsSet(DECODING_KEY, null);
      }
      done++;
      unlockStatus.textContent = `Loading sounds… ${done} of ${withSound.length}`;
      renderPad(p.id);
    }
    const ok = withSound.length - skipped.length;
    unlockStatus.textContent = withSound.length ? `${ok} sound${ok === 1 ? '' : 's'} ready` : 'Ready';
    if (skipped.length) {
      skipped.forEach((id) => { failedPads.add(id); renderPad(id); });
      unlockStatus.textContent += `. Couldn't load pad ${skipped.map((id) => id + 1).join(', ')} (too large for this device). Replace or clear it in Edit.`;
    }
    document.body.classList.add('ready');
  }

  init();

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('Service worker not registered', err));
  }
})();
