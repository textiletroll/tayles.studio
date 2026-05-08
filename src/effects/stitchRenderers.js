/**
 * Shared stitch renderers — used by both the bg stitch effect (path-based mode)
 * and the per-element BorderStitch overlay. All renderers operate on a
 * polyline (`points`) and a distance range `[from, to]` along it.
 *
 * Color sampling is handled by `opts.colorFor(distance)` if provided, else
 * `opts.color`. This lets callers feed multi-color palettes that flow along
 * the path (the BorderStitch flow effect) without renderers needing to know.
 */

export const STITCH_STYLES = [
  'running', 'backstitch', 'zigzag', 'chain', 'satin', 'mixed',
  'cross', 'blanket', 'whip', 'herringbone', 'stem',
  'feather', 'fishbone', 'couching', 'frenchKnot',
];

// Styles that work in step-based (wander/pathed) needle drawing.
export const STEP_BASED_STYLES = ['running', 'backstitch', 'zigzag', 'chain', 'satin', 'mixed'];

// Styles that "mixed" can pick at random (excludes mixed itself + the heavy ones)
const MIXABLE = ['running', 'backstitch', 'zigzag', 'chain', 'cross', 'blanket', 'whip', 'stem'];

export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

export function pointAtDist(points, dist) {
  let traveled = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    const segLen = Math.sqrt(dx * dx + dy * dy);
    if (traveled + segLen >= dist) {
      const t = (dist - traveled) / Math.max(segLen, 1e-9);
      return {
        x: points[i - 1].x + dx * t,
        y: points[i - 1].y + dy * t,
        angle: Math.atan2(dy, dx),
      };
    }
    traveled += segLen;
  }
  const last = points[points.length - 1];
  const prev = points[points.length - 2] || last;
  return { x: last.x, y: last.y, angle: Math.atan2(last.y - prev.y, last.x - prev.x) };
}

function pickColor(opts, d) {
  if (typeof opts.colorFor === 'function') return opts.colorFor(d);
  return opts.color || '#fff';
}

// Shadow used to be applied via `target.shadow*` here, but Canvas2D shadowBlur
// forces a software rasterization pass for every stroke — at dozens of stitches
// per frame across multiple effects it was the dominant cost. The visual gain
// at blur=2 was minimal, so shadows are now a no-op. If they need to come back,
// do a manual offset stroke (cheap) instead of toggling shadowBlur.
function applyShadow(_target, _opts) { /* intentionally empty */ }

/* ── Renderers ── */

function drawRunning(target, opts) {
  const { points, from, to, stitchLen, width } = opts;
  const sl = stitchLen;
  const gap = sl * 0.7;
  let d = 0, on = true;
  target.lineWidth = width;
  while (d < to) {
    const len = on ? sl : gap;
    const end = Math.min(d + len, to);
    if (on && end > from) {
      const s = Math.max(d, from);
      const p1 = pointAtDist(points, s);
      const p2 = pointAtDist(points, end);
      target.strokeStyle = pickColor(opts, (s + end) / 2);
      target.beginPath();
      target.moveTo(p1.x, p1.y);
      target.lineTo(p2.x, p2.y);
      target.stroke();
    }
    d += len;
    on = !on;
  }
}

function drawBackstitch(target, opts) {
  const { points, from, to, stitchLen, width } = opts;
  const sl = stitchLen;
  const step = sl * 0.6;
  let d = 0, idx = 0;
  target.lineWidth = width;
  while (d < to) {
    const fwd = Math.min(d + sl, to);
    if (fwd > from) {
      const s = Math.max(d, from);
      const p1 = pointAtDist(points, s);
      const p2 = pointAtDist(points, fwd);
      target.strokeStyle = pickColor(opts, (s + fwd) / 2);
      target.beginPath();
      target.moveTo(p1.x, p1.y);
      target.lineTo(p2.x, p2.y);
      target.stroke();
    }
    if (fwd < to && idx % 2 === 0 && fwd > from) {
      const back = Math.max(fwd - step, 0);
      const p3 = pointAtDist(points, fwd);
      const p4 = pointAtDist(points, back);
      target.beginPath();
      target.moveTo(p3.x, p3.y);
      target.lineTo(p4.x, p4.y);
      target.stroke();
    }
    d = fwd + step * 0.3;
    idx++;
  }
}

