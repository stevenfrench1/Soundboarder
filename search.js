// Online sound-effect search, powered by Openverse (https://openverse.org).
//
// Openverse is a free, keyless search service for openly licensed media run
// by WordPress.org. Its audio index includes Freesound and Wikimedia Commons.
// Every result is a direct audio file under a Creative Commons licence (or
// public domain), so a picked sound is downloaded once, decoded and stored on
// the device exactly like an MP3 chosen from Files. After that it plays
// instantly and offline; the network is only used while searching.
'use strict';

const SoundSearch = (() => {
  const API = 'https://api.openverse.org/v1/audio/';
  // Sources whose files are plain audio downloads, usable on a soundboard.
  const SOURCES = 'freesound,wikimedia_audio';
  const PAGE_SIZE = 20; // the most Openverse allows without an API key
  const MAX_BYTES = 25 * 1024 * 1024;

  // When a host doesn't allow the app to download directly (CORS), the file
  // is fetched through the same-origin rewrites in netlify.toml instead.
  const PROXY = {
    'api.openverse.org': '/sfx/openverse/',
    'cdn.freesound.org': '/sfx/freesound-cdn/',
    'freesound.org': '/sfx/freesound/',
    'upload.wikimedia.org': '/sfx/wikimedia/',
  };

  const SOURCE_NAMES = { freesound: 'Freesound', wikimedia_audio: 'Wikimedia Commons' };
  const LICENCE_NAMES = {
    by: 'CC BY', 'by-sa': 'CC BY-SA', 'by-nc': 'CC BY-NC', 'by-nd': 'CC BY-ND',
    'by-nc-sa': 'CC BY-NC-SA', 'by-nc-nd': 'CC BY-NC-ND', cc0: 'CC0', pdm: 'Public domain',
    sampling: 'Sampling+', 'nc-sampling': 'NC Sampling+',
  };

  function licenceLabel(r) {
    const base = LICENCE_NAMES[r.license] || (r.license || '').toUpperCase();
    return r.license_version && !['cc0', 'pdm'].includes(r.license) ? `${base} ${r.license_version}` : base;
  }
  const isNonCommercial = (lic) => /(^|-)nc(-|$)/.test(lic || '');
  const needsCredit = (lic) => !['cc0', 'pdm'].includes(lic);

  function safeUrl(u) {
    try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : ''; } catch (_) { return ''; }
  }

  function proxied(url) {
    const u = new URL(url);
    const base = PROXY[u.hostname];
    if (!base || location.protocol === 'file:') return null;
    return base + u.pathname.replace(/^\//, '') + u.search;
  }

  // Try the host directly, then via the proxy if the browser blocked it.
  async function get(url, opts = {}) {
    try {
      const res = await fetch(url, { ...opts, credentials: 'omit', referrerPolicy: 'no-referrer' });
      return res;
    } catch (err) {
      if (opts.signal && opts.signal.aborted) throw err;
      const p = proxied(url);
      if (!p) throw err;
      return fetch(p, { ...opts, credentials: 'omit' });
    }
  }

  async function search(query, { page = 1, commercial = true, signal } = {}) {
    const params = new URLSearchParams({
      q: query, category: 'sound_effect', source: SOURCES,
      page_size: String(PAGE_SIZE), page: String(page), mature: 'false',
    });
    if (commercial) params.set('license_type', 'commercial');
    const res = await get(`${API}?${params}`, { signal, headers: { Accept: 'application/json' } });
    if (res.status === 429) throw Object.assign(new Error('rate'), { code: 'rate' });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'http' });
    const data = await res.json();
    const results = (data.results || []).filter((r) => r.url && safeUrl(r.url));
    return { results, count: data.result_count || 0, pages: data.page_count || 1 };
  }

  async function download(r, signal) {
    const res = await get(r.url, { signal });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'http' });
    const len = +res.headers.get('content-length') || 0;
    if (len > MAX_BYTES) throw Object.assign(new Error('too big'), { code: 'size' });
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) throw Object.assign(new Error('too big'), { code: 'size' });
    return { bytes, type: res.headers.get('content-type') || '' };
  }

  // What we keep with a pad so the credit can be shown and copied later.
  function creditFor(r) {
    return {
      title: r.title || 'Untitled',
      creator: r.creator || '',
      creatorUrl: safeUrl(r.creator_url),
      license: r.license || '',
      licenseLabel: licenceLabel(r),
      licenseUrl: safeUrl(r.license_url),
      pageUrl: safeUrl(r.foreign_landing_url),
      source: SOURCE_NAMES[r.source] || r.source || '',
      attribution: r.attribution || '',
      nonCommercial: isNonCommercial(r.license),
      needsCredit: needsCredit(r.license),
    };
  }

  function creditText(c) {
    if (c.attribution) return c.attribution;
    const by = c.creator ? ` by ${c.creator}` : '';
    return `"${c.title}"${by}, ${c.licenseLabel}${c.licenseUrl ? ` (${c.licenseUrl})` : ''}, via ${c.source}`;
  }

  // ---------- UI ----------
  const $ = (s) => document.querySelector(s);
  const dlg = $('#searchDialog');
  const form = $('#searchForm');
  const input = $('#searchInput');
  const commercialBox = $('#searchCommercial');
  const list = $('#searchResults');
  const status = $('#searchStatus');
  const more = $('#searchMore');

  let state = null; // { query, page, pages, onPick, ctrl, previewing, busy }

  const fmtDur = (ms) => {
    if (!ms) return '';
    const s = ms / 1000;
    return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  };

  function setStatus(msg) { status.textContent = msg; status.hidden = !msg; }

  function errorText(err) {
    if (!navigator.onLine) return "You're offline. Search needs the internet; sounds already on your pads still work.";
    if (err && err.code === 'rate') return 'Too many searches in a row. Wait a few seconds and try again.';
    if (err && err.code === 'size') return 'That file is too large for a pad (over 25 MB).';
    if (err && err.code === 'decode') return "That file's format won't play on this device. Try another result.";
    return "Couldn't reach the sound library. Check your connection and try again.";
  }

  function open({ onPick, initialQuery = '' }) {
    state = { query: '', page: 1, pages: 1, onPick, ctrl: null, previewing: null, cache: new Map() };
    if (initialQuery && !input.value) input.value = initialQuery;
    dlg.showModal();
    if (!list.children.length) setStatus('Search Freesound and Wikimedia Commons for free sound effects.');
    input.focus();
  }

  function stopPreview() {
    if (state && state.previewing) {
      Engine.unload('search-preview');
      const btn = list.querySelector('.res-preview.playing');
      if (btn) { btn.classList.remove('playing'); btn.textContent = '▶'; btn.setAttribute('aria-label', 'Preview'); }
      state.previewing = null;
    }
  }

  async function run(page) {
    const q = input.value.trim();
    if (!q) { input.focus(); return; }
    if (state.ctrl) state.ctrl.abort();
    const ctrl = new AbortController();
    state.ctrl = ctrl;
    if (page === 1) { stopPreview(); list.innerHTML = ''; }
    more.hidden = true;
    setStatus('Searching…');
    try {
      const { results, count, pages } = await search(q, { page, commercial: commercialBox.checked, signal: ctrl.signal });
      if (ctrl.signal.aborted) return;
      state.query = q; state.page = page; state.pages = pages;
      results.forEach((r) => list.appendChild(row(r)));
      if (!list.children.length) setStatus(`No sound effects found for "${q}". Try a simpler word${commercialBox.checked ? ', or include non-commercial sounds' : ''}.`);
      else setStatus(page === 1 ? `${count >= 10000 ? '10,000+' : count.toLocaleString()} result${count === 1 ? '' : 's'}` : '');
      more.hidden = page >= pages || !results.length;
    } catch (err) {
      if (ctrl.signal.aborted) return;
      console.error(err);
      setStatus(errorText(err));
    }
  }

  function row(r) {
    const c = creditFor(r);
    const li = document.createElement('li');
    li.className = 'res';
    li.innerHTML = `
      <button type="button" class="res-preview" aria-label="Preview">▶</button>
      <div class="res-main">
        <div class="res-title"></div>
        <div class="res-meta"></div>
      </div>
      <button type="button" class="btn btn-small btn-primary res-use">Use</button>`;
    li.querySelector('.res-title').textContent = c.title;
    const meta = li.querySelector('.res-meta');
    const parts = [fmtDur(r.duration), c.creator && `by ${c.creator}`, c.source].filter(Boolean);
    meta.textContent = parts.join(' · ') + ' · ';
    const lic = document.createElement('span');
    lic.className = 'lic' + (c.nonCommercial ? ' lic-nc' : '');
    lic.textContent = c.licenseLabel;
    lic.title = c.nonCommercial ? 'Non-commercial use only' : (c.needsCredit ? 'Free to use with credit' : 'No credit required');
    meta.appendChild(lic);
    li.querySelector('.res-preview').addEventListener('click', (e) => preview(r, e.currentTarget));
    li.querySelector('.res-use').addEventListener('click', (e) => use(r, e.currentTarget));
    return li;
  }

  // Download + decode, reusing the bytes if this result was already fetched.
  async function fetchDecoded(r, slot) {
    let got = state.cache.get(r.id);
    if (!got) {
      got = await download(r);
      state.cache.set(r.id, got);
    }
    try { await Engine.load(slot, got.bytes); } catch (_) { throw Object.assign(new Error('decode'), { code: 'decode' }); }
    return got;
  }

  async function preview(r, btn) {
    const wasThis = state.previewing === r.id;
    stopPreview();
    if (wasThis) return;
    btn.textContent = '…';
    btn.disabled = true;
    try {
      await Engine.unlock();
      await fetchDecoded(r, 'search-preview');
      if (!dlg.open) return;
      state.previewing = r.id;
      btn.classList.add('playing');
      btn.textContent = '■';
      btn.setAttribute('aria-label', 'Stop preview');
      Engine.play({ id: 'search-preview', volume: 100 });
    } catch (err) {
      console.error(err);
      btn.textContent = '▶';
      setStatus(errorText(err));
    } finally {
      btn.disabled = false;
    }
  }

  Engine.onChange((id) => {
    if (id === 'search-preview' && state && state.previewing && !Engine.isPlaying('search-preview')) stopPreview();
  });

  async function use(r, btn) {
    stopPreview();
    const label = btn.textContent;
    btn.textContent = 'Adding…';
    btn.disabled = true;
    try {
      const got = await fetchDecoded(r, 'search-preview');
      Engine.unload('search-preview');
      const ext = (r.filetype || (got.type.split('/')[1]) || 'mp3').replace('mpeg', 'mp3');
      const name = `${(r.title || 'Sound').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 60)}.${ext}`;
      const pick = state.onPick;
      dlg.close();
      pick({ bytes: got.bytes, name, type: got.type || `audio/${ext}`, credit: creditFor(r) });
    } catch (err) {
      console.error(err);
      setStatus(errorText(err));
      btn.textContent = label;
      btn.disabled = false;
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); run(1); });
  more.addEventListener('click', () => run(state.page + 1));
  commercialBox.addEventListener('change', () => { if (input.value.trim()) run(1); });
  $('#searchClose').addEventListener('click', () => dlg.close());
  dlg.addEventListener('close', () => {
    stopPreview();
    if (state && state.ctrl) state.ctrl.abort();
    if (state) state.cache.clear();
  });

  return { open, creditText };
})();
