(function () {
  'use strict';

  let ctx = null;
  let masterGain = null;
  let muted = false;

  function ensureCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.18;
    masterGain.connect(ctx.destination);
    return ctx;
  }

  function blip(opts) {
    if (muted) return;
    const c = ensureCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume();

    const {
      freq = 440,
      freq2 = freq,
      dur = 0.08,
      type = 'square',
      vol = 0.5,
      attack = 0.005,
      release = 0.04,
    } = opts || {};

    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, c.currentTime);
    if (freq2 !== freq) {
      osc.frequency.linearRampToValueAtTime(freq2, c.currentTime + dur);
    }
    g.gain.setValueAtTime(0, c.currentTime);
    g.gain.linearRampToValueAtTime(vol, c.currentTime + attack);
    g.gain.linearRampToValueAtTime(0, c.currentTime + dur + release);
    osc.connect(g);
    g.connect(masterGain);
    osc.start(c.currentTime);
    osc.stop(c.currentTime + dur + release + 0.02);
  }

  // canned sound effects
  const sfx = {
    stitch:    () => blip({ freq: 880, freq2: 660, dur: 0.04, type: 'square', vol: 0.35 }),
    perfect:   () => blip({ freq: 1320, freq2: 1760, dur: 0.06, type: 'triangle', vol: 0.5 }),
    miss:      () => blip({ freq: 220, freq2: 110, dur: 0.08, type: 'sawtooth', vol: 0.35 }),
    move:      () => blip({ freq: 520, dur: 0.03, type: 'square', vol: 0.25 }),
    confirm:   () => {
      blip({ freq: 660, dur: 0.05, type: 'square', vol: 0.4 });
      setTimeout(() => blip({ freq: 990, dur: 0.07, type: 'square', vol: 0.4 }), 60);
    },
    cancel:    () => blip({ freq: 330, freq2: 220, dur: 0.1, type: 'square', vol: 0.35 }),
    countdown: () => blip({ freq: 440, dur: 0.08, type: 'square', vol: 0.4 }),
    go:        () => {
      blip({ freq: 660, dur: 0.08, type: 'square', vol: 0.5 });
      setTimeout(() => blip({ freq: 880, dur: 0.12, type: 'square', vol: 0.5 }), 80);
      setTimeout(() => blip({ freq: 1320, dur: 0.18, type: 'square', vol: 0.5 }), 200);
    },
    finish:    () => {
      const notes = [523, 659, 784, 1047];
      notes.forEach((f, i) => setTimeout(() => blip({ freq: f, dur: 0.12, type: 'triangle', vol: 0.5 }), i * 110));
    },
    highscore: () => {
      const notes = [523, 659, 784, 1047, 1319, 1568];
      notes.forEach((f, i) => setTimeout(() => blip({ freq: f, dur: 0.1, type: 'square', vol: 0.5 }), i * 90));
    },
  };

  // Avoid clobbering window.Audio (the browser's HTMLAudioElement constructor).
  window.SFX = {
    sfx,
    setMuted: (v) => { muted = !!v; },
    isMuted: () => muted,
    // call from a user gesture before first sound to satisfy autoplay policies
    unlock: () => { const c = ensureCtx(); if (c && c.state === 'suspended') c.resume(); },
  };
})();