function drawZigzag(target, opts) {
  const { points, from = 0, to, stitchLen, width } = opts;
  const sl = stitchLen;
  const amp = sl * 0.6;
  target.lineWidth = width;
  // Sub-sample the path so the zigzag's connecting lines hug curved paths
  // instead of cutting straight chord lines (large stitchLen on circular
  // shapes was producing crisscross arcs across the panel interior). Each
  // sub-step samples an offset from a triangle wave with period 2*sl so
  // peaks alternate at d = 0, sl, 2sl, 3sl... Sub-samples per stitch length
  // are clamped to a sensible range so the wave still reads as sharp.
  const sub = Math.max(1.5, Math.min(4, sl / 8));

  // Compute the zigzag-offset point at distance d along the path.
  function curAt(d) {
    const pt = pointAtDist(points, d);
    const phase = ((d / sl) % 2 + 2) % 2;
    const tri = phase < 1 ? 1 - 2 * phase : 2 * (phase - 1) - 1;
    const offset = tri * amp;
    const perp = pt.angle + Math.PI / 2;
    return { x: pt.x + Math.cos(perp) * offset, y: pt.y + Math.sin(perp) * offset };
  }

  // For incremental stamping (from > 0): seed `prev` at exactly `from` so the
  // first drawn segment continues cleanly from the previous frame's last point.
  let prev = from > 0 ? curAt(from) : null;
  let d = from;
  while (d <= to) {
    const cur = curAt(d);
    if (prev && d > from) {
      target.strokeStyle = pickColor(opts, d - sub / 2);
      target.beginPath();
      target.moveTo(prev.x, prev.y);
      target.lineTo(cur.x, cur.y);
      target.stroke();
    }
    prev = cur;
    if (d >= to) break;
    // Step toward the next sub-sample, but stop exactly at peaks so the
    // triangle wave's sharp corners sit on the path (avoids rounded peaks
    // when sub doesn't divide sl evenly).
    const nextPeak = Math.floor(d / sl + 1) * sl;
    const next = Math.min(d + sub, nextPeak, to);
    if (next === d) break;
    d = next;
  }
}

function drawChain(target, opts) {
  const { points, from = 0, to, stitchLen, width } = opts;
  const sl = stitchLen * 1.4;
  const halfWidth = stitchLen * 0.4;
  target.lineWidth = width;
  // Chain links are atomic teardrops — drawing a partial curve looks broken,
  // and the original code's "Math.min(d+sl, to)" clamp produced over-drawn
  // links on every full-path redraw. Atomic rule: draw a link only when its
  // natural endpoint (d + sl) lies in (from, to]. With incremental from =
  // prevProgress, to = progress, each link is drawn exactly once.
  let d = 0;
  while (d < to) {
    const end = d + sl;
    if (end <= to && end > from) {
      const p1 = pointAtDist(points, d);
      const p2 = pointAtDist(points, end);
      const mid = pointAtDist(points, (d + end) / 2);
      const perp = mid.angle + Math.PI / 2;
      const lx = mid.x + Math.cos(perp) * halfWidth;
      const ly = mid.y + Math.sin(perp) * halfWidth;
      const rx = mid.x - Math.cos(perp) * halfWidth;
      const ry = mid.y - Math.sin(perp) * halfWidth;
      target.strokeStyle = pickColor(opts, (d + end) / 2);
      target.beginPath();
      target.moveTo(p1.x, p1.y);
      target.quadraticCurveTo(lx, ly, p2.x, p2.y);
      target.quadraticCurveTo(rx, ry, p1.x, p1.y);
      target.stroke();
    }
    d = end;
  }
}

