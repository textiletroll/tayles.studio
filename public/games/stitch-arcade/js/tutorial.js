(function () {
  'use strict';

  // Animated mini-scenes for the HOW TO PLAY screens. Rendered via canvas
  // using the same primitives as the live game so the demos look identical
  // to actual gameplay — no static image assets to manage.

  const W = 480, H = 480, CX = W / 2, CY = H / 2;
  const RADIUS = 130;                  // smaller than gameplay so the bottom caption
                                       // panel doesn't crop the hoop
  const STITCH_INTERVAL = 9;
  const NEEDLE_EYE_OFFSET = 7;

  const PALETTE = {
    bgInside:   '#211931',
    fabric:     '#f4e4d1',
    hoopOuter:  '#7e5731',
    hoopInner:  '#a07748',
    outlineFar: '#9a8c70',
    needle:     '#c8c8d0',
    needleEye:  '#1a1625',
    threadGold: '#d4a24c',
    threadRed:  '#c73e3a',
    threadPink: '#e88ca0',
    sparkle:    '#fff5cc',
  };

  let scenes = null;

  function init() {
    if (scenes) return;
    scenes = {
      heart:  buildScene('heart'),
      star:   buildScene('star'),
      flower: buildScene('flower'),
    };
  }

  function buildScene(id) {
    const def = window.Shapes.SHAPES.find(s => s.id === id);
    const shape = def.build();
    const Lpx = shape.length * RADIUS;
    const N = Math.max(40, Math.round(Lpx / STITCH_INTERVAL));
    const samples = new Array(N);
    for (let i = 0; i < N; i++) {
      const pt = shape.pointAt(i / N);
      samples[i] = { x: pt.x * RADIUS, y: pt.y * RADIUS, angle: pt.tangent };
    }
    return { shape, samples, N };
  }

  // ---- public ----

  function renderStep(ctx, step, t) {
    init();
    ctx.fillStyle = PALETTE.bgInside;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(CX, CY);
    drawHoop(ctx);
    drawFabric(ctx);

    if (step === 0)      drawStep1(ctx, t);
    else if (step === 1) drawStep2(ctx, t);
    else                 drawStep3(ctx, t);

    ctx.restore();
  }

  // ---- step animations ----

  // Step 1: needle traces the heart, stitches accumulate, loops.
  function drawStep1(ctx, t) {
    const sc = scenes.heart;
    drawOutline(ctx, sc);

    const cycle = 6.5;
    const phase = (t % cycle) / cycle;       // 0..1
    const fillT = phase < 0.85 ? phase / 0.85 : 1 - (phase - 0.85) / 0.15; // grow then quick fade
    const visible = Math.max(0, fillT);
    const head = Math.floor(sc.N * visible);

    // Demo trace is on the outline — all gold (perfect). Mixed colors would
    // imply off-path stitches and confuse the player.
    drawStitches(ctx, sc.samples, 0, head, /*goldRate*/ 1);

    if (head > 0 && head < sc.N) {
      const ndl = sc.samples[head % sc.N];
      const last = sc.samples[Math.max(0, head - 1)];
      drawThread(ctx, last, ndl);
      drawNeedle(ctx, ndl.x, ndl.y, ndl.angle, false, t);
    }
  }

  // Step 2: needle stopped at a sharp star corner with the frozen ring.
  // To show "aiming" we slowly oscillate the needle's heading.
  function drawStep2(ctx, t) {
    const sc = scenes.star;
    drawOutline(ctx, sc);

    // Star outer corners sit at s = 0, 0.2, 0.4, 0.6, 0.8. Park the needle
    // at the second outer point (s = 0.2) and pre-stitch the run-up to it.
    const stopIdx = Math.floor(sc.N * 0.2);
    drawStitches(ctx, sc.samples, 0, stopIdx + 1, 1);

    const ndl = sc.samples[stopIdx];
    // Aim toward a point further along the outline (the next inner corner)
    // so the heading reads as "where the player is about to go" rather than
    // pointing off the fabric.
    const ahead = sc.samples[(stopIdx + Math.floor(sc.N * 0.05)) % sc.N];
    const aimBase = Math.atan2(ahead.y - ndl.y, ahead.x - ndl.x);
    const aimAngle = aimBase + Math.sin(t * 1.4) * 0.35;

    drawFrozenRing(ctx, ndl.x, ndl.y, t, aimAngle);
    drawNeedle(ctx, ndl.x, ndl.y, aimAngle, true, t);
  }

  // Step 3: flower fully stitched, S-rank badge floating in the corner.
  function drawStep3(ctx, t) {
    const sc = scenes.flower;
    drawOutline(ctx, sc);
    drawStitches(ctx, sc.samples, 0, sc.N, 1);   // perfect — matches the S rank
    drawRankBadge(ctx, t);
  }

  // ---- primitives (mirror game.js styling) ----

  function drawHoop(ctx) {
    const r = RADIUS + 30;
    ctx.fillStyle = PALETTE.hoopOuter;
    ctx.beginPath(); ctx.arc(0, 0, r + 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = PALETTE.hoopInner;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = PALETTE.hoopOuter;
    ctx.fillRect(-10, -r - 14, 20, 14);
    ctx.fillStyle = PALETTE.hoopInner;
    ctx.fillRect(-7, -r - 11, 14, 8);
  }

  function drawFabric(ctx) {
    const r = RADIUS + 24;
    ctx.fillStyle = PALETTE.fabric;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    const grad = ctx.createRadialGradient(0, 0, r * 0.6, 0, 0, r);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.10)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  }

  function drawOutline(ctx, sc) {
    const pts = sc.shape.points;
    ctx.save();
    ctx.strokeStyle = PALETTE.outlineFar;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const x = p.x * RADIUS, y = p.y * RADIUS;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  }

  function drawStitches(ctx, samples, start, end, goldRate) {
    const len = 7;
    ctx.save();
    ctx.lineCap = 'round';
    for (let i = start; i < end; i++) {
      const st = samples[i];
      const r = ((i * 9301 + 49297) % 233280) / 233280;
      const tier = r < goldRate ? 3 : r < goldRate + 0.2 ? 2 : 1;
      const c = tier === 3 ? PALETTE.threadGold : tier === 2 ? PALETTE.threadRed : PALETTE.threadPink;
      const dx = Math.cos(st.angle) * len * 0.5;
      const dy = Math.sin(st.angle) * len * 0.5;
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(st.x - dx + 1, st.y - dy + 1);
      ctx.lineTo(st.x + dx + 1, st.y + dy + 1);
      ctx.stroke();
      ctx.strokeStyle = c;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(st.x - dx, st.y - dy);
      ctx.lineTo(st.x + dx, st.y + dy);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawNeedle(ctx, x, y, angle, frozen, t) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    const bob = frozen ? 0 : Math.sin(t * 22) * 0.6;
    ctx.translate(0, bob);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath(); ctx.ellipse(2, 2, 11, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = PALETTE.needle;
    ctx.fillRect(-10, -1.5, 20, 3);
    ctx.beginPath(); ctx.moveTo(10, -1.5); ctx.lineTo(14, 0); ctx.lineTo(10, 1.5); ctx.closePath(); ctx.fill();
    ctx.fillStyle = PALETTE.needleEye;
    ctx.beginPath(); ctx.arc(-7, 0, 1.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(-9, -1.5, 18, 0.6);
    ctx.restore();
  }

  function drawFrozenRing(ctx, x, y, t, aimAngle) {
    ctx.save();
    ctx.translate(x, y);
    const r = 11 + Math.sin(t * 7) * 2.5;
    ctx.strokeStyle = PALETTE.threadGold;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 2;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    // forward arrow indicating current heading
    ctx.setLineDash([]);
    ctx.rotate(aimAngle);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(r + 2, 0);
    ctx.lineTo(r + 8, 0);
    ctx.stroke();
    ctx.restore();
  }

  function drawThread(ctx, last, ndl) {
    ctx.save();
    ctx.strokeStyle = PALETTE.threadGold;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([2, 3]);
    const eyex = ndl.x - Math.cos(ndl.angle) * NEEDLE_EYE_OFFSET;
    const eyey = ndl.y - Math.sin(ndl.angle) * NEEDLE_EYE_OFFSET;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(eyex, eyey);
    ctx.stroke();
    ctx.restore();
  }

  function drawRankBadge(ctx, t) {
    // gold S-rank badge floating top-right inside the hoop
    const x = RADIUS - 8, y = -RADIUS + 8;
    const pulse = 1 + Math.sin(t * 3) * 0.05;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(pulse, pulse);
    // badge background
    ctx.fillStyle = '#e7d2b3';
    ctx.fillRect(-26, -26, 52, 52);
    ctx.strokeStyle = '#1a1625';
    ctx.lineWidth = 2.5;
    ctx.strokeRect(-26, -26, 52, 52);
    // letter
    ctx.font = 'bold 34px "Press Start 2P", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#1a1625';
    ctx.fillText('S', 2, 3);
    ctx.fillStyle = PALETTE.threadGold;
    ctx.fillText('S', 0, 0);
    ctx.restore();
  }

  window.Tutorial = {
    renderStep,
    stepCount: 3,
    captions: [
      'Use <span class="key-inline">&larr;</span> <span class="key-inline">&rarr;</span> to steer your needle around the pattern.',
      'Hold <span class="key-inline">&darr;</span> to slow to half speed, or <span class="key-inline">SPACE</span> to stop and pivot — perfect for sharp corners and points.',
      'Trace the pattern accurately to score a high rank.',
    ],
  };
})();
