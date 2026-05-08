(function () {
  'use strict';

  // Logical names → physical key codes
  const KEY_MAP = {
    up:      ['ArrowUp', 'KeyW'],
    down:    ['ArrowDown', 'KeyS'],
    left:    ['ArrowLeft', 'KeyA'],
    right:   ['ArrowRight', 'KeyD'],
    action:  ['KeyZ', 'Space'],
    stop:    ['Space'],
    confirm: ['Enter', 'NumpadEnter'],
    cancel:  ['Escape', 'Backspace'],
    mute:    ['KeyM'],
    tutorial:['KeyT'],
  };

  const held = Object.create(null);  // currently down
  const edge = Object.create(null);  // pressed this frame, consumed by callers

  // Map physical code → array of logical names
  const codeToLogical = (() => {
    const m = Object.create(null);
    for (const name of Object.keys(KEY_MAP)) {
      for (const code of KEY_MAP[name]) {
        if (!m[code]) m[code] = [];
        m[code].push(name);
      }
    }
    return m;
  })();

  function shouldPreventDefault(code) {
    // Prevent page from scrolling on arrows / space, etc.
    return code in codeToLogical;
  }

  window.addEventListener('keydown', (e) => {
    const names = codeToLogical[e.code];
    if (!names) return;
    if (shouldPreventDefault(e.code)) e.preventDefault();
    for (const n of names) {
      if (!held[n]) edge[n] = true;
      held[n] = true;
    }
  });

  window.addEventListener('keyup', (e) => {
    const names = codeToLogical[e.code];
    if (!names) return;
    for (const n of names) held[n] = false;
  });

  window.addEventListener('blur', () => {
    for (const k of Object.keys(held)) held[k] = false;
  });

  const Input = {
    isDown(name)  { return !!held[name]; },
    // edge-triggered: returns true once per press, then consumes
    pressed(name) {
      if (edge[name]) { edge[name] = false; return true; }
      return false;
    },
    // peek without consuming
    isPressed(name) { return !!edge[name]; },
    // clear all edge events (call between state transitions to avoid carryover)
    clearEdges() { for (const k of Object.keys(edge)) edge[k] = false; },
    // clear all held flags
    clearAll() {
      for (const k of Object.keys(held)) held[k] = false;
      for (const k of Object.keys(edge)) edge[k] = false;
    },
  };

  window.Input = Input;
})();
