(function () {
  'use strict';

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const hud = document.getElementById('hud');
  const hudScore = document.getElementById('hud-score');
  const hudProgress = document.getElementById('hud-progress');

  const W = 480, H = 480;

  // ---------- state machine plumbing ----------
  let stateName = 'TITLE';
  let stateData = {};
  let lastTime = 0;

  function setState(name, data) {
    stateData = data || {};
    stateName = name;
    window.Input.clearEdges();
    overlay.innerHTML = '';
    overlay.classList.remove('has-content', 'bottom');
    enterState(name);
  }

  function enterState(name) {
    switch (name) {
      case 'TITLE':        enterTitle(); break;
      case 'SHAPE_SELECT': enterShapeSelect(); break;
      case 'READY':        enterReady(); break;
      case 'PLAYING':      enterPlaying(); break;
      case 'RESULT':       enterResult(); break;
      case 'NAME_ENTRY':   enterNameEntry(); break;
      case 'LEADERBOARD':  enterLeaderboard(); break;
      case 'TUTORIAL':     enterTutorial(); break;
    }
  }

  // ---------- main loop ----------
  function loop(now) {
    const dt = Math.min(0.05, ((now - lastTime) / 1000) || 0);
    lastTime = now;
    tick(dt);
    render();
    requestAnimationFrame(loop);
  }

  function tick(dt) {
    switch (stateName) {
      case 'TITLE':        tickTitle(dt); break;
      case 'SHAPE_SELECT': tickShapeSelect(dt); break;
      case 'READY':        tickReady(dt); break;
      case 'PLAYING':      tickPlaying(dt); break;
      case 'RESULT':       tickResult(dt); break;
      case 'NAME_ENTRY':   tickNameEntry(dt); break;
      case 'LEADERBOARD':  tickLeaderboard(dt); break;
      case 'TUTORIAL':     tickTutorial(dt); break;
    }
  }

  function render() {
    if (stateName === 'TUTORIAL') {
      hud.classList.add('hidden');
      window.Tutorial.renderStep(ctx, stateData.step || 0, stateData.t || 0);
      return;
    }
    if (stateName === 'READY' || stateName === 'PLAYING' || stateName === 'RESULT') {
      window.Game.render(ctx);
      hud.classList.remove('hidden');
      hudScore.textContent = String(window.Game.getDisplayScore()).padStart(5, '0');
      hudProgress.textContent = Math.round(window.Game.getProgressFraction() * 100) + '%';
      // Dim the scene only during the un-armed READY phase, so the player
      // can read the prompt without the pattern competing for attention.
      // Once they hold ↓ ("armed"), reveal the pattern at full clarity.
      if (stateName === 'READY' && !stateData.armed) {
        ctx.fillStyle = 'rgba(26,22,37,0.55)';
        ctx.fillRect(0, 0, W, H);
      }
    } else {
      hud.classList.add('hidden');
      drawIdleBackground(ctx);
    }
  }

  // ---------- idle / title background ----------
  let bgT = 0;
  function drawIdleBackground(ctx) {
    bgT += 1 / 60;
    ctx.fillStyle = '#211931';
    ctx.fillRect(0, 0, W, H);
    // decorative stitched border
    drawStitchBorder(ctx, 16, '#d4a24c', 0);
    drawStitchBorder(ctx, 28, '#c73e3a', Math.PI / 8);
    // ambient drifting "thread" curves
    drawAmbientCurves(ctx, bgT);
  }

  function drawStitchBorder(ctx, inset, color, phase) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.setLineDash([10, 8]);
    ctx.lineDashOffset = -((bgT * 12) + phase * 10);
    ctx.strokeRect(inset, inset, W - inset * 2, H - inset * 2);
    ctx.restore();
  }

  function drawAmbientCurves(ctx, t) {
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#e88ca0';
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const x = (i / 60) * W;
      const y = H * 0.5 + Math.sin(i * 0.25 + t * 0.6) * 22 + Math.sin(i * 0.07 + t) * 10;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = '#5b8f3f';
    ctx.beginPath();
    for (let i = 0; i <= 60; i++) {
      const x = (i / 60) * W;
      const y = H * 0.7 + Math.sin(i * 0.18 - t * 0.5) * 16 + Math.cos(i * 0.05 + t * 0.3) * 8;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  // ---------- TITLE ----------
  function enterTitle() {
    overlay.classList.add('has-content');
    overlay.innerHTML = `
      <div class="panel">
        <h1>STITCH ARCADE</h1>
        <h2>NEEDLE & THREAD</h2>
        <p>Trace each pattern with care.</p>
        <p>The closer to the line, the higher your score.</p>
        <p class="hint">[ENTER] START &nbsp; [T] HOW TO PLAY &nbsp; [Z] LEADERBOARDS</p>
      </div>
    `;
  }
  function tickTitle() {
    if (window.Input.pressed('confirm')) {
      window.SFX.unlock();
      window.SFX.sfx.confirm();
      setState('SHAPE_SELECT', { index: 0 });
    } else if (window.Input.pressed('action')) {
      window.SFX.unlock();
      window.SFX.sfx.confirm();
      setState('LEADERBOARD', { shapeIndex: 0, fromTitle: true });
    } else if (window.Input.pressed('tutorial')) {
      window.SFX.unlock();
      window.SFX.sfx.confirm();
      setState('TUTORIAL', { step: 0, t: 0 });
    } else if (window.Input.pressed('mute')) {
      const next = !window.SFX.isMuted();
      window.SFX.setMuted(next);
    }
  }

  // ---------- SHAPE_SELECT ----------
  function enterShapeSelect() {
    overlay.classList.add('has-content');
    renderShapeSelect();
  }
  function renderShapeSelect() {
    const items = window.Shapes.SHAPES.map((sh, i) => {
      const stars = '*'.repeat(sh.difficulty) + '.'.repeat(3 - sh.difficulty);
      const top = window.Leaderboard.get(sh.id)[0];
      const best = top ? `${top.score}` : '----';
      return `
        <li class="${i === stateData.index ? 'selected' : ''}">
          <span>${sh.name}</span>
          <span class="meta">${stars} &nbsp; BEST ${best}</span>
        </li>`;
    }).join('');
    overlay.innerHTML = `
      <div class="panel">
        <h1>SELECT PATTERN</h1>
        <ul class="menu-list">${items}</ul>
        <p class="hint">[&uarr; &darr;] CHOOSE &nbsp; [ENTER] STITCH! &nbsp; [ESC] BACK</p>
      </div>
    `;
  }
  function tickShapeSelect() {
    const max = window.Shapes.SHAPES.length;
    if (window.Input.pressed('up'))   { stateData.index = (stateData.index - 1 + max) % max; window.SFX.sfx.move(); renderShapeSelect(); }
    if (window.Input.pressed('down')) { stateData.index = (stateData.index + 1) % max;        window.SFX.sfx.move(); renderShapeSelect(); }
    if (window.Input.pressed('confirm') || window.Input.pressed('action')) {
      window.SFX.sfx.confirm();
      const shape = window.Shapes.SHAPES[stateData.index];
      window.Game.start(shape);
      setState('READY', { shape });
    }
    if (window.Input.pressed('cancel')) {
      window.SFX.sfx.cancel();
      setState('TITLE');
    }
  }

  // ---------- READY ----------
  // Two phases, both inside this state:
  //   armed=false → scene dimmed, "HOLD SPACE TO BEGIN" prompt. Player can aim.
  //   armed=true  → scene revealed, "RELEASE TO SEW!" prompt. Holding Space
  //                 keeps the needle frozen even after PLAYING starts (Game.tick
  //                 treats Space as freeze), so transition fires on release.
  function enterReady() {
    stateData.armed = false;
    renderReadyPanel();
  }
  function renderReadyPanel() {
    // Pin to the bottom so the panel never covers the needle's start position
    // (especially on patterns where the start sits in the lower half, e.g. flower).
    overlay.classList.add('has-content', 'bottom');
    if (!stateData.armed) {
      overlay.innerHTML = `
        <div class="panel panel--ready">
          <div class="ready-headline">GET READY</div>
          <div class="ready-prompt">HOLD <span class="key-inline">SPACE</span> TO BEGIN</div>
          <div class="ready-sub">USE <span class="key-inline">&larr;</span> <span class="key-inline">&rarr;</span> TO AIM</div>
        </div>
      `;
    } else {
      overlay.innerHTML = `
        <div class="panel panel--ready panel--armed">
          <div class="ready-headline ready-go">RELEASE TO SEW!</div>
          <div class="ready-sub">USE <span class="key-inline">&larr;</span> <span class="key-inline">&rarr;</span> TO AIM</div>
        </div>
      `;
    }
  }
  function tickReady(dt) {
    aimTick(dt);
    const stopHeld = window.Input.isDown('stop');
    if (!stateData.armed && stopHeld) {
      stateData.armed = true;
      window.SFX.sfx.go();
      renderReadyPanel();
      return;
    }
    if (stateData.armed && !stopHeld) {
      setState('PLAYING', { shape: stateData.shape });
    }
  }

  // Allow the player to swing the needle's heading during READY without
  // advancing the game (no movement, no stitches, no end-check).
  function aimTick(dt) {
    if (!window.Game.aimTick) return;
    window.Game.aimTick(dt);
  }

  // ---------- PLAYING ----------
  function enterPlaying() {
    overlay.innerHTML = '';
    overlay.classList.remove('has-content');
  }
  function tickPlaying(dt) {
    const finished = window.Game.tick(dt);
    if (finished) {
      const result = window.Game.getResult();
      const qualifies = window.Leaderboard.qualifies(result.shapeId, result.score);
      setState('RESULT', { result, qualifies, hold: 0.4 });
    }
    if (window.Input.pressed('cancel')) {
      window.SFX.sfx.cancel();
      setState('SHAPE_SELECT', { index: 0 });
    }
  }

  // ---------- RESULT ----------
  function enterResult() {
    const r = stateData.result;
    overlay.classList.add('has-content', 'bottom');
    const head = stateData.qualifies ? 'NEW HIGH SCORE!' : 'COMPLETE!';
    overlay.innerHTML = `
      <div class="panel panel--result">
        <div class="result-row">
          <div class="rank-cell rank-${r.rank}">
            <div class="rank-letter">${r.rank}</div>
            <div class="rank-pct">${r.accuracy}%</div>
            <div class="rank-acc-label">ACCURACY</div>
          </div>
          <div class="result-info">
            <div class="result-headline">${head}</div>
            <div class="result-stats-row">
              <span><span class="lbl">SCORE</span> ${String(r.score).padStart(5, '0')}</span>
              <span><span class="lbl">PATTERN</span> ${r.shapeName}</span>
            </div>
            <div class="result-stats-row small">
              <span><span class="lbl">PERFECT</span> ${r.perfectCount}</span>
              <span><span class="lbl">GOOD</span> ${r.goodCount}</span>
              <span><span class="lbl">MISS</span> ${r.missCount}</span>
            </div>
          </div>
        </div>
        <div class="result-hint">[ENTER] ${stateData.qualifies ? 'ENTER NAME' : 'CONTINUE'}</div>
      </div>
    `;
    if (stateData.qualifies) window.SFX.sfx.highscore();
  }
  function tickResult(dt) {
    if (stateData.hold > 0) { stateData.hold -= dt; return; }
    if (window.Input.pressed('confirm') || window.Input.pressed('action')) {
      window.SFX.sfx.confirm();
      if (stateData.qualifies) {
        const remembered = window.Leaderboard.getLastName();
        const initial = remembered ? remembered.split('') : ['A','A','A'];
        setState('NAME_ENTRY', { result: stateData.result, name: initial, slot: 0 });
      } else {
        const shapeIndex = window.Shapes.SHAPES.findIndex(s => s.id === stateData.result.shapeId);
        setState('LEADERBOARD', { shapeIndex });
      }
    }
  }

  // ---------- NAME_ENTRY ----------
  function enterNameEntry() {
    overlay.classList.add('has-content');
    renderNameEntry();
  }
  function renderNameEntry() {
    const letters = stateData.name.map((ch, i) =>
      `<span class="${i === stateData.slot ? 'active' : ''}">${ch}</span>`
    ).join('');
    overlay.innerHTML = `
      <div class="panel">
        <h1>HIGH SCORE</h1>
        <p>ENTER YOUR INITIALS</p>
        <div class="name-letters">${letters}</div>
        <p class="hint">[&uarr; &darr;] LETTER &nbsp; [&larr; &rarr;] SLOT &nbsp; [ENTER] OK</p>
      </div>
    `;
  }
  function cycleLetter(ch, dir) {
    const A = 'A'.charCodeAt(0);
    let code = ch.charCodeAt(0) - A;
    code = (code + dir + 26) % 26;
    return String.fromCharCode(A + code);
  }
  function tickNameEntry() {
    let dirty = false;
    if (window.Input.pressed('up'))    { stateData.name[stateData.slot] = cycleLetter(stateData.name[stateData.slot], +1); window.SFX.sfx.move(); dirty = true; }
    if (window.Input.pressed('down'))  { stateData.name[stateData.slot] = cycleLetter(stateData.name[stateData.slot], -1); window.SFX.sfx.move(); dirty = true; }
    if (window.Input.pressed('left'))  { stateData.slot = (stateData.slot - 1 + 3) % 3; window.SFX.sfx.move(); dirty = true; }
    if (window.Input.pressed('right')) { stateData.slot = (stateData.slot + 1) % 3;     window.SFX.sfx.move(); dirty = true; }
    if (window.Input.pressed('confirm') || (window.Input.pressed('action') && stateData.slot === 2)) {
      window.SFX.sfx.confirm();
      const name = stateData.name.join('');
      const r = stateData.result;
      const rank = window.Leaderboard.submit(r.shapeId, name, r.score);
      const shapeIndex = window.Shapes.SHAPES.findIndex(s => s.id === r.shapeId);
      setState('LEADERBOARD', { shapeIndex, justSubmitted: { rank, name, score: r.score } });
      return;
    }
    if (dirty) renderNameEntry();
  }

  // ---------- LEADERBOARD ----------
  function enterLeaderboard() {
    overlay.classList.add('has-content');
    renderLeaderboard();
  }
  function renderLeaderboard() {
    const shape = window.Shapes.SHAPES[stateData.shapeIndex];
    const list = window.Leaderboard.get(shape.id);
    const just = stateData.justSubmitted;
    const rows = [];
    for (let i = 0; i < 10; i++) {
      const e = list[i];
      const isMe = just && i + 1 === just.rank;
      if (e) {
        rows.push(`<tr class="${isMe ? 'you' : ''}"><td>${i + 1}</td><td>${e.name}</td><td>${String(e.score).padStart(5,'0')}</td></tr>`);
      } else {
        rows.push(`<tr><td>${i + 1}</td><td>---</td><td>----</td></tr>`);
      }
    }
    overlay.innerHTML = `
      <div class="panel">
        <h1>${shape.name}</h1>
        <h2>&laquo; LEADERBOARD &raquo;</h2>
        <table class="lb-table"><tbody>${rows.join('')}</tbody></table>
        <p class="hint">[&larr; &rarr;] PATTERN &nbsp; [Z] PLAY &nbsp; [ENTER] TITLE</p>
      </div>
    `;
  }
  function tickLeaderboard() {
    const max = window.Shapes.SHAPES.length;
    if (window.Input.pressed('left'))  { stateData.shapeIndex = (stateData.shapeIndex - 1 + max) % max; stateData.justSubmitted = null; window.SFX.sfx.move(); renderLeaderboard(); }
    if (window.Input.pressed('right')) { stateData.shapeIndex = (stateData.shapeIndex + 1) % max;       stateData.justSubmitted = null; window.SFX.sfx.move(); renderLeaderboard(); }
    if (window.Input.pressed('action')) {
      window.SFX.sfx.confirm();
      const shape = window.Shapes.SHAPES[stateData.shapeIndex];
      window.Game.start(shape);
      setState('READY', { shape });
    }
    if (window.Input.pressed('confirm')) {
      window.SFX.sfx.confirm();
      setState('TITLE');
    }
    if (window.Input.pressed('cancel')) {
      window.SFX.sfx.cancel();
      setState('TITLE');
    }
  }

  // ---------- TUTORIAL ----------
  function enterTutorial() {
    stateData.step = stateData.step || 0;
    stateData.t = 0;
    overlay.classList.add('has-content', 'bottom');
    renderTutorialPanel();
  }
  function renderTutorialPanel() {
    const n = window.Tutorial.stepCount;
    const i = stateData.step;
    const caption = window.Tutorial.captions[i];
    overlay.innerHTML = `
      <div class="panel panel--tutorial">
        <div class="tut-step">STEP ${i + 1} / ${n}</div>
        <p class="tut-caption">${caption}</p>
        <p class="hint">[&larr; &rarr;] STEPS &nbsp; [ENTER/ESC] BACK</p>
      </div>
    `;
  }
  function tickTutorial(dt) {
    stateData.t += dt;
    const n = window.Tutorial.stepCount;
    if (window.Input.pressed('left'))  { stateData.step = (stateData.step - 1 + n) % n; stateData.t = 0; window.SFX.sfx.move(); renderTutorialPanel(); }
    if (window.Input.pressed('right')) { stateData.step = (stateData.step + 1) % n;     stateData.t = 0; window.SFX.sfx.move(); renderTutorialPanel(); }
    if (window.Input.pressed('confirm') || window.Input.pressed('cancel') || window.Input.pressed('action')) {
      window.SFX.sfx.cancel();
      setState('TITLE');
    }
  }

  // ---------- boot ----------
  function boot() {
    setState('TITLE');
    requestAnimationFrame((t) => { lastTime = t; loop(t); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
