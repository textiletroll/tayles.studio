/**
 * BorderStitch — per-element stitched border overlay.
 *
 * Replaces the normal SVG/CSS border for a single element with a canvas of
 * stitches traced along the element's perimeter. Supports:
 *   - Drawn-on-entrance animation (needle "sews" the border in over `duration`)
 *   - Static paint mode (entire border appears at once on play)
 *   - Continuous palette flow around the perimeter after entrance (CW/CCW)
 *
 * The canvas is appended to the wrapper at `position: absolute; inset: 0`. Its
 * coordinate system matches the wrapper's content box. Path points are in
 * those same wrapper-local pixel coords — PegBoard computes them from the
 * element's shape (rect, rounded-rect, polygon, ellipse, line polyline).
 */

import { drawStitchOnPath, polylineLength } from './stitchRenderers.js';

export function createBorderStitch(wrapper, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.classList.add('pg-border-stitch');
  Object.assign(canvas.style, {
    position: 'absolute',
    pointerEvents: 'none',
  });
  wrapper.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const config = {
    points: opts.points || [],
    closed: opts.closed !== false,
    style: opts.style || 'running',
    stitchLen: opts.stitchLen ?? 8,
    color: opts.color || '#1e1e1e',
    colors: Array.isArray(opts.colors) && opts.colors.length ? opts.colors : null,
    colorBlend: !!opts.colorBlend, // smooth interpolation between palette colors
    width: opts.width ?? 1.8,
    animated: opts.animated !== false,
    duration: opts.duration ?? 1.0,
    flow: !!opts.flow,
    flowDir: opts.flowDir === 'ccw' ? -1 : 1,
    flowSpeed: opts.flowSpeed ?? 60,
  };

  // Parse "#rrggbb" → [r, g, b]
  function hexToRgb(hex) {
    if (!hex || hex[0] !== '#' || hex.length < 7) return [255, 255, 255];
    return [
      parseInt(hex.slice(1, 3), 16),
      parseInt(hex.slice(3, 5), 16),
      parseInt(hex.slice(5, 7), 16),
    ];
  }

  // Cached RGB triples for `config.colors` — rebuilt only when the palette
  // changes. Without this cache, every stitch on every frame called hexToRgb
  // twice and rgbToHex once via lerpColor — a profile of a flowing blanket
  // border showed ~27 ms / 5 s spent in those three functions alone.
  let colorRgbs = null;
  function rebuildColorCache() {
    colorRgbs = (config.colors && config.colors.length)
      ? config.colors.map(hexToRgb)
      : null;
  }

  let logicalW = 0, logicalH = 0;
  let totalLen = 0;
  let progress = 0;
  let flowOffset = 0;
  let animating = false;
  let painted = false; // set true once initial paint has happened
  let rafId = null;
  let destroyed = false;
  let lastFrame = 0;
  // Canvas overhangs the wrapper on every side so stitches that extend
  // perpendicular to the perimeter (zigzag, satin, blanket, etc.) aren't
  // clipped at the panel edge. Size scales with stitchLen + line width.
  let overhang = 0;

  function computeOverhang() {
    // Generous so even tall stitches (zigzag amp ≈ stitchLen*0.6, satin ribs
    // ≈ stitchLen*0.7, blanket ticks ≈ stitchLen*0.9, feather/fishbone arms
    // close to stitchLen) plus shadow blur stay inside the canvas.
    return Math.ceil((config.stitchLen || 8) * 2.2 + (config.width || 1.8) * 3 + 6);
  }

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    logicalW = wrapper.clientWidth;
    logicalH = wrapper.clientHeight;
    overhang = computeOverhang();
    const cw = logicalW + overhang * 2;
    const ch = logicalH + overhang * 2;
    canvas.style.left = `-${overhang}px`;
    canvas.style.top = `-${overhang}px`;
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    canvas.width = Math.max(1, cw * dpr);
    canvas.height = Math.max(1, ch * dpr);
    // Translate so path coords (0..wrapperW, 0..wrapperH) draw at +overhang
    // on the larger canvas, keeping the perimeter centered visually.
    ctx.setTransform(dpr, 0, 0, dpr, overhang * dpr, overhang * dpr);
    redraw();
  }

  function recomputeLength() {
    totalLen = polylineLength(getDrawPoints());
  }

  function getDrawPoints() {
    const pts = config.points;
    if (config.closed && pts.length >= 2) {
      return [...pts, pts[0]];
    }
    return pts;
  }

  function colorFor(d) {
    const colors = config.colors;
    if (!colors || colors.length <= 1) return colors?.[0] || config.color;
    const N = colors.length;
    const chunkLen = totalLen / N;
    const shifted = ((d + flowOffset) % totalLen + totalLen) % totalLen;
    const t = shifted / chunkLen; // 0..N
    const idx = Math.floor(t) % N;
    if (!config.colorBlend) return colors[idx];
    // Interpolate from colors[idx] to colors[(idx+1) % N]. The chunk boundary
    // sits at the *center* of the band each color "owns" — so the visible
    // gradient runs from one color's center to the next. Wraps cleanly at
    // totalLen because both ends sample colors[0]→colors[1] on consecutive
    // passes.
    // Lerp on the cached RGB triples and emit `rgb(r,g,b)` directly — Canvas2D
    // accepts that format, so we skip rgbToHex's Math.round + toString(16) +
    // padStart trio that previously ran per stroke.
    const cache = colorRgbs;
    if (!cache) return colors[idx];
    const frac = t - Math.floor(t);
    const a = cache[idx];
    const b = cache[(idx + 1) % N];
    const r = (a[0] + (b[0] - a[0]) * frac) | 0;
    const g = (a[1] + (b[1] - a[1]) * frac) | 0;
    const bl = (a[2] + (b[2] - a[2]) * frac) | 0;
    return `rgb(${r},${g},${bl})`;
  }

  function redraw() {
    // Clear the FULL canvas (including the overhang strip beyond the wrapper).
    // The current transform translates by overhang, so clearRect must use
    // negative coords to reach the canvas's true (0,0).
    ctx.clearRect(-overhang, -overhang, logicalW + overhang * 2, logicalH + overhang * 2);
    if (logicalW === 0 || logicalH === 0 || totalLen === 0) return;
    const to = animating ? progress : totalLen;
    if (to <= 0) return;
    drawStitchOnPath(ctx, {
      points: getDrawPoints(),
      from: 0,
      to,
      style: config.style,
      stitchLen: config.stitchLen,
      width: config.width,
      color: config.color,
      colorFor: (config.colors && config.colors.length > 1) ? colorFor : null,
    });
  }

  // Coarsening of the flow position used to decide whether a redraw would
  // produce any visible change. With a 256-step quantization on the cycle, a
  // 1 px/frame flow on a 400 px perimeter only crosses a step every ~1.5
  // frames — the in-between frame would be visually identical, so we skip its
  // canvas redraw entirely. Higher = more aggressive frame skipping.
  const FLOW_STEPS = 256;
  let lastFlowStep = NaN;

  function loop(now) {
    if (destroyed) { rafId = null; return; }
    const dt = Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;

    let needRedraw = false;
    if (animating) {
      progress += (totalLen / Math.max(0.05, config.duration)) * dt;
      if (progress >= totalLen) {
        progress = totalLen;
        animating = false;
      }
      needRedraw = true;
    }
    if (config.flow && !animating) {
      flowOffset += config.flowSpeed * config.flowDir * dt;
      // Multi-color flow shifts every sample by the same amount. Until the
      // shift crosses a quantization step the rendered result is identical,
      // so the redraw is a pure no-op for the visible canvas.
      const hasGradient = config.colors && config.colors.length > 1;
      if (!hasGradient || totalLen <= 0) {
        needRedraw = true;
      } else {
        const norm = ((flowOffset % totalLen) + totalLen) % totalLen;
        const step = Math.floor((norm / totalLen) * FLOW_STEPS);
        if (step !== lastFlowStep) {
          lastFlowStep = step;
          needRedraw = true;
        }
      }
    }
    if (needRedraw) redraw();

    if (animating || config.flow) {
      rafId = requestAnimationFrame(loop);
    } else {
      rafId = null;
    }
  }

  function ensureLoop() {
    if (rafId !== null) return;
    lastFrame = performance.now();
    rafId = requestAnimationFrame(loop);
  }

  function play() {
    painted = true;
    if (config.animated) {
      progress = 0;
      animating = true;
      ensureLoop();
    } else {
      progress = totalLen;
      animating = false;
      redraw();
      if (config.flow) ensureLoop();
    }
  }

  function update(newOpts = {}) {
    const prevAnimated = config.animated;
    Object.assign(config, newOpts);
    if (newOpts.flowDir !== undefined) config.flowDir = newOpts.flowDir === 'ccw' ? -1 : 1;
    if (newOpts.colors !== undefined) {
      config.colors = Array.isArray(newOpts.colors) && newOpts.colors.length ? newOpts.colors : null;
      rebuildColorCache();
    }
    if ('points' in newOpts || 'closed' in newOpts) {
      recomputeLength();
      if (!animating) progress = totalLen;
    }
    // animated turning off mid-animation → snap to fully drawn
    if (prevAnimated && !config.animated && animating) {
      animating = false;
      progress = totalLen;
    }
    redraw();
    if (config.flow || animating) ensureLoop();
  }

  function destroy() {
    destroyed = true;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    canvas.remove();
  }

  rebuildColorCache();
  recomputeLength();
  resize();

  return { play, update, destroy, resize, get hasPlayed() { return painted; } };
}
