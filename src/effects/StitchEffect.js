/**
 * Stitch Effect — ES module version
 *
 * Renders animated stitching on a canvas overlay.
 * Call `createStitchEffect(container, options)` to start; returns a control
 * object with setters and `destroy()`.
 *
 * Performance strategy:
 * - Completed stitches are stamped onto a persistent "done" canvas so they
 *   don't need to be redrawn every frame.
 * - Only in-progress paths are rendered live each frame.
 * - When all paths finish, they fade out over ~1s before new paths begin.
 */

import { drawStitchOnPath, drawSatinCornerFan } from './stitchRenderers.js';

export const STITCH_PALETTES = {
  warm:   ['#c0392b', '#e74c3c', '#d4a574', '#8b5e3c', '#c2956b', '#a0522d'],
  cool:   ['#2980b9', '#3498db', '#1abc9c', '#16a085', '#5dade2', '#48c9b0'],
  pastel: ['#f5b7b1', '#d2b4de', '#aed6f1', '#a3e4d7', '#f9e79f', '#fadbd8'],
  mono:   ['#cccccc', '#999999', '#bbbbbb', '#aaaaaa', '#dddddd', '#888888'],
};

// Keep local alias for internal use
const palettes = STITCH_PALETTES;

export function createStitchEffect(container, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.classList.add('pg-bg-stitch');
  container.appendChild(canvas);

  const ctx = canvas.getContext('2d');

  // Off-screen canvas for completed stitches
  const doneCanvas = document.createElement('canvas');
  const doneCtx = doneCanvas.getContext('2d');

  const config = {
    speed:     options.speed ?? 120,
    stitchLen: options.stitchLen ?? 10,
    palette:   options.palette ?? 'warm',
    style:     options.style ?? 'running',
    curliness: options.curliness ?? 3,
    customColors: options.customColors || null,
  };

  let destroyed = false;
  let rafId = null;
  let paths = [];

  // Fade-out state: when all stitches complete, fade them out before rebuilding
  let fadeAlpha = 1;
  let fading = false;

  // Track logical (CSS) dimensions for drawing math
  let logicalW = 0;
  let logicalH = 0;

  /* ── sizing — scale buffer by devicePixelRatio for crisp lines on HiDPI ── */
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    logicalW = canvas.offsetWidth;
    logicalH = canvas.offsetHeight;
    canvas.width  = logicalW * dpr;
    canvas.height = logicalH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    doneCanvas.width  = canvas.width;
    doneCanvas.height = canvas.height;
    doneCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  const onResize = () => {
    const prevW = logicalW, prevH = logicalH;
    resize();
    if (logicalW !== prevW || logicalH !== prevH) { buildFabric(); fullReset(); }
  };
  window.addEventListener('resize', onResize);
  // Also observe container resizes (e.g. dynamic parallax height changes)
  const containerRO = new ResizeObserver(onResize);
  containerRO.observe(container);

  /* ── colours ── */
  function pickColor() {
    const pool = config.palette === 'custom' && config.customColors
      ? config.customColors
      : palettes[config.palette] || palettes.warm;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /* ── style ── */
  function pickStyle() {
    const styles = ['running', 'backstitch', 'zigzag', 'chain', 'satin'];
    if (config.style !== 'mixed') return config.style;
    return styles[Math.floor(Math.random() * styles.length)];
  }

  /* ── unified stitch renderer (uses shared module for all 15 styles) ── */
  function drawStitch(target, path, from, to) {
    drawStitchOnPath(target, {
      points: path.points,
      from, to,
      style: path.style,
      stitchLen: config.stitchLen,
      width: path.width,
      color: path.color,
    });
  }

  /* ── path generation ── */
  function buildPaths() {
    paths = [];
    const w = logicalW;
    const h = logicalH;
    const lineSpacing = 50 + Math.random() * 30;
    const rows = Math.ceil(h / lineSpacing) + 2;

    for (let r = 0; r < rows; r++) {
      const y = lineSpacing * r + (Math.random() - 0.5) * 10;
      const pts = [];

      const curl = config.curliness;
      const waveAmp  = curl * 1.5 + Math.random() * curl;
      const waveFreq = 0.002 + curl * 0.002 + Math.random() * 0.003;
      const wavePhase = Math.random() * Math.PI * 2;
      const wave2Amp  = curl * 0.6 * Math.random();
      const wave2Freq = waveFreq * (2 + Math.random());
      const step = 20;

      for (let x = -20; x <= w + 20; x += step) {
        const yOff =
          Math.sin(x * waveFreq + wavePhase) * waveAmp +
          Math.sin(x * wave2Freq + wavePhase * 1.7) * wave2Amp;
        pts.push({ x, y: y + yOff });
      }

      let totalLen = 0;
      for (let i = 1; i < pts.length; i++) {
        const dx = pts[i].x - pts[i - 1].x;
        const dy = pts[i].y - pts[i - 1].y;
        totalLen += Math.sqrt(dx * dx + dy * dy);
      }

      paths.push({
        points: pts,
        totalLen,
        progress: 0,
        prevProgress: 0,   // track last stamped progress
        color: pickColor(),
        style: pickStyle(),
        delay: r * 0.6 + Math.random() * 1.5,
        delayRemaining: r * 0.6 + Math.random() * 1.5,
        done: false,
        width: 1.5 + Math.random() * 1.0,
      });
    }
  }

  function fullReset() {
    doneCtx.clearRect(0, 0, logicalW, logicalH);
    fadeAlpha = 1;
    fading = false;
    buildPaths();
  }

  /* ── needle indicator ── */
  function drawNeedle(path) {
    if (path.progress >= path.totalLen) return;
    const pts = path.points;
    let traveled = 0;
    let pt = { x: pts[0].x, y: pts[0].y, angle: 0 };
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (traveled + segLen >= path.progress) {
        const t = (path.progress - traveled) / Math.max(segLen, 1e-9);
        pt = { x: pts[i - 1].x + dx * t, y: pts[i - 1].y + dy * t, angle: Math.atan2(dy, dx) };
        break;
      }
      traveled += segLen;
    }
    ctx.save();
    ctx.translate(pt.x, pt.y);
    ctx.rotate(pt.angle + Math.PI / 2);
    ctx.fillStyle = '#c0c0c0';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(-1.5, 3);
    ctx.lineTo(1.5, 3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ── fabric texture ──
   * Rendered once to a small offscreen canvas, then attached to the visible
   * canvas as a tiled CSS background-image. The browser composites the tile
   * statically as a single GPU layer, so the per-frame `fillRect` over the
   * entire canvas (formerly the dominant pixel-fill cost) is eliminated.
   * Stitches are drawn on a transparent canvas above this background. */
  const fabricCanvas = document.createElement('canvas');
  const fabricCtx = fabricCanvas.getContext('2d');

  function buildFabric() {
    const size = 60;
    fabricCanvas.width = size;
    fabricCanvas.height = size;
    fabricCtx.clearRect(0, 0, size, size);
    fabricCtx.strokeStyle = 'rgba(255,255,255,0.04)';
    fabricCtx.lineWidth = 0.5;
    const weave = 3;
    for (let x = 0; x < size; x += weave) {
      fabricCtx.beginPath();
      fabricCtx.moveTo(x, 0);
      fabricCtx.lineTo(x, size);
      fabricCtx.stroke();
    }
    for (let y = 0; y < size; y += weave) {
      fabricCtx.beginPath();
      fabricCtx.moveTo(0, y);
      fabricCtx.lineTo(size, y);
      fabricCtx.stroke();
    }
    canvas.style.backgroundImage = `url(${fabricCanvas.toDataURL('image/png')})`;
    canvas.style.backgroundRepeat = 'repeat';
  }
  buildFabric();

  /* ── main loop ── */
  let lastFrame = performance.now();
  buildPaths();

  function animate() {
    if (destroyed) return;
    const now = performance.now();
    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (dt > 0.1) dt = 0.016;

    // Phase 1: advance progress and stamp NEW segments to doneCanvas only.
    // The previous design redrew each path's full [0, progress] range to the
    // live canvas every frame — quadratic over the path's lifetime. Now each
    // segment hits the canvas exactly once. Renderers that previously didn't
    // honor `from > 0` (zigzag, chain, stem) were updated to do so.
    let allDone = true;
    if (!fading) {
      for (const path of paths) {
        if (path.done) continue;

        if (path.delayRemaining > 0) {
          path.delayRemaining -= dt;
          allDone = false;
          continue;
        }

        if (path.progress < path.totalLen) {
          path.progress += config.speed * dt;
          if (path.progress > path.totalLen) path.progress = path.totalLen;
          allDone = false;
        }

        if (path.progress > path.prevProgress) {
          drawStitch(doneCtx, path, path.prevProgress, path.progress);
          path.prevProgress = path.progress;
        }

        if (path.progress >= path.totalLen) {
          path.done = true;
        }
      }
    }

    // Phase 2: composite the live canvas — fabric is the CSS background, the
    // doneCanvas is everything that's been stitched, and active needles paint
    // on top.
    ctx.clearRect(0, 0, logicalW, logicalH);

    if (fading) {
      fadeAlpha -= dt * 0.8;  // ~1.25s fade
      if (fadeAlpha <= 0) {
        fadeAlpha = 1;
        fading = false;
        doneCtx.clearRect(0, 0, logicalW, logicalH);
        buildPaths();
      } else {
        ctx.globalAlpha = fadeAlpha;
        ctx.drawImage(doneCanvas, 0, 0, logicalW, logicalH);
        ctx.globalAlpha = 1;
      }
      rafId = requestAnimationFrame(animate);
      return;
    }

    ctx.drawImage(doneCanvas, 0, 0);

    // Needles for in-progress paths only.
    for (const path of paths) {
      if (path.done) continue;
      if (path.delayRemaining > 0) continue;
      if (path.progress > 0 && path.progress < path.totalLen) drawNeedle(path);
    }

    if (allDone) fading = true;

    rafId = requestAnimationFrame(animate);
  }
  rafId = requestAnimationFrame(animate);

  /* ── public API ── */
  return {
    setSpeed(v)     { config.speed = v; },
    setStitchLen(v) { config.stitchLen = v; },
    setCurliness(v) { config.curliness = v; fullReset(); },
    setPalette(v)   { config.palette = v; },
    setCustomColors(v) { config.customColors = v; },
    setStyle(v) {
      config.style = v;
      for (const p of paths) p.style = pickStyle();
    },
    reset() { fullReset(); },
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      containerRO.disconnect();
      canvas.remove();
    },
  };
}


/**
 * Wander Stitch Effect — lightweight single-thread variant
 *
 * One stitch line that meanders endlessly across the canvas on a smooth
 * random curve. Old trail fades out gradually. Very cheap: just one path
 * tip advancing + a static trail canvas with gentle fade.
 */
export function createWanderStitchEffect(container, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.classList.add('pg-bg-stitch');
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // Trail canvas — completed stitches accumulate here and fade slowly
  const trailCanvas = document.createElement('canvas');
  const trailCtx = trailCanvas.getContext('2d');

  const config = {
    speed:     options.speed ?? 100,
    stitchLen: options.stitchLen ?? 10,
    palette:   options.palette ?? 'warm',
    style:     options.style ?? 'running',
    curliness: options.curliness ?? 5,
    customColors: options.customColors || null,
  };

  let destroyed = false;
  let rafId = null;

  // Current wander state
  let x, y, angle, color, stitchStyle;
  let dist = 0;        // distance along current stitch on/off cycle
  let stitchOn = true;  // running stitch: on = draw, off = gap
  let zigSide = 1;      // zigzag side toggle
  let fadeTimer = 0;    // accumulates time for periodic trail fade
  let chainAnchor = null;  // start of the current chain link
  let chainAccum = 0;      // distance traveled since last link drawn

  // Track logical (CSS) dimensions for drawing math
  let logicalW = 0;
  let logicalH = 0;

  /* ── sizing — scale buffer by devicePixelRatio for crisp lines on HiDPI ── */
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    logicalW = canvas.offsetWidth;
    logicalH = canvas.offsetHeight;
    canvas.width  = logicalW * dpr;
    canvas.height = logicalH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    trailCanvas.width  = canvas.width;
    trailCanvas.height = canvas.height;
    trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  const onResize = () => {
    const prevW = logicalW, prevH = logicalH;
    resize();
    if (logicalW !== prevW || logicalH !== prevH) { buildFabric(); initWander(); }
  };
  window.addEventListener('resize', onResize);
  const containerRO = new ResizeObserver(onResize);
  containerRO.observe(container);

  /* ── colours ── */
  function pickColor() {
    const pool = config.palette === 'custom' && config.customColors
      ? config.customColors
      : palettes[config.palette] || palettes.warm;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function pickWanderStyle() {
    const styles = ['running', 'backstitch', 'zigzag', 'chain', 'satin'];
    if (config.style !== 'mixed') return config.style;
    return styles[Math.floor(Math.random() * styles.length)];
  }

  /* ── init wander position ── */
  function initWander() {
    x = Math.random() * logicalW;
    y = Math.random() * logicalH;
    angle = Math.random() * Math.PI * 2;
    color = pickColor();
    stitchStyle = pickWanderStyle();
    dist = 0;
    stitchOn = true;
    zigSide = 1;
    chainAnchor = null;
    chainAccum = 0;
    trailCtx.clearRect(0, 0, logicalW, logicalH);
  }
  initWander();

  /* ── fabric texture ── attached as CSS bg, see standard effect for details. */
  const fabricCanvas = document.createElement('canvas');
  const fabricCtx = fabricCanvas.getContext('2d');

  function buildFabric() {
    const size = 60;
    fabricCanvas.width = size;
    fabricCanvas.height = size;
    fabricCtx.clearRect(0, 0, size, size);
    fabricCtx.strokeStyle = 'rgba(255,255,255,0.04)';
    fabricCtx.lineWidth = 0.5;
    const weave = 3;
    for (let xi = 0; xi < size; xi += weave) {
      fabricCtx.beginPath();
      fabricCtx.moveTo(xi, 0);
      fabricCtx.lineTo(xi, size);
      fabricCtx.stroke();
    }
    for (let yi = 0; yi < size; yi += weave) {
      fabricCtx.beginPath();
      fabricCtx.moveTo(0, yi);
      fabricCtx.lineTo(size, yi);
      fabricCtx.stroke();
    }
    canvas.style.backgroundImage = `url(${fabricCanvas.toDataURL('image/png')})`;
    canvas.style.backgroundRepeat = 'repeat';
  }
  buildFabric();

  /* ── steer the wandering needle ── */
  function steer(dt) {
    const curl = config.curliness;
    // Gentle random walk on angle
    angle += (Math.random() - 0.5) * curl * 0.15 * dt * 10;

    // Soft boundary avoidance — steer back toward center when near edges
    const margin = 80;
    const cx = logicalW / 2;
    const cy = logicalH / 2;
    const dx = x - cx;
    const dy = y - cy;
    const hw = logicalW / 2 - margin;
    const hh = logicalH / 2 - margin;

    if (Math.abs(dx) > hw) {
      angle += (dx > 0 ? -1 : 1) * 0.03;
    }
    if (Math.abs(dy) > hh) {
      angle += (dy > 0 ? -1 : 1) * 0.03;
    }
  }

  /* ── draw one stitch step onto trail canvas ── */
  function drawStitchStep(stepLen) {
    const sl = config.stitchLen;
    const nx = x + Math.cos(angle) * stepLen;
    const ny = y + Math.sin(angle) * stepLen;

    trailCtx.save();
    trailCtx.strokeStyle = color;
    trailCtx.lineWidth = 1.8;
    trailCtx.lineCap = 'round';
    // Shadows removed — see stitchRenderers.applyShadow comment. shadowBlur on
    // every stroke was the dominant cost across all stitch effects.

    if (stitchStyle === 'running') {
      if (stitchOn) {
        trailCtx.beginPath();
        trailCtx.moveTo(x, y);
        trailCtx.lineTo(nx, ny);
        trailCtx.stroke();
      }
      dist += stepLen;
      if (dist >= (stitchOn ? sl : sl * 0.7)) {
        dist = 0;
        stitchOn = !stitchOn;
      }
    } else if (stitchStyle === 'zigzag') {
      const perp = angle + Math.PI / 2;
      const amp = sl * 0.5;
      const ox = Math.cos(perp) * amp * zigSide;
      const oy = Math.sin(perp) * amp * zigSide;
      trailCtx.beginPath();
      trailCtx.moveTo(x, y);
      trailCtx.lineTo(nx + ox, ny + oy);
      trailCtx.stroke();
      dist += stepLen;
      if (dist >= sl) {
        dist = 0;
        zigSide *= -1;
      }
      // Override target position to follow the zigzag
      x = nx + ox;
      y = ny + oy;
      trailCtx.restore();
      return;
    } else if (stitchStyle === 'chain') {
      // Accumulate steps until a full link length is traveled, then stamp a
      // teardrop loop from anchor → current pos. Between links nothing draws —
      // matches how a chain link is sewn in one motion.
      if (!chainAnchor) chainAnchor = { x, y };
      chainAccum += stepLen;
      const linkLen = sl * 1.4;
      if (chainAccum >= linkLen) {
        const halfWidth = sl * 0.4;
        const dxLink = nx - chainAnchor.x;
        const dyLink = ny - chainAnchor.y;
        const linkAngle = Math.atan2(dyLink, dxLink);
        const midX = (chainAnchor.x + nx) / 2;
        const midY = (chainAnchor.y + ny) / 2;
        const perpL = linkAngle + Math.PI / 2;
        trailCtx.lineJoin = 'round';
        trailCtx.beginPath();
        trailCtx.moveTo(chainAnchor.x, chainAnchor.y);
        trailCtx.quadraticCurveTo(
          midX + Math.cos(perpL) * halfWidth,
          midY + Math.sin(perpL) * halfWidth,
          nx, ny
        );
        trailCtx.quadraticCurveTo(
          midX - Math.cos(perpL) * halfWidth,
          midY - Math.sin(perpL) * halfWidth,
          chainAnchor.x, chainAnchor.y
        );
        trailCtx.stroke();
        chainAnchor = { x: nx, y: ny };
        chainAccum = 0;
      }
    } else if (stitchStyle === 'satin') {
      // Dense perpendicular crossing at the current point — successive frames
      // overlap and build a smooth filled satin band along the path.
      const perp = angle + Math.PI / 2;
      const amp = sl * 0.7;
      const ox = Math.cos(perp) * amp;
      const oy = Math.sin(perp) * amp;
      trailCtx.lineWidth = 1.4;
      trailCtx.beginPath();
      trailCtx.moveTo(x - ox, y - oy);
      trailCtx.lineTo(x + ox, y + oy);
      trailCtx.stroke();
    } else {
      // backstitch
      trailCtx.beginPath();
      trailCtx.moveTo(x, y);
      trailCtx.lineTo(nx, ny);
      trailCtx.stroke();
      dist += stepLen;
      if (dist >= sl) {
        // Back-step
        const bx = nx - Math.cos(angle) * sl * 0.4;
        const by = ny - Math.sin(angle) * sl * 0.4;
        trailCtx.beginPath();
        trailCtx.moveTo(nx, ny);
        trailCtx.lineTo(bx, by);
        trailCtx.stroke();
        dist = 0;
      }
    }

    trailCtx.restore();
    x = nx;
    y = ny;
  }

  /* ── needle indicator ── */
  function drawNeedle() {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle + Math.PI / 2);
    ctx.fillStyle = '#c0c0c0';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(-1.5, 3);
    ctx.lineTo(1.5, 3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ── periodically change colour / style ── */
  let colorDist = 0;
  const colorChangeEvery = 600 + Math.random() * 400; // px

  /* ── main loop ── */
  let lastFrame = performance.now();

  function animate() {
    if (destroyed) return;
    const now = performance.now();
    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (dt > 0.1) dt = 0.016;

    // Advance stitch
    const advance = config.speed * dt;
    const stepSize = 3;  // small steps for smooth curves
    let remaining = advance;

    while (remaining > 0) {
      const step = Math.min(stepSize, remaining);
      steer(dt);
      drawStitchStep(step);
      remaining -= step;
      colorDist += step;

      if (colorDist >= colorChangeEvery) {
        colorDist = 0;
        color = pickColor();
        stitchStyle = pickWanderStyle();
        chainAnchor = null;
        chainAccum = 0;
      }
    }

    // Periodically fade the trail so old stitches disappear
    fadeTimer += dt;
    if (fadeTimer >= 0.3) {
      fadeTimer = 0;
      trailCtx.save();
      trailCtx.globalCompositeOperation = 'destination-out';
      trailCtx.fillStyle = 'rgba(0,0,0,0.008)';
      trailCtx.fillRect(0, 0, logicalW, logicalH);
      trailCtx.restore();
    }

    // Composite to display canvas — fabric comes from CSS bg, see buildFabric.
    ctx.clearRect(0, 0, logicalW, logicalH);
    ctx.drawImage(trailCanvas, 0, 0, logicalW, logicalH);
    drawNeedle();

    rafId = requestAnimationFrame(animate);
  }
  rafId = requestAnimationFrame(animate);

  return {
    setSpeed(v)     { config.speed = v; },
    setStitchLen(v) { config.stitchLen = v; },
    setCurliness(v) { config.curliness = v; },
    setPalette(v)   { config.palette = v; },
    setCustomColors(v) { config.customColors = v; },
    setStyle(v)     { config.style = v; stitchStyle = pickWanderStyle(); chainAnchor = null; chainAccum = 0; },
    reset()         { initWander(); },
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      containerRO.disconnect();
      canvas.remove();
    },
  };
}


/**
 * Pathed Stitch Effect — needle steers through a user-defined sequence of
 * points (normalized 0..1 of viewport) and weaves a loose, spirograph-style
 * design. Curliness adds wobble around the path. When the last point is
 * reached, the trail fades and the design rebuilds from point 0.
 *
 * options.points: [{x, y}] in 0..1 viewport-relative coords
 * options.closed: when true, after last point loop back to point 0 before fading
 */
export function createPathedStitchEffect(container, options = {}) {
  const canvas = document.createElement('canvas');
  canvas.classList.add('pg-bg-stitch');
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const trailCanvas = document.createElement('canvas');
  const trailCtx = trailCanvas.getContext('2d');

  const config = {
    speed:     options.speed ?? 100,
    stitchLen: options.stitchLen ?? 10,
    palette:   options.palette ?? 'warm',
    style:     options.style ?? 'running',
    curliness: options.curliness ?? 3,
    customColors: options.customColors || null,
    points:    Array.isArray(options.points) ? options.points.slice() : [],
    closed:    options.closed !== false,
    continuous: !!options.continuous,
  };

  let destroyed = false;
  let rafId = null;

  // Needle state
  let x = 0, y = 0, angle = 0;
  let segIdx = 0;            // index of current target point
  let color, stitchStyle;
  let dist = 0, stitchOn = true, zigSide = 1;
  let chainAnchor = null, chainAccum = 0;
  let fadeAlpha = 1;
  let fading = false;

  let logicalW = 0;
  let logicalH = 0;
  // Reference viewport for normalized coords — captured at init/resize
  let refW = window.innerWidth;
  let refH = window.innerHeight;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    // Preserve the existing trail so a resize (e.g. the bg div growing on
    // first scroll once page scrollHeight finalizes — see PegBoard parallax
    // sizing) doesn't wipe the in-progress design.
    let preserved = null;
    if (trailCanvas.width > 0 && trailCanvas.height > 0) {
      preserved = document.createElement('canvas');
      preserved.width = trailCanvas.width;
      preserved.height = trailCanvas.height;
      preserved.getContext('2d').drawImage(trailCanvas, 0, 0);
    }
    logicalW = canvas.offsetWidth;
    logicalH = canvas.offsetHeight;
    canvas.width  = logicalW * dpr;
    canvas.height = logicalH * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    trailCanvas.width  = canvas.width;
    trailCanvas.height = canvas.height;
    trailCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    refW = window.innerWidth;
    refH = window.innerHeight;
    if (preserved) {
      trailCtx.save();
      trailCtx.setTransform(1, 0, 0, 1, 0, 0); // draw in device pixels
      trailCtx.drawImage(preserved, 0, 0);
      trailCtx.restore();
    }
  }
  resize();
  const onResize = () => {
    const prevW = logicalW, prevH = logicalH;
    resize();
    if (logicalW !== prevW || logicalH !== prevH) {
      buildFabric();
      // Don't fullReset — the trail is preserved and the needle's pixel
      // position is still valid. Only width changes would shift design
      // coords (since pt() uses refW/refH = viewport), which is rare on
      // desktop scroll. If it happens, the needle will steer back on its own.
    }
  };
  window.addEventListener('resize', onResize);
  const containerRO = new ResizeObserver(onResize);
  containerRO.observe(container);

  function pickColor() {
    const pool = config.palette === 'custom' && config.customColors
      ? config.customColors
      : palettes[config.palette] || palettes.warm;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function pickPathedStyle() {
    const styles = ['running', 'backstitch', 'zigzag', 'chain', 'satin'];
    if (config.style !== 'mixed') return config.style;
    return styles[Math.floor(Math.random() * styles.length)];
  }

  /* Convert normalized point to canvas pixel coords. The design lives in the
     top-of-viewport region of the bg canvas (which may be 200vh tall). */
  function pt(p) {
    return { x: p.x * refW, y: p.y * refH };
  }

  function fullReset() {
    trailCtx.clearRect(0, 0, logicalW, logicalH);
    fadeAlpha = 1;
    fading = false;
    segIdx = 0;
    if (config.points.length >= 1) {
      const p0 = pt(config.points[0]);
      x = p0.x; y = p0.y;
      // Aim toward next point if available
      if (config.points.length >= 2) {
        const p1 = pt(config.points[1]);
        angle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        segIdx = 1;
      } else {
        angle = 0;
      }
    } else {
      x = logicalW / 2;
      y = refH / 2;
      angle = 0;
    }
    color = pickColor();
    stitchStyle = pickPathedStyle();
    dist = 0;
    stitchOn = true;
    zigSide = 1;
    chainAnchor = null;
    chainAccum = 0;
  }

  /* ── fabric texture ── attached as CSS bg, see standard effect for details. */
  const fabricCanvas = document.createElement('canvas');
  const fabricCtx = fabricCanvas.getContext('2d');
  function buildFabric() {
    const size = 60;
    fabricCanvas.width = size;
    fabricCanvas.height = size;
    fabricCtx.clearRect(0, 0, size, size);
    fabricCtx.strokeStyle = 'rgba(255,255,255,0.04)';
    fabricCtx.lineWidth = 0.5;
    const weave = 3;
    for (let xi = 0; xi < size; xi += weave) {
      fabricCtx.beginPath();
      fabricCtx.moveTo(xi, 0);
      fabricCtx.lineTo(xi, size);
      fabricCtx.stroke();
    }
    for (let yi = 0; yi < size; yi += weave) {
      fabricCtx.beginPath();
      fabricCtx.moveTo(0, yi);
      fabricCtx.lineTo(size, yi);
      fabricCtx.stroke();
    }
    canvas.style.backgroundImage = `url(${fabricCanvas.toDataURL('image/png')})`;
    canvas.style.backgroundRepeat = 'repeat';
  }
  buildFabric();

  /* Steer toward target with rate limit + curliness noise. Per-point `sharp`
   * flag flips the steering: a sharp target makes the needle head dead-on
   * with no smoothing, so the path reads as a straight segment with a hard
   * pivot at the waypoint instead of a curve. */
  function steer(dt) {
    if (config.points.length < 2) return;
    const tp = config.points[segIdx % config.points.length];
    const target = pt(tp);
    const dx = target.x - x;
    const dy = target.y - y;
    const desired = Math.atan2(dy, dx);

    if (tp.sharp) {
      angle = desired;
      return;
    }

    // Shortest signed angle delta in [-π, π]
    let delta = desired - angle;
    while (delta > Math.PI) delta -= 2 * Math.PI;
    while (delta < -Math.PI) delta += 2 * Math.PI;

    // Curliness scales both the max turn rate and the wobble amplitude:
    // higher curliness → looser, more meandering line; low → near-direct.
    const curl = config.curliness;
    const maxTurn = (1.5 + curl * 0.3) * dt;  // rad/frame
    const turn = Math.max(-maxTurn, Math.min(maxTurn, delta * 0.6));
    const noise = (Math.random() - 0.5) * curl * 0.06;
    angle += turn + noise;
  }

  function drawStitchStep(stepLen) {
    const sl = config.stitchLen;
    const nx = x + Math.cos(angle) * stepLen;
    const ny = y + Math.sin(angle) * stepLen;

    trailCtx.save();
    trailCtx.strokeStyle = color;
    trailCtx.lineWidth = 1.8;
    trailCtx.lineCap = 'round';
    // Shadows removed — see stitchRenderers.applyShadow comment. shadowBlur on
    // every stroke was the dominant cost across all stitch effects.

    if (stitchStyle === 'running') {
      if (stitchOn) {
        trailCtx.beginPath();
        trailCtx.moveTo(x, y);
        trailCtx.lineTo(nx, ny);
        trailCtx.stroke();
      }
      dist += stepLen;
      if (dist >= (stitchOn ? sl : sl * 0.7)) {
        dist = 0;
        stitchOn = !stitchOn;
      }
    } else if (stitchStyle === 'zigzag') {
      const perp = angle + Math.PI / 2;
      const amp = sl * 0.5;
      const ox = Math.cos(perp) * amp * zigSide;
      const oy = Math.sin(perp) * amp * zigSide;
      trailCtx.beginPath();
      trailCtx.moveTo(x, y);
      trailCtx.lineTo(nx + ox, ny + oy);
      trailCtx.stroke();
      dist += stepLen;
      if (dist >= sl) { dist = 0; zigSide *= -1; }
      x = nx + ox; y = ny + oy;
      trailCtx.restore();
      return;
    } else if (stitchStyle === 'chain') {
      // Accumulate steps until a full link length, then stamp a teardrop loop
      // from anchor → current pos. See wander effect for full reasoning.
      if (!chainAnchor) chainAnchor = { x, y };
      chainAccum += stepLen;
      const linkLen = sl * 1.4;
      if (chainAccum >= linkLen) {
        const halfWidth = sl * 0.4;
        const dxLink = nx - chainAnchor.x;
        const dyLink = ny - chainAnchor.y;
        const linkAngle = Math.atan2(dyLink, dxLink);
        const midX = (chainAnchor.x + nx) / 2;
        const midY = (chainAnchor.y + ny) / 2;
        const perpL = linkAngle + Math.PI / 2;
        trailCtx.lineJoin = 'round';
        trailCtx.beginPath();
        trailCtx.moveTo(chainAnchor.x, chainAnchor.y);
        trailCtx.quadraticCurveTo(
          midX + Math.cos(perpL) * halfWidth,
          midY + Math.sin(perpL) * halfWidth,
          nx, ny
        );
        trailCtx.quadraticCurveTo(
          midX - Math.cos(perpL) * halfWidth,
          midY - Math.sin(perpL) * halfWidth,
          chainAnchor.x, chainAnchor.y
        );
        trailCtx.stroke();
        chainAnchor = { x: nx, y: ny };
        chainAccum = 0;
      }
    } else if (stitchStyle === 'satin') {
      // Dense perpendicular crossing at the current point — successive steps
      // overlap and build a smooth filled satin band along the path.
      const perp = angle + Math.PI / 2;
      const amp = sl * 0.7;
      const ox = Math.cos(perp) * amp;
      const oy = Math.sin(perp) * amp;
      trailCtx.lineWidth = 1.4;
      trailCtx.beginPath();
      trailCtx.moveTo(x - ox, y - oy);
      trailCtx.lineTo(x + ox, y + oy);
      trailCtx.stroke();
    } else { // backstitch
      trailCtx.beginPath();
      trailCtx.moveTo(x, y);
      trailCtx.lineTo(nx, ny);
      trailCtx.stroke();
      dist += stepLen;
      if (dist >= sl) {
        const bx = nx - Math.cos(angle) * sl * 0.4;
        const by = ny - Math.sin(angle) * sl * 0.4;
        trailCtx.beginPath();
        trailCtx.moveTo(nx, ny);
        trailCtx.lineTo(bx, by);
        trailCtx.stroke();
        dist = 0;
      }
    }

    trailCtx.restore();
    x = nx; y = ny;
  }

  function drawNeedle() {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle + Math.PI / 2);
    ctx.fillStyle = '#c0c0c0';
    ctx.beginPath();
    ctx.moveTo(0, -6);
    ctx.lineTo(-1.5, 3);
    ctx.lineTo(1.5, 3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  fullReset();

  let lastFrame = performance.now();
  function animate() {
    if (destroyed) return;
    const now = performance.now();
    let dt = (now - lastFrame) / 1000;
    lastFrame = now;
    if (dt > 0.1) dt = 0.016;

    // Composite to display — fabric comes from CSS bg, see buildFabric.
    ctx.clearRect(0, 0, logicalW, logicalH);

    if (fading) {
      fadeAlpha -= dt * 0.8;
      if (fadeAlpha <= 0) {
        fullReset();
      } else {
        ctx.globalAlpha = fadeAlpha;
        ctx.drawImage(trailCanvas, 0, 0, logicalW, logicalH);
        ctx.globalAlpha = 1;
      }
      rafId = requestAnimationFrame(animate);
      return;
    }

    if (config.points.length >= 2) {
      const advance = config.speed * dt;
      const stepSize = 3;
      let remaining = advance;
      while (remaining > 0) {
        const step = Math.min(stepSize, remaining);
        steer(dt * (step / advance));
        drawStitchStep(step);
        remaining -= step;

        // Reached current target?
        const tp = config.points[segIdx % config.points.length];
        const target = pt(tp);
        const ddx = target.x - x;
        const ddy = target.y - y;
        const threshold = Math.max(config.stitchLen * 1.5, 12);
        if (ddx * ddx + ddy * ddy < threshold * threshold) {
          // Sharp waypoint: clamp position exactly to the marker so the corner
          // sits on the point instead of a few pixels short.
          const wasSharp = !!tp.sharp;
          if (wasSharp) {
            // Threshold-snap would leave an unstitched gap (~threshold px) on
            // the incoming side because drawStitchStep stops being called once
            // we jump to target. Fix: redirect the needle straight at the
            // target and walk the remaining distance via drawStitchStep so the
            // current style's drawing logic naturally fills the gap. Works for
            // every stitch style (running, backstitch, zigzag, chain, satin).
            const dxi = target.x - x;
            const dyi = target.y - y;
            const distRem = Math.sqrt(dxi * dxi + dyi * dyi);
            if (distRem > 0.5) {
              const directAngle = Math.atan2(dyi, dxi);
              angle = directAngle;
              let fillRem = distRem;
              while (fillRem > 0.5) {
                const fs = Math.min(stepSize, fillRem);
                drawStitchStep(fs);
                fillRem -= fs;
              }
            }
            x = target.x;
            y = target.y;
          }
          segIdx++;
          // End of path: closed loops back to 0 once, then fades; open fades at last point.
          // In continuous mode, we never fade — instead silently jump back to point 0
          // and start another pass on top of the existing trail.
          const total = config.points.length;
          const reachedEnd = config.closed ? segIdx > total : segIdx >= total;
          if (reachedEnd) {
            if (config.continuous) {
              // Aim at point 1 again — keep the needle's actual pixel position
              // so there's no teleport jump at the loop seam. The threshold
              // detector already brought us within ~stitchLen of point 0; the
              // steer() call next frame will smoothly turn toward point 1.
              segIdx = 1;
              dist = 0; stitchOn = true; zigSide = 1;
              chainAnchor = null; chainAccum = 0;
            } else {
              fading = true;
              break;
            }
          }
          // Sharp exit: snap angle to face the new target immediately, so the
          // corner is a hard pivot. Without this, the needle leaves still
          // facing the arrival direction and steer() would curve smoothly to
          // the next target — visually that reads as no corner at all.
          if (wasSharp) {
            const nextTp = config.points[segIdx % config.points.length];
            if (nextTp) {
              const np = pt(nextTp);
              const newAngle = Math.atan2(np.y - y, np.x - x);
              // Fill satin corner gap — perpendicular ribs on either side of
              // a sharp pivot leave a wedge-shaped empty area between them.
              if (stitchStyle === 'satin') {
                const sl = config.stitchLen;
                drawSatinCornerFan(trailCtx, { color, colorFor: null }, x, y, angle, newAngle, sl * 0.7);
              }
              angle = newAngle;
            }
          }
          // Re-pick color/style on each segment for visual variety
          color = pickColor();
          stitchStyle = pickPathedStyle();
          chainAnchor = null;
          chainAccum = 0;
        }
      }
    }

    ctx.drawImage(trailCanvas, 0, 0, logicalW, logicalH);
    if (config.points.length >= 2) drawNeedle();

    rafId = requestAnimationFrame(animate);
  }
  rafId = requestAnimationFrame(animate);

  return {
    setSpeed(v)     { config.speed = v; },
    setStitchLen(v) { config.stitchLen = v; },
    setCurliness(v) { config.curliness = v; },
    setPalette(v)   { config.palette = v; },
    setCustomColors(v) { config.customColors = v; },
    setStyle(v)     { config.style = v; stitchStyle = pickPathedStyle(); chainAnchor = null; chainAccum = 0; },
    setPoints(pts)  {
      config.points = Array.isArray(pts) ? pts.slice() : [];
      fullReset();
    },
    setClosed(v)    { config.closed = !!v; },
    setContinuous(v){ config.continuous = !!v; },
    reset()         { fullReset(); },
    destroy() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onResize);
      containerRO.disconnect();
      canvas.remove();
    },
  };
}
