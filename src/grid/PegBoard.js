import { createTextBlock } from '../elements/TextBlock.js';
import { createImageBlock } from '../elements/ImageBlock.js';
import { createSplitBlock } from '../elements/SplitBlock.js';

const elementFactories = {
  text: createTextBlock,
  image: createImageBlock,
  split: createSplitBlock,
};

/** Compose a CSS transform string from a style object's rotation/flipX/flipY. */
export function composeTransform(style) {
  const rot = style?.rotation || 0;
  const sx = style?.flipX ? -1 : 1;
  const sy = style?.flipY ? -1 : 1;
  const parts = [];
  if (sx !== 1 || sy !== 1) parts.push(`scale(${sx}, ${sy})`);
  if (rot !== 0) parts.push(`rotate(${rot}deg)`);
  return parts.join(' ');
}

/**
 * Compute the axis-aligned bounding box of a shape in grid-local units.
 * Returns { x, y, w, h } where all values are in grid cells.
 * For unshaped or circle-preset panels, returns the full footprint.
 */
export function computeShapeBBox(config) {
  const colSpan = config.colSpan || 1;
  const rowSpan = config.rowSpan || 1;
  const shape = config.style?.shape;
  if (!shape || shape.preset === 'circle' || !shape.anchors || shape.anchors.length < 3) {
    return { x: 0, y: 0, w: colSpan, h: rowSpan };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const a of shape.anchors) {
    if (a.x < minX) minX = a.x;
    if (a.x > maxX) maxX = a.x;
    if (a.y < minY) minY = a.y;
    if (a.y > maxY) maxY = a.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export class PegBoard {
  constructor(container, options = {}) {
    this.container = container;
    this.columns = options.columns || 12;
    this.rowHeight = options.rowHeight || 100;
    this.gap = options.gap || 16;
    this.elements = new Map();
    this._shapeSizes = new Map(); // track last rendered size per element
    this._shapeRO = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const id = entry.target.dataset.id;
        if (!id) continue;
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        const key = `${w},${h}`;
        if (this._shapeSizes.get(id) !== key) {
          this._shapeSizes.set(id, key);
          this.applyDesign(id);
        }
      }
    });

    // Keep row height in sync with column width for square cells
    this._gridRO = new ResizeObserver(() => this._syncRowHeight());

    this.setup();
  }

  setup() {
    this.container.classList.add('pegboard');
    this.container.style.setProperty('--pg-columns', this.columns);
    this.container.style.setProperty('--pg-gap', `${this.gap}px`);
    this._gridRO.observe(this.container);
    this._syncRowHeight();
  }

  _syncRowHeight() {
    const w = this.container.clientWidth;
    if (w === 0) return;
    const colWidth = (w - (this.columns - 1) * this.gap) / this.columns;
    this.rowHeight = Math.round(colWidth);
    this.container.style.setProperty('--pg-row-height', `${this.rowHeight}px`);
  }

  addElement(config) {
    const wrapper = document.createElement('div');
    wrapper.classList.add('peg-element');
    wrapper.dataset.id = config.id;
    wrapper.dataset.type = config.type;

    wrapper.style.gridColumn = `${config.gridColumn} / span ${config.colSpan || 1}`;
    wrapper.style.gridRow = `${config.gridRow} / span ${config.rowSpan || 1}`;
    if (config.zIndex != null) wrapper.style.zIndex = config.zIndex;

    const factory = elementFactories[config.type];
    if (!factory) {
      console.warn(`Unknown element type: ${config.type}`);
      return;
    }

    const element = factory(config.content);
    wrapper.appendChild(element);
    this.container.appendChild(wrapper);
    this.elements.set(config.id, { config, wrapper, element });

    this.applyDesign(config.id);
  }

  removeElement(id) {
    const entry = this.elements.get(id);
    if (entry) {
      this._shapeRO.unobserve(entry.wrapper);
      this._shapeSizes.delete(id);
      entry.wrapper.remove();
      this.elements.delete(id);
    }
  }

  /** Re-render an element's inner content from its current config. */
  rebuildElement(id) {
    const entry = this.elements.get(id);
    if (!entry) return;
    const { config, wrapper } = entry;

    if (entry.element) {
      entry.element.remove();
    }

    const factory = elementFactories[config.type];
    if (!factory) return;

    const element = factory(config.content);
    wrapper.insertBefore(element, wrapper.firstChild);
    entry.element = element;

    this.applyDesign(id);
  }

  /** Apply design styles from config.style to the wrapper element. */
  applyDesign(id) {
    const entry = this.elements.get(id);
    if (!entry) return;
    const { config, wrapper } = entry;
    const s = config.style || {};

    // Border (inset box-shadow so inner radius matches outer)
    wrapper.style.border = 'none';
    if (s.borderShow === false) {
      wrapper.style.boxShadow = 'none';
    } else {
      const bw = s.borderWidth ?? 1;
      const bc = s.borderColor || '#1e1e1e';
      wrapper.style.boxShadow = `inset 0 0 0 ${bw}px ${bc}`;
    }

    // Border radius
    wrapper.style.borderRadius = `${s.borderRadius ?? 8}px`;

    // Opacity
    wrapper.style.opacity = s.opacity ?? 1;

    // Transform — rotation in 90° steps + flips
    wrapper.style.transform = composeTransform(s);

    // Background color — split panels use per-side colors instead
    if (config.type === 'split') {
      wrapper.style.background = '';
    } else if (s.bgColor) {
      wrapper.style.background = s.bgColor;
    } else {
      wrapper.style.background = '';
    }

    // Text color
    if (s.textColor) {
      wrapper.style.color = s.textColor;
    } else {
      wrapper.style.color = '';
    }

    // Clip frame — hide text that overflows the panel
    if (config.content?.clipFrame) {
      wrapper.style.overflow = 'hidden';
    } else {
      wrapper.style.overflow = '';
    }

    // Split side opacity and background
    if (config.type === 'split') {
      const left = wrapper.querySelector('.split-left');
      const right = wrapper.querySelector('.split-right');
      if (left) {
        left.style.opacity = s.leftOpacity ?? 1;
        left.style.background = s.leftBgColor && s.leftBgColor !== 'transparent'
          ? s.leftBgColor
          : '';
      }
      if (right) {
        right.style.opacity = s.rightOpacity ?? 1;
        right.style.background = s.rightBgColor && s.rightBgColor !== 'transparent'
          ? s.rightBgColor
          : '';
      }
    }

    // Custom shape
    const shape = s.shape;
    if (shape && shape.preset === 'circle') {
      this._applyCircleShape(wrapper, config);
      this._shapeRO.observe(wrapper);
    } else if (shape && shape.anchors && shape.anchors.length >= 3) {
      this._applyShape(wrapper, config);
      this._shapeRO.observe(wrapper);
    } else {
      this._clearShape(wrapper);
      this._shapeRO.unobserve(wrapper);
    }
  }

  _applyShape(wrapper, config) {
    // Remove previous shape SVGs
    wrapper.querySelectorAll('.shape-clip-defs, .shape-border-overlay').forEach(el => el.remove());

    const s = config.style || {};
    const shape = s.shape;
    const anchors = shape.anchors;
    const colSpan = config.colSpan || 1;
    const rowSpan = config.rowSpan || 1;
    const ns = 'http://www.w3.org/2000/svg';

    const w = wrapper.offsetWidth;
    const h = wrapper.offsetHeight;
    if (w === 0 || h === 0) return;

    // Convert anchors to pixel coordinates
    const pts = anchors.map(a => ({
      x: (a.x / colSpan) * w,
      y: (a.y / rowSpan) * h,
    }));

    // Build the path — rounded corners when smooth is on
    const radius = shape.smooth ? (s.borderRadius ?? 8) : 0;
    const pathD = this._roundedPolygonPath(pts, radius);

    // Clip shape (userSpaceOnUse with pixel coords)
    const clipId = `shape-${config.id}`;
    const clipSvg = document.createElementNS(ns, 'svg');
    clipSvg.classList.add('shape-clip-defs');
    clipSvg.setAttribute('width', '0');
    clipSvg.setAttribute('height', '0');

    const defs = document.createElementNS(ns, 'defs');
    const clipPath = document.createElementNS(ns, 'clipPath');
    clipPath.setAttribute('id', clipId);

    const clipPathEl = document.createElementNS(ns, 'path');
    clipPathEl.setAttribute('d', pathD);
    clipPath.appendChild(clipPathEl);

    defs.appendChild(clipPath);
    clipSvg.appendChild(defs);
    wrapper.appendChild(clipSvg);

    // Apply clip-path
    wrapper.style.clipPath = `url(#${clipId})`;
    wrapper.style.borderRadius = '0';

    // Border overlay — filled ring between outer shape and inset shape
    if (s.borderShow !== false) {
      const bw = s.borderWidth ?? 1;
      const bc = s.borderColor || '#1e1e1e';

      const insetPts = this._insetPolygon(pts, bw);
      const insetRadius = radius;  // inner corners match outer rounding
      const innerPathD = insetPts.length >= 3
        ? this._roundedPolygonPath(insetPts, insetRadius)
        : '';

      const borderSvg = document.createElementNS(ns, 'svg');
      borderSvg.classList.add('shape-border-overlay');
      borderSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);

      const borderPath = document.createElementNS(ns, 'path');
      // Outer CW + inner CCW via reversed inner path → evenodd fills the ring
      borderPath.setAttribute('d', pathD + ' ' + this._reversePath(innerPathD));
      borderPath.setAttribute('fill', bc);
      borderPath.setAttribute('fill-rule', 'evenodd');
      borderSvg.appendChild(borderPath);
      wrapper.appendChild(borderSvg);
    }

    // Clear box-shadow since SVG border replaces it
    wrapper.style.boxShadow = 'none';
  }

  _applyCircleShape(wrapper, config) {
    wrapper.querySelectorAll('.shape-clip-defs, .shape-border-overlay').forEach(el => el.remove());

    const s = config.style || {};
    const w = wrapper.offsetWidth;
    const h = wrapper.offsetHeight;
    if (w === 0 || h === 0) return;

    // Perfect ellipse clip
    wrapper.style.clipPath = 'ellipse(50% 50% at 50% 50%)';
    wrapper.style.borderRadius = '0';

    // Border overlay — ellipse ring
    if (s.borderShow !== false) {
      const bw = s.borderWidth ?? 1;
      const bc = s.borderColor || '#1e1e1e';
      const ns = 'http://www.w3.org/2000/svg';

      const borderSvg = document.createElementNS(ns, 'svg');
      borderSvg.classList.add('shape-border-overlay');
      borderSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);

      const ellipse = document.createElementNS(ns, 'ellipse');
      ellipse.setAttribute('cx', w / 2);
      ellipse.setAttribute('cy', h / 2);
      ellipse.setAttribute('rx', w / 2 - bw / 2);
      ellipse.setAttribute('ry', h / 2 - bw / 2);
      ellipse.setAttribute('fill', 'none');
      ellipse.setAttribute('stroke', bc);
      ellipse.setAttribute('stroke-width', bw);
      borderSvg.appendChild(ellipse);
      wrapper.appendChild(borderSvg);
    }

    wrapper.style.boxShadow = 'none';
  }

  _clearShape(wrapper) {
    wrapper.querySelectorAll('.shape-clip-defs, .shape-border-overlay').forEach(el => el.remove());
    wrapper.style.clipPath = '';
  }

  /**
   * Build a closed polygon path with optional rounded corners.
   * When radius > 0, each corner is replaced by a quadratic bezier
   * that curves through the corner point, staying inside the polygon.
   */
  _roundedPolygonPath(pts, radius) {
    const n = pts.length;
    if (n < 3) return '';

    if (radius <= 0) {
      // Sharp polygon
      return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ') + ' Z';
    }

    const get = (i) => pts[((i % n) + n) % n];
    let d = '';

    for (let i = 0; i < n; i++) {
      const prev = get(i - 1);
      const curr = get(i);
      const next = get(i + 1);

      // Vectors from curr toward prev and next
      const dx1 = prev.x - curr.x, dy1 = prev.y - curr.y;
      const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);

      if (len1 === 0 || len2 === 0) continue;

      // Clamp radius to half of shortest adjacent edge
      const r = Math.min(radius, len1 / 2, len2 / 2);

      // Points where rounding starts/ends
      const startX = curr.x + (dx1 / len1) * r;
      const startY = curr.y + (dy1 / len1) * r;
      const endX = curr.x + (dx2 / len2) * r;
      const endY = curr.y + (dy2 / len2) * r;

      if (i === 0) {
        d = `M${startX},${startY}`;
      } else {
        d += ` L${startX},${startY}`;
      }
      // Quadratic bezier with control point at the original corner
      d += ` Q${curr.x},${curr.y} ${endX},${endY}`;
    }

    d += ' Z';
    return d;
  }

  /** Shrink a polygon inward by `offset` pixels. */
  _insetPolygon(pts, offset) {
    const n = pts.length;
    if (n < 3) return [];

    const get = (i) => pts[((i % n) + n) % n];

    // Compute inward normals for each edge (CW winding in screen coords)
    const normals = [];
    for (let i = 0; i < n; i++) {
      const curr = get(i);
      const next = get(i + 1);
      const dx = next.x - curr.x;
      const dy = next.y - curr.y;
      const len = Math.sqrt(dx * dx + dy * dy);
      if (len === 0) {
        normals.push({ x: 0, y: 0 });
      } else {
        // Inward normal for CW winding: (-dy, dx) / len
        normals.push({ x: -dy / len, y: dx / len });
      }
    }

    // For each vertex, find intersection of adjacent offset edges
    const result = [];
    for (let i = 0; i < n; i++) {
      const prevIdx = ((i - 1) + n) % n;

      // Offset edge (prevIdx): from get(prevIdx) to get(i), shifted by normals[prevIdx]
      const a1 = {
        x: get(prevIdx).x + normals[prevIdx].x * offset,
        y: get(prevIdx).y + normals[prevIdx].y * offset,
      };
      const d1 = { x: get(i).x - get(prevIdx).x, y: get(i).y - get(prevIdx).y };

      // Offset edge (i): from get(i) to get(i+1), shifted by normals[i]
      const a2 = {
        x: get(i).x + normals[i].x * offset,
        y: get(i).y + normals[i].y * offset,
      };
      const d2 = { x: get(i + 1).x - get(i).x, y: get(i + 1).y - get(i).y };

      // Intersect the two offset lines
      const cross = d1.x * d2.y - d1.y * d2.x;
      if (Math.abs(cross) < 1e-6) {
        // Parallel edges — just offset the vertex directly
        result.push({
          x: get(i).x + normals[i].x * offset,
          y: get(i).y + normals[i].y * offset,
        });
      } else {
        const bx = a2.x - a1.x, by = a2.y - a1.y;
        const t = (bx * d2.y - by * d2.x) / cross;
        result.push({ x: a1.x + t * d1.x, y: a1.y + t * d1.y });
      }
    }
    return result;
  }

  /** Reverse an SVG path's winding order for evenodd fill subtraction. */
  _reversePath(pathD) {
    if (!pathD) return '';
    // Parse path into points, then reconstruct in reverse
    const commands = pathD.match(/[MLQCZ][^MLQCZ]*/gi);
    if (!commands) return '';

    const points = [];
    const curves = []; // store {type, points} for each segment
    let firstPoint = null;

    for (const cmd of commands) {
      const type = cmd[0].toUpperCase();
      const nums = cmd.slice(1).trim().split(/[\s,]+/).map(Number);
      if (type === 'M' || type === 'L') {
        points.push({ x: nums[0], y: nums[1], type: 'L' });
        if (type === 'M') firstPoint = { x: nums[0], y: nums[1] };
      } else if (type === 'Q') {
        points.push({ x: nums[2], y: nums[3], type: 'Q', cx: nums[0], cy: nums[1] });
      } else if (type === 'Z') {
        // skip
      }
    }

    if (points.length === 0) return '';

    // Build reversed path
    const rev = points.slice().reverse();
    let d = `M${rev[0].x},${rev[0].y}`;
    for (let i = 1; i < rev.length; i++) {
      const p = rev[i];
      const prev = rev[i - 1];
      if (prev.type === 'Q') {
        // The Q control point belongs to the segment ending at prev,
        // which in reverse becomes the segment from prev to p
        d += ` Q${prev.cx},${prev.cy} ${p.x},${p.y}`;
      } else {
        d += ` L${p.x},${p.y}`;
      }
    }
    // Handle last→first connection
    if (rev[0].type === 'Q') {
      d += ` Q${rev[0].cx},${rev[0].cy} ${rev[rev.length - 1].x},${rev[rev.length - 1].y}`;
    }
    d += ' Z';
    return d;
  }

  loadLayout(layout) {
    if (layout.grid) {
      this.columns = layout.grid.columns || this.columns;
      this.rowHeight = layout.grid.rowHeight || this.rowHeight;
      this.gap = layout.grid.gap || this.gap;
      this.setup();
    }
    layout.elements.forEach((el) => this.addElement(el));
  }

  getLayoutData() {
    const elements = [];
    this.elements.forEach(({ config }) => elements.push(config));
    return {
      grid: {
        columns: this.columns,
        rowHeight: this.rowHeight,
        gap: this.gap,
      },
      elements,
    };
  }
}
