// Audio engine. Every sound is decoded into memory up front (an AudioBuffer),
// so triggering a pad only starts a buffer that is already ready: no loading,
// no decoding and no network at trigger time.
'use strict';

const Engine = (() => {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ latencyHint: 'interactive' });
  const master = ctx.createGain();
  master.connect(ctx.destination);

  // Ask iOS 17+ to treat this as media playback, so sound still plays
  // when the ring/silent switch is set to silent.
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (_) { /* not supported */ }

  const buffers = new Map(); // pad id -> AudioBuffer
  const voices = new Map();  // pad id -> { src, gain, started, duration, loop, stopping }
  const listeners = new Set();
  const CLICK_GUARD = 0.012; // tiny ramp so hard stops don't click

  const notify = (id) => listeners.forEach((fn) => fn(id));

  function decode(arrayBuffer) {
    // slice() so the stored bytes are not detached by decodeAudioData
    const copy = arrayBuffer.slice(0);
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(copy, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }

  // Decoded audio is uncompressed and large (about 23 MB per stereo minute),
  // and iPad Safari closes a tab that uses too much memory. So refuse files
  // that would decode to more than a pad needs.
  const MAX_SECONDS = 600;
  const tooLong = () => Object.assign(new Error('Sound too long for a pad'), { name: 'TooLongError' });

  function checkSize(arrayBuffer) {
    const head = new Uint8Array(arrayBuffer, 0, Math.min(4, arrayBuffer.byteLength));
    const isWav = String.fromCharCode(...head) === 'RIFF';
    // ~10 minutes of 192 kbps MP3, or of 16-bit 48 kHz stereo WAV
    if (arrayBuffer.byteLength > (isWav ? 120e6 : 15e6)) throw tooLong();
  }

  async function load(id, arrayBuffer) {
    checkSize(arrayBuffer);
    const buf = await decode(arrayBuffer);
    if (buf.duration > MAX_SECONDS) throw tooLong();
    buffers.set(id, buf);
    return buf;
  }

  function unload(id) {
    stop(id, { immediate: true });
    buffers.delete(id);
  }

  function hardStop(voice, at) {
    const g = voice.gain.gain;
    try {
      if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(at);
      else { g.cancelScheduledValues(at); g.setValueAtTime(g.value, at); }
      g.linearRampToValueAtTime(0, at + CLICK_GUARD);
      voice.src.stop(at + CLICK_GUARD + 0.005);
    } catch (_) { /* already stopped */ }
  }

  function play(pad) {
    const buf = buffers.get(pad.id);
    if (!buf) return false;
    if (ctx.state !== 'running') ctx.resume();

    const now = ctx.currentTime;
    const old = voices.get(pad.id);
    if (old) { hardStop(old, now); voices.delete(pad.id); }

    const vol = Math.max(0, Math.min(1, (pad.volume ?? 100) / 100));
    const fadeIn = Math.max(0, +pad.fadeIn || 0);
    const fadeOut = Math.max(0, +pad.fadeOut || 0);
    const loop = !!pad.loop;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    const gain = ctx.createGain();
    src.connect(gain).connect(master);

    const g = gain.gain;
    if (fadeIn > 0) {
      g.setValueAtTime(0, now);
      g.linearRampToValueAtTime(vol, now + fadeIn);
    } else {
      g.setValueAtTime(vol, now);
    }
    // For one-shot sounds, fade out at the natural end too.
    if (!loop && fadeOut > 0 && buf.duration > fadeOut) {
      const fadeStart = Math.max(now + fadeIn, now + buf.duration - fadeOut);
      g.setValueAtTime(vol, fadeStart);
      g.linearRampToValueAtTime(0, now + buf.duration);
    }

    const voice = { src, gain, started: now, duration: buf.duration, loop, stopping: false };
    voices.set(pad.id, voice);
    src.onended = () => {
      if (voices.get(pad.id) === voice) { voices.delete(pad.id); notify(pad.id); }
      src.disconnect(); gain.disconnect();
    };
    src.start(now);
    notify(pad.id);
    return true;
  }

  // Stop one pad. Uses the pad's fade out unless `immediate` is set,
  // or the pad is already fading (a second stop cuts it straight away).
  function stop(id, { immediate = false, fadeOut = 0 } = {}) {
    const voice = voices.get(id);
    if (!voice) return;
    const now = ctx.currentTime;
    if (immediate || voice.stopping || !(fadeOut > 0)) {
      hardStop(voice, now);
      voices.delete(id);
      notify(id);
      return;
    }
    voice.stopping = true;
    const g = voice.gain.gain;
    if (g.cancelAndHoldAtTime) g.cancelAndHoldAtTime(now);
    else { g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); }
    g.linearRampToValueAtTime(0, now + fadeOut);
    try { voice.src.stop(now + fadeOut + 0.02); } catch (_) { /* ignore */ }
    notify(id);
  }

  // Seconds into the sound (wraps for loops), or null if not playing.
  function position(id) {
    const v = voices.get(id);
    if (!v) return null;
    const t = Math.max(0, ctx.currentTime - v.started);
    return v.loop ? t % v.duration : Math.min(t, v.duration);
  }

  // Progress 0..1 through the sound (wraps for loops), or null if not playing.
  function progress(id) {
    const v = voices.get(id);
    if (!v) return null;
    const t = ctx.currentTime - v.started;
    if (v.loop) return (t % v.duration) / v.duration;
    return Math.min(1, t / v.duration);
  }

  // A short silent WAV. Playing it through an <audio> element on older iOS
  // (no navigator.audioSession) moves audio to the "playback" category, so
  // Web Audio is not muted by the ring/silent switch.
  function silentWavUrl() {
    const n = 4410, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const w = (o, str) => [...str].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 44100, true); v.setUint32(28, 88200, true); v.setUint16(32, 2, true);
    v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
    let bin = '';
    new Uint8Array(buf).forEach((b) => { bin += String.fromCharCode(b); });
    return 'data:audio/wav;base64,' + btoa(bin);
  }
  let htmlAudio = null;

  // Call from user gestures (tap, click, key). On iOS only touchend/click
  // count as a gesture for audio, not touchstart/pointerdown, so callers try
  // on several events; it's safe to call repeatedly.
  async function unlock() {
    if (!navigator.audioSession && !htmlAudio) {
      try {
        htmlAudio = new Audio(silentWavUrl());
        htmlAudio.loop = true;
        htmlAudio.setAttribute('playsinline', '');
        const p = htmlAudio.play();
        if (p && p.catch) p.catch(() => { htmlAudio = null; });
      } catch (_) { htmlAudio = null; }
    }
    try {
      const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource();
      s.buffer = silent;
      s.connect(ctx.destination);
      s.start(0);
    } catch (_) { /* ignore */ }
    if (ctx.state !== 'running') {
      try { await ctx.resume(); } catch (_) { /* ignore */ }
    }
    return ctx.state === 'running';
  }

  // iOS can suspend or "interrupt" audio when the app goes to the background.
  function ensureRunning() {
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
  }

  return {
    ctx,
    load,
    unload,
    play,
    stop,
    progress,
    position,
    isRunning: () => ctx.state === 'running',
    unlock,
    ensureRunning,
    has: (id) => buffers.has(id),
    duration: (id) => buffers.get(id)?.duration ?? 0,
    // bytes of decoded audio held in memory
    memoryUsed: () => [...buffers.values()].reduce((n, b) => n + b.length * b.numberOfChannels * 4, 0),
    isPlaying: (id) => voices.has(id),
    isStopping: (id) => !!voices.get(id)?.stopping,
    playingIds: () => [...voices.keys()],
    onChange: (fn) => listeners.add(fn),
  };
})();
