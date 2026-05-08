(function () {
  'use strict';

  // ---------- constants ----------
  const W = 480, H = 480;
  const CX = W / 2, CY = H / 2;
  const RADIUS = 160;          // outline drawing radius in px

  // Three-state speed model: stopped (Space held) / slow (↓ held) / default.
  // Stitches are placed every STITCH_INTERVAL of motion, so slow mode doesn't
  // change scoring rate per pixel — it just gives the player more time to aim
  // through tight turns. Score still derives purely from accuracy.
  const SPEED_DEFAULT = 90;     // px/s baseline movement
  const SPEED_SLOW    = 45;     // px/s while ↓ held
  const TURN_RATE     = Math.PI * 1.05;  // rad/s

  const RETURN_RADIUS = 6;      // px — eye must pass this close to the start to finish.
                                // Checked as a swept distance (segment) so high speeds
                                // don't skip past a small threshold between frames.
  const ARC_DONE = 0.85;        // fraction of outline coverage required before finish allowed
  const ARC_OVERRUN = 1.55;     // hard cap as a multiple of outline length (distance)

  const STITCH_INTERVAL = 9;   // px between auto-stitches
  const MISS_DIST = 28;        // pixels of error at which a stitch scores zero
  const PERFECT_DIST = 4;      // pixels under which counts as perfect
  const NEAR_DIST = 18;        // for visual tinting
  const NEEDLE_EYE_OFFSET = 7; // distance from needle center back to the eye/tail
                               // — the point where the thread exits the needle

  // Score weighting. Each covered sample contributes (1 - bestDist/MISS_DIST)
  // × POINTS_PER_PERFECT. Theoretical max ≈ numSamples × 100 ≈ 11k–13k.
  const POINTS_PER_PERFECT = 100;

  // Rank ladder is purely accuracy-based.
  const RANK_ACCURACY_SSS = 99;  // %
  const RANK_ACCURACY_SS  = 97;
  const RANK_ACCURACY_S   = 95;
  const RANK_ACCURACY_A   = 80;
  const RANK_ACCURACY_B   = 65;
  const RANK_ACCURACY_C   = 48;

  const PALETTE = {
    bgInside:    '#211931',
    fabric:      '#f4e4d1',
    fabricEdge:  '#d8c098',
    hoopOuter:   '#7e5731',
    hoopInner:   '#a07748',
    outlineFar:  '#9a8c70',
    outlineNear: '#5b8f3f',
    needle:      '#c8c8d0',
    needleEye:   '#1a1625',
    threadGold:  '#d4a24c',
    threadRed:   '#c73e3a',
    threadPink:  '#e88ca0',
    threadMiss:  '#3a5f8f',
    grid:        'rgba(26,22,37,0.05)',
    sparkle:     '#fff5cc',
  };

  // ---------- state ----------
  let s = null;

  function start(shapeDef) {
    const shape = shapeDef.build();
    s = {
      shapeDef,
      shape,                              // {points, length, distanceTo, pointAt}
      lengthPx: shape.length * RADIUS,    // outline length in pixel space
      needle: { x: 0, y: 0, angle: 0 },
      // input flags read each tick
      frozen: false,        // Space held — full stop, turning still works
      slow: false,          // ↓ held — half speed, turning still works
      distanceTraveled: 0,
      distanceSinceStitch: 0,
      stitches: [],
      // ---- coverage-based scoring state ----
      // The outline is sampled at fixed arclength intervals. For each sample we
      // remember the *closest* stitch ever placed near it. Both progress
      // (DONE %) and final score derive from these — so backtracking can't farm
      // coverage and shortcuts leave gaps.
      numSamples: 0,
      samplePos: null,        // [{x, y}] — sample positions in canvas-relative px
      sampleBestDist: null,   // Float32Array — best stitch distance per sample
      sampleCovered: 0,       // count of samples within MISS_DIST of any stitch
      scoreCache: 0,          // running display score (incremental from samples)
      // ---- per-stitch counters (for the P/G/M readout only) ----
      numStitches: 0,
      perfectCount: 0,
      goodCount: 0,
      missCount: 0,
      lastStitch: null,
      finished: false,
      time: 0,
      // visual: gentle fabric jitter for texture
      sparkles: [],
    };
    const startPt = shape.pointAt(shapeDef.startS || 0);
    s.needle.x = startPt.x * RADIUS;
    s.needle.y = startPt.y * RADIUS;
    s.needle.angle = startPt.tangent;
    s.startPos = { x: s.needle.x, y: s.needle.y };

    // Lay down coverage samples at uniform arclength intervals along the outline.
    const numSamples = Math.max(20, Math.round(s.lengthPx / STITCH_INTERVAL));
    s.numSamples = numSamples;
    s.samplePos = new Array(numSamples);
    s.sampleBestDist = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      const pt = shape.pointAt(i / numSamples);
      s.samplePos[i] = { x: pt.x * RADIUS, y: pt.y * RADIUS };
      s.sampleBestDist[i] = Infinity;
    }
  }

  // ---------- update ----------
  function tick(dt) {
    if (!s || s.finished) return true;
    s.time += dt;

    // Space = full stop, ↓ = half speed. Both let the player turn freely.
    s.frozen = window.Input.isDown('stop');
    s.slow   = !s.frozen && window.Input.isDown('down');

    // capture the eye position BEFORE motion + turn so we can do a swept
    // distance check (a single point check can skip past a small threshold).
    const prevEye = needleEyePos();

    // turning is always at full rate — including while frozen, so the player
    // can pivot through sharp corners without drifting.
    if (window.Input.isDown('left'))  s.needle.angle -= TURN_RATE * dt;
    if (window.Input.isDown('right')) s.needle.angle += TURN_RATE * dt;

    const effSpeed = s.frozen ? 0 : (s.slow ? SPEED_SLOW : SPEED_DEFAULT);
    const stepX = Math.cos(s.needle.angle) * effSpeed * dt;
    const stepY = Math.sin(s.needle.angle) * effSpeed * dt;
    s.needle.x += stepX;
    s.needle.y += stepY;

    // soft wall — bounce off edge of fabric so the player can recover
    const radial = Math.hypot(s.needle.x, s.needle.y);
    const limit = RADIUS + MISS_DIST + 14;
    if (radial > limit) {
      const nx = s.needle.x / radial, ny = s.needle.y / radial;
      s.needle.x = nx * limit;
      s.needle.y = ny * limit;
      // reflect angle inward
      const inwardAngle = Math.atan2(-ny, -nx);
      s.needle.angle = inwardAngle;
    }

    const stepLen = Math.hypot(stepX, stepY);
    s.distanceTraveled += stepLen;
    s.distanceSinceStitch += stepLen;

    // place stitches at fixed-distance intervals
    let safety = 16;
    while (s.distanceSinceStitch >= STITCH_INTERVAL && safety-- > 0) {
      s.distanceSinceStitch -= STITCH_INTERVAL;
      placeStitch();
    }

    // sparkle decay
    for (let i = s.sparkles.length - 1; i >= 0; i--) {
      const sp = s.sparkles[i];
      sp.life -= dt;
      if (sp.life <= 0) s.sparkles.splice(i, 1);
    }

    // round ends when the player has actually COVERED most of the outline
    // (samples-touched, not distance-traveled) AND the needle's eye has
    // looped back near the start. The distance-based overrun cap is kept
    // as a safety net for players who are wandering hopelessly off course.
    const eye = needleEyePos();
    const distFromStart = pointToSegment(s.startPos.x, s.startPos.y, prevEye.x, prevEye.y, eye.x, eye.y);
    const coverage = s.numSamples > 0 ? s.sampleCovered / s.numSamples : 0;
    const coveredEnough = coverage >= ARC_DONE;
    const overrun       = s.distanceTraveled >= s.lengthPx * ARC_OVERRUN;
    if (coveredEnough && distFromStart <= RETURN_RADIUS) {
      finish(true);
    } else if (overrun) {
      finish(false);
    }
    return s.finished;
  }

  function placeStitch() {
    // convert needle from px space → shape space (radius=1)
    const sx = s.needle.x / RADIUS;
    const sy = s.needle.y / RADIUS;
    const info = s.shape.distanceTo(sx, sy);
    const distPx = info.dist * RADIUS;

    s.numStitches += 1;

    // Update per-sample bests. A stitch only contributes to a sample if it
    // beats the previous closest stitch there — so re-stitching the same area
    // (backtracking) doesn't farm score and doesn't advance coverage.
    const nx = s.needle.x, ny = s.needle.y;
    for (let i = 0; i < s.numSamples; i++) {
      const sp = s.samplePos[i];
      const ddx = nx - sp.x, ddy = ny - sp.y;
      const d = Math.hypot(ddx, ddy);
      const oldDist = s.sampleBestDist[i];
      if (d < oldDist) {
        const oldContrib = oldDist <= MISS_DIST
          ? (1 - oldDist / MISS_DIST) * POINTS_PER_PERFECT
          : 0;
        const newContrib = d <= MISS_DIST
          ? (1 - d / MISS_DIST) * POINTS_PER_PERFECT
          : 0;
        s.scoreCache += newContrib - oldContrib;
        if (oldDist > MISS_DIST && d <= MISS_DIST) s.sampleCovered++;
        s.sampleBestDist[i] = d;
      }
    }

    if (distPx <= PERFECT_DIST) s.perfectCount++;
    else if (distPx < MISS_DIST) s.goodCount++;
    else s.missCount++;

    const stitch = {
      x: s.needle.x,
      y: s.needle.y,
      angle: s.needle.angle,
      distPx,
      tier: distPx <= PERFECT_DIST ? 3 : distPx < NEAR_DIST ? 2 : distPx < MISS_DIST ? 1 : 0,
    };
    s.stitches.push(stitch);
    s.lastStitch = stitch;

    if (stitch.tier === 3) {
      window.SFX.sfx.perfect();
      // spawn a small sparkle
      s.sparkles.push({ x: stitch.x, y: stitch.y, life: 0.45, maxLife: 0.45 });
    } else if (stitch.tier === 0) {
      window.SFX.sfx.miss();
    } else {
      window.SFX.sfx.stitch();
    }
  }

  // Pre-game aim adjustment. Lets the player swing the needle's heading
  // during READY/COUNTDOWN without moving, stitching, or progressing time.
  function aimTick(dt) {
    if (!s || s.finished) return;
    if (window.Input.isDown('left'))  s.needle.angle -= TURN_RATE * dt;
    if (window.Input.isDown('right')) s.needle.angle += TURN_RATE * dt;
  }

  // Position of the needle's eye (back/tail) in canvas-relative space.
  function needleEyePos() {
    return {
      x: s.needle.x - Math.cos(s.needle.angle) * NEEDLE_EYE_OFFSET,
      y: s.needle.y - Math.sin(s.needle.angle) * NEEDLE_EYE_OFFSET,
    };
  }

  // Distance from a point to a line segment, clamped to the segment's endpoints.
  function pointToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const cx = ax + dx * t, cy = ay + dy * t;
    return Math.hypot(px - cx, py - cy);
  }

  function finish(closed) {
    s.finished = true;
    s.frozen = false;
    if (closed) {
      // Drop a single closing stitch at the exact start point so the loop
      // visually wraps without producing a synthetic-looking bridging line.
      const closing = {
        x: s.startPos.x,
        y: s.startPos.y,
        angle: s.needle.angle,
        distPx: 0,
        tier: 3,
        closing: true,
      };
      s.stitches.push(closing);
      s.lastStitch = closing;
    }
    window.SFX.sfx.finish();
  }

  function getProgressFraction() {
    if (!s || s.numSamples === 0) return 0;
    return s.sampleCovered / s.numSamples;
  }

  function getDisplayScore() {
    if (!s) return 0;
    // Apply the path-efficiency penalty live so the HUD reflects the cost of
    // wandering instead of dropping the score by a surprise amount on RESULT.
    const eff = Math.min(1, (s.lengthPx * 1.05) / Math.max(1, s.distanceTraveled));
    return Math.round(s.scoreCache * eff);
  }

  // Rank is purely a function of accuracy.
  function rankFor(accuracyPct) {
    if (accuracyPct >= RANK_ACCURACY_SSS) return 'SSS';
    if (accuracyPct >= RANK_ACCURACY_SS)  return 'SS';
    if (accuracyPct >= RANK_ACCURACY_S)   return 'S';
    if (accuracyPct >= RANK_ACCURACY_A)   return 'A';
    if (accuracyPct >= RANK_ACCURACY_B)   return 'B';
    if (accuracyPct >= RANK_ACCURACY_C)   return 'C';
    return 'D';
  }

  function getResult() {
    if (!s) return null;
    // Accuracy is averaged across ALL outline samples (uncovered samples
    // contribute 0), so partial coverage and skipped sections naturally
    // drag the rank down.
    let qualitySum = 0;
    for (let i = 0; i < s.numSamples; i++) {
      const d = s.sampleBestDist[i];
      if (d <= MISS_DIST) {
        qualitySum += 1 - d / MISS_DIST;
      }
    }
    const N = Math.max(1, s.numSamples);
    const sampleAccuracy = qualitySum / N;
    // Path-efficiency penalty: detours don't farm coverage (sample-bests
    // already prevent that), but they *should* still cost rank — a player
    // who walks twice the outline length to finish hasn't done the same
    // job as a player who traced it cleanly. 1.05× grace absorbs minor
    // wobble so a near-perfect run isn't punished for normal play.
    const efficiency = Math.min(1, (s.lengthPx * 1.05) / Math.max(1, s.distanceTraveled));
    const accuracy = sampleAccuracy * efficiency;
    const coverage = s.sampleCovered / N;       // fraction of outline reached
    const accuracyPct = Math.round(accuracy * 100);
    const score = Math.round(accuracy * N * POINTS_PER_PERFECT);
    return {
      score,
      accuracy: accuracyPct,
      coverage: Math.round(coverage * 100),
      rank: rankFor(accuracyPct),
      perfectCount: s.perfectCount,
      goodCount: s.goodCount,
      missCount: s.missCount,
      totalStitches: s.numStitches,
      shapeId: s.shapeDef.id,
      shapeName: s.shapeDef.name,
    };
  }

  // ---------- render ----------
  function render(ctx) {
    if (!s) return;

    // outer dark
    ctx.fillStyle = PALETTE.bgInside;
    ctx.fillRect(0, 0, W, H);

    ctx.save();
    ctx.translate(CX, CY);

    drawHoop(ctx);
    drawFabric(ctx);
    drawFabricGrid(ctx);
    drawOutline(ctx);
    drawStartMarker(ctx);
    drawStitches(ctx);
    drawThread(ctx);
    drawNeedle(ctx);
    drawSparkles(ctx);

    ctx.restore();
  }

  function drawHoop(ctx) {
    const r = RADIUS + 30;
    ctx.fillStyle = PALETTE.hoopOuter;
    ctx.beginPath(); ctx.arc(0, 0, r + 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = PALETTE.hoopInner;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    // tightening screw at top
    ctx.fillStyle = PALETTE.hoopOuter;
    ctx.fillRect(-10, -r - 14, 20, 14);
    ctx.fillStyle = PALETTE.hoopInner;
    ctx.fillRect(-7, -r - 11, 14, 8);
  }

  function drawFabric(ctx) {
    const r = RADIUS + 24;
    ctx.fillStyle = PALETTE.fabric;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
    // edge shading
    const grad = ctx.createRadialGradient(0, 0, r * 0.6, 0, 0, r);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.10)');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill();
  }

  function drawFabricGrid(ctx) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, RADIUS + 20, 0, Math.PI * 2);
    ctx.clip();
    ctx.strokeStyle = PALETTE.grid;
    ctx.lineWidth = 1;
    const step = 8;
    for (let x = -RADIUS - 24; x <= RADIUS + 24; x += step) {
      ctx.beginPath(); ctx.moveTo(x, -RADIUS - 24); ctx.lineTo(x, RADIUS + 24); ctx.stroke();
    }
    for (let y = -RADIUS - 24; y <= RADIUS + 24; y += step) {
      ctx.beginPath(); ctx.moveTo(-RADIUS - 24, y); ctx.lineTo(RADIUS + 24, y); ctx.stroke();
    }
    ctx.restore();
  }

  function drawStartMarker(ctx) {
    if (!s.startPos || s.finished) return;
    const coverage = getProgressFraction();
    const ready = coverage >= ARC_DONE;
    ctx.save();

    // Once the player has traveled enough to qualify, pulse a wider aura so
    // they can see the precise target dot from a distance even though the
    // actual trigger threshold is only a few pixels.
    if (ready) {
      const t = (Math.sin(s.time * 5) + 1) / 2;
      const auraR = 10 + t * 10;
      ctx.globalAlpha = 0.55 * (1 - t * 0.55);
      ctx.strokeStyle = PALETTE.threadGold;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(s.startPos.x, s.startPos.y, auraR, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Precise target — a small bright gold dot the player must thread
    // the eye of the needle through to close the loop.
    ctx.globalAlpha = ready ? 1 : 0.7;
    ctx.fillStyle = PALETTE.threadGold;
    ctx.beginPath();
    ctx.arc(s.startPos.x, s.startPos.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = PALETTE.needleEye;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.arc(s.startPos.x, s.startPos.y, 3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawOutline(ctx) {
    const pts = s.shape.points;
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

  function drawStitches(ctx) {
    const len = 7; // visual length of each stitch dash
    ctx.save();
    for (const st of s.stitches) {
      const c = stitchColor(st.tier);
      const dx = Math.cos(st.angle) * len * 0.5;
      const dy = Math.sin(st.angle) * len * 0.5;
      // shadow
      ctx.strokeStyle = 'rgba(0,0,0,0.15)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(st.x - dx + 1, st.y - dy + 1);
      ctx.lineTo(st.x + dx + 1, st.y + dy + 1);
      ctx.stroke();
      // thread
      ctx.strokeStyle = c;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(st.x - dx, st.y - dy);
      ctx.lineTo(st.x + dx, st.y + dy);
      ctx.stroke();
    }
    ctx.restore();
  }

  function stitchColor(tier) {
    switch (tier) {
      case 3: return PALETTE.threadGold;
      case 2: return PALETTE.threadRed;
      case 1: return PALETTE.threadPink;
      default: return PALETTE.threadMiss;
    }
  }

  function drawThread(ctx) {
    if (!s.lastStitch || s.finished) return;
    const eye = needleEyePos();
    ctx.save();
    ctx.strokeStyle = stitchColor(s.lastStitch.tier);
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(s.lastStitch.x, s.lastStitch.y);
    ctx.lineTo(eye.x, eye.y);
    ctx.stroke();
    ctx.restore();
  }

  function drawNeedle(ctx) {
    // pulsing ring while ↓ holds the needle still
    if (s.frozen) {
      ctx.save();
      ctx.translate(s.needle.x, s.needle.y);
      const r = 11 + Math.sin(s.time * 7) * 2.5;
      ctx.strokeStyle = PALETTE.threadGold;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.stroke();
      // small forward arrow indicating the heading you'll resume in
      ctx.setLineDash([]);
      ctx.rotate(s.needle.angle);
      ctx.strokeStyle = PALETTE.threadGold;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(r + 2, 0);
      ctx.lineTo(r + 8, 0);
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    ctx.translate(s.needle.x, s.needle.y);
    ctx.rotate(s.needle.angle);
    // bob freezes when stopped
    const bob = s.frozen ? 0 : Math.sin(s.time * 22) * 0.6;
    ctx.translate(0, bob);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.ellipse(2, 2, 11, 3, 0, 0, Math.PI * 2);
    ctx.fill();

    // needle body — silver shaft pointing forward (+x)
    ctx.fillStyle = PALETTE.needle;
    ctx.fillRect(-10, -1.5, 20, 3);
    // tip
    ctx.beginPath();
    ctx.moveTo(10, -1.5);
    ctx.lineTo(14, 0);
    ctx.lineTo(10, 1.5);
    ctx.closePath();
    ctx.fill();
    // eye (hole at the back)
    ctx.fillStyle = PALETTE.needleEye;
    ctx.beginPath();
    ctx.arc(-7, 0, 1.4, 0, Math.PI * 2);
    ctx.fill();
    // highlight
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fillRect(-9, -1.5, 18, 0.6);

    ctx.restore();
  }

  function drawSparkles(ctx) {
    ctx.save();
    for (const sp of s.sparkles) {
      const a = sp.life / sp.maxLife;
      const r = (1 - a) * 8 + 2;
      ctx.globalAlpha = a;
      ctx.fillStyle = PALETTE.sparkle;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = PALETTE.threadGold;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(sp.x - r - 2, sp.y); ctx.lineTo(sp.x + r + 2, sp.y);
      ctx.moveTo(sp.x, sp.y - r - 2); ctx.lineTo(sp.x, sp.y + r + 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  // ---------- public API ----------
  window.Game = {
    start,
    tick,
    aimTick,
    render,
    isFinished: () => !!(s && s.finished),
    getProgressFraction,
    getDisplayScore,
    getResult,
    constants: { W, H, CX, CY, RADIUS, MISS_DIST, PERFECT_DIST, NEAR_DIST },
  };
})();