function drawSatin(target, opts) {
  const { points, from, to, stitchLen, width } = opts;
  const spacing = 2.5;
  const amp = stitchLen * 0.7;
  target.lineWidth = width * 0.85;

  // Walk segment-by-segment so corners can be fan-filled — without the fan,
  // perpendicular ribs all radiate from a sharp vertex leaving wedge gaps.
  const cumLen = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    cumLen.push(cumLen[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  const totalLen = cumLen[cumLen.length - 1];
  const upTo = Math.min(to, totalLen);

  function segIdxAt(d) {
    for (let i = 1; i < cumLen.length; i++) if (cumLen[i] >= d) return i;
    return points.length - 1;
  }

  let d = Math.ceil(Math.max(from, 0) / spacing) * spacing;
  let prevSegIdx = -1;
  while (d <= upTo) {
    const segIdx = segIdxAt(d);
    const segLen = Math.max(cumLen[segIdx] - cumLen[segIdx - 1], 1e-9);
    const t = (d - cumLen[segIdx - 1]) / segLen;
    const dx = points[segIdx].x - points[segIdx - 1].x;
    const dy = points[segIdx].y - points[segIdx - 1].y;
    const px = points[segIdx - 1].x + dx * t;
    const py = points[segIdx - 1].y + dy * t;
    const segAngle = Math.atan2(dy, dx);

    if (prevSegIdx !== -1 && segIdx !== prevSegIdx) {
      const corner = points[prevSegIdx];
      const pdx = points[prevSegIdx].x - points[prevSegIdx - 1].x;
      const pdy = points[prevSegIdx].y - points[prevSegIdx - 1].y;
      const prevAngle = Math.atan2(pdy, pdx);
      drawSatinCornerFan(target, opts, corner.x, corner.y, prevAngle, segAngle, amp);
    }

    const perp = segAngle + Math.PI / 2;
    const ox = Math.cos(perp) * amp;
    const oy = Math.sin(perp) * amp;
    target.strokeStyle = pickColor(opts, d);
    target.beginPath();
    target.moveTo(px - ox, py - oy);
    target.lineTo(px + ox, py + oy);
    target.stroke();

    prevSegIdx = segIdx;
    d += spacing;
  }
}

/* Fill a satin corner by sweeping perpendicular ribs centered at (cx, cy)
 * through the angular gap between the incoming and outgoing perpendiculars.
 * Without this, sharp polyline corners in satin mode leave a wedge-shaped
 * empty area where neither side's ribs reach. Exported so the pathed bg
 * stitch effect can use it at sharp waypoints. */
export function drawSatinCornerFan(target, opts, cx, cy, prevAngle, nextAngle, amp) {
  const prevPerp = prevAngle + Math.PI / 2;
  const nextPerp = nextAngle + Math.PI / 2;
  let delta = nextPerp - prevPerp;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  if (Math.abs(delta) < 0.05) return; // near-straight, no fan needed
  // Bump density so adjacent ribs visually overlap — the gap was visible at
  // moderate angle changes because the angular spacing was too coarse.
  const N = Math.max(8, Math.ceil(Math.abs(delta) * 24));
  target.save();
  target.lineCap = 'round';
  target.lineWidth = opts.lineWidth || 1.4;
  // Shadows omitted here for the same reason as applyShadow — see note above.
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const a = prevPerp + delta * t;
    const ox = Math.cos(a) * amp;
    const oy = Math.sin(a) * amp;
    target.strokeStyle = pickColor(opts, cx * 7 + cy * 13 + i * 3);
    target.beginPath();
    target.moveTo(cx - ox, cy - oy);
    target.lineTo(cx + ox, cy + oy);
    target.stroke();
  }
  target.restore();
}

/* Cross — Xs centered on the path at intervals. */
function drawCross(target, opts) {
  const { points, from, to, stitchLen, width } = opts;
  const step = stitchLen * 1.4;
  const half = stitchLen * 0.45;
  target.lineWidth = width;
  let d = step / 2;
  while (d <= to) {
    if (d >= from) {
      const pt = pointAtDist(points, d);
      const a = pt.angle;
      const c1 = Math.cos(a + Math.PI / 4) * half;
      const s1 = Math.sin(a + Math.PI / 4) * half;
      const c2 = Math.cos(a - Math.PI / 4) * half;
      const s2 = Math.sin(a - Math.PI / 4) * half;
      target.strokeStyle = pickColor(opts, d);
      target.beginPath();
      target.moveTo(pt.x - c1, pt.y - s1);
      target.lineTo(pt.x + c1, pt.y + s1);
      target.moveTo(pt.x - c2, pt.y - s2);
      target.lineTo(pt.x + c2, pt.y + s2);
      target.stroke();
    }
    d += step;
  }
}

/* Blanket — continuous baseline + perpendicular ticks at intervals.
 * Baseline drawn segment-by-segment so each short piece picks up the local
 * pickColor(d), matching how the ticks sample colors. Without this, the
 * baseline was one solid color while the ticks alternated. */
function drawBlanket(target, opts) {
  const { points, from, to, stitchLen, width } = opts;
  target.lineWidth = width;
  const baseStep = 3;
  let prev = pointAtDist(points, Math.max(from, 0));
  for (let d = Math.max(from, 0) + baseStep; d <= to; d += baseStep) {
    const p = pointAtDist(points, d);
    target.strokeStyle = pickColor(opts, d - baseStep / 2);
    target.beginPath();
    target.moveTo(prev.x, prev.y);
    target.lineTo(p.x, p.y);
    target.stroke();
    prev = p;
  }
  // Perpendicular ticks
  const tickLen = stitchLen * 0.9;
  const tickStep = stitchLen * 1.1;
  let d = tickStep / 2;
  while (d <= to) {
    if (d >= from) {
      const pt = pointAtDist(points, d);
      const perp = pt.angle + Math.PI / 2;
      target.strokeStyle = pickColor(opts, d);
      target.beginPath();
      target.moveTo(pt.x, pt.y);
      target.lineTo(pt.x + Math.cos(perp) * tickLen, pt.y + Math.sin(perp) * tickLen);
      target.stroke();
    }
    d += tickStep;
  }
}

/* Whip — diagonal slants, all leaning the same direction. */
function drawWhip(target, opts) {
  const { points, from, to, stitchLen, width } = opts;
  const step = stitchLen * 0.7;
  const half = stitchLen * 0.55;
  target.lineWidth = width;
  let d = step / 2;
  while (d <= to) {
    if (d >= from) {
      const pt = pointAtDist(points, d);
      const a = pt.angle + Math.PI / 3; // diagonal lean
      const ox = Math.cos(a) * half;
      const oy = Math.sin(a) * half;
      target.strokeStyle = pickColor(opts, d);
      target.beginPath();
      target.moveTo(pt.x - ox, pt.y - oy);
      target.lineTo(pt.x + ox, pt.y + oy);
      target.stroke();
    }
    d += step;
  }
}

/* Herringbone — overlapping crossing diagonals along the path. */
function drawHerringbone(target, opts) {
  const { points, from, to, stitchLen, width } = opts;
  const step = stitchLen * 0.9;
  const half = stitchLen * 0.7;
  target.lineWidth = width;
  let d = 0, alt = 0;
  while (d <= to) {
    if (d >= from) {
      const pt = pointAtDist(points, d);
      const a = pt.angle + (alt ? -Math.PI / 3 : Math.PI / 3);
      const ox = Math.cos(a) * half;
      const oy = Math.sin(a) * half;
      target.strokeStyle = pickColor(opts, d);
      target.beginPath();
      target.moveTo(pt.x - ox, pt.y - oy);
      target.lineTo(pt.x + ox, pt.y + oy);
      target.stroke();
    }
    d += step;
    alt = 1 - alt;
  }
}

/* Stem — overlapping forward-leaning stitches, rope-like. Each stitch
   crosses the path at a shallow angle and the next one starts halfway
   along it so they overlap. */
function drawStem(target, opts) {
  const { points, from = 0, to, stitchLen, width } = opts;
  const step = stitchLen * 0.5;
  target.lineWidth = width * 1.1;
  // Stem stitches are atomic offset slants. With incremental stamping we draw
  // each one exactly once when its endpoint enters (from, to]. Adjacent stem
  // stitches overlap by 50% (step = sl/2), so any rendering is dense and the
  // dropped partial at the very tail is visually negligible.
  let d = 0;
  while (d + stitchLen <= to) {
    const end = d + stitchLen;
    if (end > from) {
      const p1 = pointAtDist(points, d);
      const p2 = pointAtDist(points, end);
      const mid = pointAtDist(points, (d + end) / 2);
      const perp = mid.angle + Math.PI / 2;
      const off = stitchLen * 0.18;
      target.strokeStyle = pickColor(opts, (d + end) / 2);
      target.beginPath();
      target.moveTo(p1.x + Math.cos(perp) * off, p1.y + Math.sin(perp) * off);
      target.lineTo(p2.x - Math.cos(perp) * off, p2.y - Math.sin(perp) * off);
      target.stroke();
    }
    d += step;
  }
}

/* Feather — alternating branching V's off a central path. */
function drawFeather(target, opts) {
  const { points, from, to, stitchLen, width } = opts;
  const step = stitchLen * 1.0;
  const armLen = stitchLen * 0.9;
  const armAngle = Math.PI / 3.2;
  target.lineWidth = width;
  let d = 0, alt = 0;
  while (d <= to) {
    if (d >= from) {
      const pt = pointAtDist(points, d);
      const sideMul = alt ? 1 : -1;
      const a1 = pt.angle + sideMul * armAngle;
      const a2 = pt.angle + sideMul * (Math.PI - armAngle);
      target.strokeStyle = pickColor(opts, d);
      target.beginPath();
      target.moveTo(pt.x + Math.cos(a2) * armLen, pt.y + Math.sin(a2) * armLen);
      target.lineTo(pt.x, pt.y);
      target.lineTo(pt.x + Math.cos(a1) * armLen, pt.y + Math.sin(a1) * armLen);
      target.stroke();
    }
    d += step;
    alt = 1 - alt;
  }
}

/* Fishbone — slanted pairs converging on the path midline. */
function drawFishbone(target, opts) {
  const { points, from, to, stitchLen, width } = opts;
  const step = stitchLen * 0.7;
  const armLen = stitchLen * 0.85;
  const armAngle = Math.PI / 4;
  target.lineWidth = width * 0.95;
  let d = 0, alt = 0;
  while (d <= to) {
    if (d >= from) {
      const pt = pointAtDist(points, d);
      const sideMul = alt ? 1 : -1;
      const a = pt.angle + sideMul * (Math.PI / 2 - armAngle);
      const ex = pt.x + Math.cos(a) * armLen;
      const ey = pt.y + Math.sin(a) * armLen;
      target.strokeStyle = pickColor(opts, d);
      target.beginPath();
      target.moveTo(pt.x, pt.y);
      target.lineTo(ex, ey);
      target.stroke();
    }
    d += step;
    alt = 1 - alt;
  }
}

/* Couching — long continuous line + sparse perpendicular ties.
 * Long line is drawn segment-by-segment for per-position color sampling so
 * a multi-color palette flows along the line instead of being one band. */
function drawCouching(target, opts) {
  const { points, from, to, stitchLen, width } = opts;
  target.lineWidth = width * 1.2;
  const lineStep = 3;
  let prev = pointAtDist(points, Math.max(from, 0));
  for (let d = Math.max(from, 0) + lineStep; d <= to; d += lineStep) {
    const p = pointAtDist(points, d);
    target.strokeStyle = pickColor(opts, d - lineStep / 2);
    target.beginPath();
    target.moveTo(prev.x, prev.y);
    target.lineTo(p.x, p.y);
    target.stroke();
    prev = p;
  }
  // Perpendicular ties
  target.lineWidth = width * 0.8;
  const tieStep = stitchLen * 2.2;
  const tieHalf = stitchLen * 0.4;
  let d = tieStep / 2;
  while (d <= to) {
    if (d >= from) {
      const pt = pointAtDist(points, d);
      const perp = pt.angle + Math.PI / 2;
      const ox = Math.cos(perp) * tieHalf;
      const oy = Math.sin(perp) * tieHalf;
      target.strokeStyle = pickColor(opts, d);
      target.beginPath();
      target.moveTo(pt.x - ox, pt.y - oy);
      target.lineTo(pt.x + ox, pt.y + oy);
      target.stroke();
    }
    d += tieStep;
  }
}

/* French knot — small filled dots at intervals along the path. */
function drawFrenchKnot(target, opts) {
  const { points, from, to, stitchLen, width } = opts;
  const step = stitchLen * 1.3;
  const r = Math.max(2, width * 1.4);
  let d = step / 2;
  while (d <= to) {
    if (d >= from) {
      const pt = pointAtDist(points, d);
      target.fillStyle = pickColor(opts, d);
      target.beginPath();
      target.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      target.fill();
    }
    d += step;
  }
}

const RENDERERS = {
  running: drawRunning,
  backstitch: drawBackstitch,
  zigzag: drawZigzag,
  chain: drawChain,
  satin: drawSatin,
  cross: drawCross,
  blanket: drawBlanket,
  whip: drawWhip,
  herringbone: drawHerringbone,
  stem: drawStem,
  feather: drawFeather,
  fishbone: drawFishbone,
  couching: drawCouching,
  frenchKnot: drawFrenchKnot,
};

/**
 * Draw stitches along a polyline path on the given 2D canvas context.
 *
 * opts:
 *   points:    [{x, y}] polyline
 *   from, to:  distance range along path to render
 *   style:     one of STITCH_STYLES
 *   stitchLen: base stitch length in px
 *   width:     line width
 *   color:     fallback color string
 *   colorFor:  optional (distance) => color, takes precedence over color
 *
 * Note: drop shadows are no longer rendered (the shadow option is accepted
 * but ignored). See applyShadow's comment for the rationale.
 */
export function drawStitchOnPath(target, opts) {
  let style = opts.style || 'running';
  if (style === 'mixed') {
    style = MIXABLE[Math.floor(Math.random() * MIXABLE.length)];
  }
  const fn = RENDERERS[style] || RENDERERS.running;
  target.save();
  target.lineCap = 'round';
  target.lineJoin = 'round';
  applyShadow(target, opts);
  fn(target, { ...opts, style });
  target.restore();
}
