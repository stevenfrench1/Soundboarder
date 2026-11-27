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

  async function load(id, arrayBuffer) {
    const buf = await decode(arrayBuffer);
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

  // Progress 0..1 through the sound (wraps for loops), or null if not playing.
  function progress(id) {
    const v = voices.get(id);
    if (!v) return null;
    const t = ctx.currentTime - v.started;
    if (v.loop) return (t % v.duration) / v.duration;
    return Math.min(1, t / v.duration);
  }

  // Must be called from a user gesture (tap/click/key) to unlock audio on iOS.
  async function unlock() {
    try {
      const silent = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource();
      s.buffer = silent;
      s.connect(ctx.destination);
      s.start(0);
    } catch (_) { /* ignore */ }
    try { await ctx.resume(); } catch (_) { /* ignore */ }
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
    unlock,
    ensureRunning,
    has: (id) => buffers.has(id),
    duration: (id) => buffers.get(id)?.duration ?? 0,
    isPlaying: (id) => voices.has(id),
    isStopping: (id) => !!voices.get(id)?.stopping,
    playingIds: () => [...voices.keys()],
    onChange: (fn) => listeners.add(fn),
  };
})();
