(function () {
  'use strict';

  // Each generator returns an array of {x, y} points forming a closed polyline.
  // After generation, points are normalized to fit within a unit circle of radius 1
  // centered at the origin. The Game scales them at draw-time.

  function heart(steps = 220) {
    const pts = [];
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const x = 16 * Math.pow(Math.sin(t), 3);
      // y inverted because canvas y is downward — we'll flip at normalize
      const y = -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t));
      pts.push({ x, y });
    }
    return pts;
  }

  function star(points = 5, innerRatio = 0.42, segmentsPerEdge = 12) {
    const pts = [];
    const totalCorners = points * 2;
    for (let i = 0; i < totalCorners; i++) {
      const a0 = (i       / totalCorners) * Math.PI * 2 - Math.PI / 2;
      const a1 = ((i + 1) / totalCorners) * Math.PI * 2 - Math.PI / 2;
      const r0 = (i % 2 === 0) ? 1 : innerRatio;
      const r1 = ((i + 1) % 2 === 0) ? 1 : innerRatio;
      const x0 = Math.cos(a0) * r0, y0 = Math.sin(a0) * r0;
      const x1 = Math.cos(a1) * r1, y1 = Math.sin(a1) * r1;
      // subdivide for higher resolution distance checks
      for (let s = 0; s < segmentsPerEdge; s++) {
        const u = s / segmentsPerEdge;
        pts.push({ x: x0 + (x1 - x0) * u, y: y0 + (y1 - y0) * u });
      }
    }
    return pts;
  }

  function flower(petals = 5, amp = 0.28, steps = 240) {
    const pts = [];
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      const r = 1 + amp * Math.cos(petals * t);
      pts.push({ x: r * Math.cos(t), y: r * Math.sin(t) });
    }
    return pts;
  }

  function normalize(pts) {
    // center bounding box at origin, scale so max radius = 1
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    let maxR = 0;
    for (const p of pts) {
      p.x -= cx; p.y -= cy;
      const r = Math.hypot(p.x, p.y);
      if (r > maxR) maxR = r;
    }
    if (maxR > 0) for (const p of pts) { p.x /= maxR; p.y /= maxR; }
    return pts;
  }

  function totalLength(pts) {
    let L = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      L += Math.hypot(b.x - a.x, b.y - a.y);
    }
    return L;
  }

  // Distance from point (px,py) to closest segment of polyline pts.
  // Returns { dist, segIndex, t } where t∈[0,1] is position along the segment.
  function distanceToOutline(px, py, pts) {
    let best = Infinity, bestI = 0, bestT = 0;
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      let t = len2 ? ((px - a.x) * dx + (py - a.y) * dy) / len2 : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      const cx = a.x + dx * t, cy = a.y + dy * t;
      const d = Math.hypot(px - cx, py - cy);
      if (d < best) { best = d; bestI = i; bestT = t; }
    }
    return { dist: best, segIndex: bestI, t: bestT };
  }

  // Find a point and tangent direction along the polyline at parametric s ∈ [0,1].
  function pointAt(pts, s) {
    const n = pts.length;
    const total = totalLength(pts);
    let target = (s % 1) * total;
    if (target < 0) target += total;
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (target <= seg) {
        const u = seg ? target / seg : 0;
        return {
          x: a.x + (b.x - a.x) * u,
          y: a.y + (b.y - a.y) * u,
          tangent: Math.atan2(b.y - a.y, b.x - a.x),
        };
      }
      target -= seg;
    }
    return { x: pts[0].x, y: pts[0].y, tangent: 0 };
  }

  function build(generator, args) {
    const pts = normalize(generator.apply(null, args));
    return {
      points: pts,
      length: totalLength(pts),
      distanceTo: (px, py) => distanceToOutline(px, py, pts),
      pointAt: (s) => pointAt(pts, s),
    };
  }

  // Catalog. Difficulty 1 = easiest. startS = where on the outline the needle begins (0..1).
  const SHAPES = [
    {
      id: 'heart',
      name: 'HEART',
      difficulty: 1,
      build: () => build(heart, [220]),
      startS: 0.0,
    },
    {
      id: 'flower',
      name: 'FLOWER',
      difficulty: 2,
      build: () => build(flower, [5, 0.28, 240]),
      startS: 0.0,
    },
    {
      id: 'star',
      name: 'STAR',
      difficulty: 3,
      build: () => build(star, [5, 0.42, 12]),
      startS: 0.0,
    },
  ];

  window.Shapes = { SHAPES, distanceToOutline, totalLength };
})();
