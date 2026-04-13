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
    const styles = ['running', 'backstitch', 'zigzag', 'chain'];
    if (config.style !== 'mixed') return config.style;
    return styles[Math.floor(Math.random() * styles.length)];
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

  /* ── point along polyline at distance ── */
  function pointAtDist(pts, dist) {
    let traveled = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (traveled + segLen >= dist) {
        const t = (dist - traveled) / segLen;
        return {
          x: pts[i - 1].x + dx * t,
          y: pts[i - 1].y + dy * t,
          angle: Math.atan2(dy, dx),
        };
      }
      traveled += segLen;
    }
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2] || last;
    return { x: last.x, y: last.y, angle: Math.atan2(last.y - prev.y, last.x - prev.x) };
  }

  /* ── stitch renderers ── */
  function drawRunning(target, path, from, to) {
    const sl = config.stitchLen;
    const gap = sl * 0.7;
    let d = 0, on = true;
    target.strokeStyle = path.color;
    target.lineWidth = path.width;
    target.lineCap = 'round';
    while (d < to) {
      const len = on ? sl : gap;
      const end = Math.min(d + len, to);
      if (on && end > from) {
        const s = Math.max(d, from);
        const p1 = pointAtDist(path.points, s);
        const p2 = pointAtDist(path.points, end);
        target.beginPath();
        target.moveTo(p1.x, p1.y);
        target.lineTo(p2.x, p2.y);
        target.stroke();
      }
      d += len;
      on = !on;
    }
  }

  function drawBackstitch(target, path, from, to) {
    const sl = config.stitchLen;
    const step = sl * 0.6;
    let d = 0, idx = 0;
    target.strokeStyle = path.color;
    target.lineWidth = path.width;
    target.lineCap = 'round';
    while (d < to) {
      const fwd = Math.min(d + sl, to);
      if (fwd > from) {
        const s = Math.max(d, from);
        const p1 = pointAtDist(path.points, s);
        const p2 = pointAtDist(path.points, fwd);
        target.beginPath();
        target.moveTo(p1.x, p1.y);
        target.lineTo(p2.x, p2.y);
        target.stroke();
      }
      if (fwd < to && idx % 2 === 0 && fwd > from) {
        const back = Math.max(fwd - step, 0);
        const p3 = pointAtDist(path.points, fwd);
        const p4 = pointAtDist(path.points, back);
        target.beginPath();
        target.moveTo(p3.x, p3.y);
        target.lineTo(p4.x, p4.y);
        target.stroke();
      }
      d = fwd + step * 0.3;
      idx++;
    }
  }

  function drawZigzag(target, path, _from, to) {
    // Zigzag must draw from 0 to maintain continuous path
    const sl = config.stitchLen;
    const amp = sl * 0.6;
    let d = 0, side = 1;
    target.strokeStyle = path.color;
    target.lineWidth = path.width;
    target.lineCap = 'round';
    target.beginPath();
    const first = pointAtDist(path.points, 0);
    target.moveTo(first.x, first.y);
    while (d < to) {
      d += sl;
      if (d > to) d = to;
      const pt = pointAtDist(path.points, d);
      const perp = pt.angle + Math.PI / 2;
      const ox = Math.cos(perp) * amp * side;
      const oy = Math.sin(perp) * amp * side;
      target.lineTo(pt.x + ox, pt.y + oy);
      side *= -1;
    }
    target.stroke();
  }

  function drawChain(target, path, from, to) {
    const sl = config.stitchLen * 1.2;
    let d = 0;
    target.strokeStyle = path.color;
    target.lineWidth = path.width;
    target.lineCap = 'round';
    while (d < to) {
      const end = Math.min(d + sl, to);
      if (end > from) {
        const mid = (d + end) / 2;
        const p1 = pointAtDist(path.points, d);
        const p2 = pointAtDist(path.points, mid);
        const p3 = pointAtDist(path.points, end);
        const perp = p2.angle + Math.PI / 2;
        const bulge = sl * 0.3;
        const cx = p2.x + Math.cos(perp) * bulge;
        const cy = p2.y + Math.sin(perp) * bulge;
        target.beginPath();
        target.moveTo(p1.x, p1.y);
        target.quadraticCurveTo(cx, cy, p3.x, p3.y);
        target.stroke();
      }
      d = end;
    }
  }

  /* ── needle indicator ── */
  function drawNeedle(path) {
    if (path.progress >= path.totalLen) return;
    const pt = pointAtDist(path.points, path.progress);
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

  /* ── draw a stitch segment with shadow ── */
  function drawStitch(target, path, from, to) {
    target.save();
    target.shadowColor = 'rgba(0,0,0,0.35)';
    target.shadowBlur = 2;
    target.shadowOffsetX = 1;
    target.shadowOffsetY = 1;
    const fn = { running: drawRunning, backstitch: drawBackstitch, zigzag: drawZigzag, chain: drawChain };
    (fn[path.style] || drawRunning)(target, path, from, to);
    target.restore();
  }

  /** Stamp a path's full completed stitch onto the done canvas. */
  function stampCompleted(path) {
    drawStitch(doneCtx, path, 0, path.totalLen);
  }

  /* ── fabric texture ── */
  const fabricCanvas = document.createElement('canvas');
  const fabricCtx = fabricCanvas.getContext('2d');
  let fabricPattern = null;

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
    fabricPattern = ctx.createPattern(fabricCanvas, 'repeat');
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

    ctx.clearRect(0, 0, logicalW, logicalH);

    // Fabric texture
    if (fabricPattern) {
      ctx.fillStyle = fabricPattern;
      ctx.fillRect(0, 0, logicalW, logicalH);
    }

    // Draw completed stitches from the cached canvas
    if (fading) {
      // Fade out before starting fresh
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

    // Blit the done layer at full opacity
    ctx.drawImage(doneCanvas, 0, 0);

    // Advance and draw active paths
    let allDone = true;
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

      if (path.progress > 0) {
        // Draw only the new segment on the live canvas
        drawStitch(ctx, path, 0, path.progress);

        if (path.progress < path.totalLen) {
          drawNeedle(path);
        } else {
          // Just finished — stamp to done canvas and mark done
          stampCompleted(path);
          path.done = true;
        }
      }
    }

    if (allDone) {
      // All stitches complete — begin fade-out, then rebuild
      fading = true;
    }

    rafId = requestAnimationFrame(animate);
  }
  rafId = requestAnimationFrame(animate);

  /* ── public API ── */
  return {
    setSpeed(v)     { config.speed = v; },
    setStitchLen(v) { config.stitchLen = v; },
    setCurliness(v) { config.curliness = v; fullReset(); },
    setPalette(v)   { config.palette = v; },
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
    const styles = ['running', 'backstitch', 'zigzag', 'chain'];
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
    trailCtx.clearRect(0, 0, logicalW, logicalH);
  }
  initWander();

  /* ── fabric texture ── */
  const fabricCanvas = document.createElement('canvas');
  const fabricCtx = fabricCanvas.getContext('2d');
  let fabricPattern = null;

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
    fabricPattern = ctx.createPattern(fabricCanvas, 'repeat');
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
    trailCtx.shadowColor = 'rgba(0,0,0,0.3)';
    trailCtx.shadowBlur = 1.5;
    trailCtx.shadowOffsetX = 0.5;
    trailCtx.shadowOffsetY = 0.5;

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
      const midX = (x + nx) / 2;
      const midY = (y + ny) / 2;
      const perp = angle + Math.PI / 2;
      const bulge = sl * 0.25;
      trailCtx.beginPath();
      trailCtx.moveTo(x, y);
      trailCtx.quadraticCurveTo(
        midX + Math.cos(perp) * bulge,
        midY + Math.sin(perp) * bulge,
        nx, ny
      );
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

    // Composite to display canvas
    ctx.clearRect(0, 0, logicalW, logicalH);
    if (fabricPattern) {
      ctx.fillStyle = fabricPattern;
      ctx.fillRect(0, 0, logicalW, logicalH);
    }
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
    setStyle(v)     { config.style = v; stitchStyle = pickWanderStyle(); },
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
