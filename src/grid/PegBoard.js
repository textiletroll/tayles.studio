import { createTextBlock } from '../elements/TextBlock.js';
import { createImageBlock } from '../elements/ImageBlock.js';
import { createSplitBlock } from '../elements/SplitBlock.js';
import { createLineBlock } from '../elements/LineBlock.js';

const elementFactories = {
  text: createTextBlock,
  image: createImageBlock,
  split: createSplitBlock,
  line: createLineBlock,
};

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
    this.background = null;
    this.onParallaxUpdate = null; // optional callback after parallax transforms change
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

    // Scroll animation tracking
    this._animObserver = null;
    this._animObservedIds = new Set();
    this.editModeActive = false;

    this.setup();
  }

  setup() {
    this.container.classList.add('pegboard');
    this.container.style.setProperty('--pg-columns', this.columns);
    this.container.style.setProperty('--pg-gap', `${this.gap}px`);
    this._gridRO.observe(this.container);
    this._syncRowHeight();

    // Background layer (fixed div behind content)
    if (!this._bgEl) {
      this._bgEl = document.createElement('div');
      this._bgEl.id = 'pg-bg';
      document.body.prepend(this._bgEl);
      this._onScroll = () => this._applyParallaxScroll();
      window.addEventListener('scroll', this._onScroll, { passive: true });
    }
  }

  _syncRowHeight() {
    const w = this.container.clientWidth;
    if (w === 0) return;
    const colWidth = (w - (this.columns - 1) * this.gap) / this.columns;
    this.rowHeight = Math.round(colWidth);
    this.container.style.setProperty('--pg-row-height', `${this.rowHeight}px`);
  }

  /** Column width in pixels (matches CSS grid layout — gap-aware). */
  _cellWidth() {
    const w = this.container.clientWidth;
    if (w === 0) return 0;
    return (w - (this.columns - 1) * this.gap) / this.columns;
  }

  /** Convert grid-cell coords to pixels relative to the grid container's
      content box. Integer values map exactly to grid lines / panel edges. */
  gridToPixel(x, y) {
    const cellW = this._cellWidth();
    return {
      x: x * (cellW + this.gap),
      y: y * (this.rowHeight + this.gap),
    };
  }

  /** Inverse of gridToPixel. */
  pixelToGrid(px, py) {
    const cellW = this._cellWidth();
    return {
      x: cellW + this.gap === 0 ? 0 : px / (cellW + this.gap),
      y: this.rowHeight + this.gap === 0 ? 0 : py / (this.rowHeight + this.gap),
    };
  }

  addElement(config) {
    const wrapper = document.createElement('div');
    wrapper.classList.add('peg-element');
    wrapper.dataset.id = config.id;
    wrapper.dataset.type = config.type;

    wrapper.style.gridColumn = `${config.gridColumn} / span ${config.colSpan || 1}`;
    wrapper.style.gridRow = `${config.gridRow} / span ${config.rowSpan || 1}`;

    // Layer system: 1 (front) to 10 (back). Maps to z-index 10→1.
    if (!config.layer) config.layer = 1;
    this._applyLayerStyle(wrapper, config);

    const factory = elementFactories[config.type];
    if (!factory) {
      console.warn(`Unknown element type: ${config.type}`);
      return;
    }

    const element = factory(config.content);
    wrapper.appendChild(element);

    // If this element has an entrance animation, hide it immediately so it
    // never flashes on screen before the scroll trigger fires.
    const a = config.animation;
    if (!this.editModeActive && a && a.enabled && a.entrance && a.entrance !== 'none') {
      wrapper.dataset.animState = 'hidden';
    }

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

    // Lines are transparent overlays — skip all panel-style decoration
    if (config.type === 'line') {
      this._applyLine(wrapper, config);
      this._shapeRO.observe(wrapper);
      return;
    }

    // Border — outline straddles the grid edge (half outside, half inside) so
    // line elements at the same coord overlap it. No corner gaps like box-shadow.
    wrapper.style.boxShadow = '';
    wrapper.style.border = 'none';
    if (s.borderShow === false) {
      wrapper.style.outline = 'none';
    } else {
      const bw = s.borderWidth ?? 1;
      const bc = s.borderColor || '#1e1e1e';
      wrapper.style.outline = `${bw}px solid ${bc}`;
      wrapper.style.outlineOffset = `${-bw / 2}px`;
    }

    // Border radius
    wrapper.style.borderRadius = `${s.borderRadius ?? 8}px`;

    // Opacity
    wrapper.style.opacity = s.opacity ?? 1;

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

    // Text panels always clip overflow — the panel acts as a viewport for the text frame
    if (config.type === 'text') {
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

    // Custom shape — shapes use SVG borders, so hide the outline border
    const shape = s.shape;
    if (shape && shape.preset === 'circle') {
      wrapper.style.outline = 'none';
      this._applyCircleShape(wrapper, config);
      this._shapeRO.observe(wrapper);
    } else if (shape && shape.anchors && shape.anchors.length >= 3) {
      wrapper.style.outline = 'none';
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

    // Straddle the anchor edge: clip to an outset polygon (bw/2 outward) so
    // the border's outer half extends past the anchor line. The inner ring
    // edge is inset bw/2 inward. Total ring thickness = bw, centered on the
    // original anchor polygon — matching how rectangle borders now straddle
    // their grid-cell edge and aligning with lines at the same coord.
    const bw = s.borderShow !== false ? (s.borderWidth ?? 1) : 0;
    const half = bw / 2;
    const outerPts = half > 0 ? this._insetPolygon(pts, -half) : pts;
    const outerPathD = this._roundedPolygonPath(
      outerPts.length >= 3 ? outerPts : pts,
      radius,
    );
    const clipPathD = outerPathD;

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
    clipPathEl.setAttribute('d', clipPathD);
    clipPath.appendChild(clipPathEl);

    defs.appendChild(clipPath);
    clipSvg.appendChild(defs);
    wrapper.appendChild(clipSvg);

    // Apply clip-path
    wrapper.style.clipPath = `url(#${clipId})`;
    wrapper.style.borderRadius = '0';

    // Border overlay — filled ring between outset outer and inset inner
    if (s.borderShow !== false) {
      const bc = s.borderColor || '#1e1e1e';

      const innerInsetPts = this._insetPolygon(pts, half);
      const innerPathD = innerInsetPts.length >= 3
        ? this._roundedPolygonPath(innerInsetPts, radius)
        : '';

      const borderSvg = document.createElementNS(ns, 'svg');
      borderSvg.classList.add('shape-border-overlay');
      borderSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);

      const borderPath = document.createElementNS(ns, 'path');
      // Outer CW + inner CCW via reversed inner path → evenodd fills the ring
      borderPath.setAttribute('d', outerPathD + ' ' + this._reversePath(innerPathD));
      borderPath.setAttribute('fill', bc);
      borderPath.setAttribute('fill-rule', 'evenodd');
      borderSvg.appendChild(borderPath);
      wrapper.appendChild(borderSvg);
    }

    // Clear box-shadow since SVG border replaces it
    wrapper.style.boxShadow = 'none';

    // Shape-aware content padding: push inline children (text/image/split)
    // inward to the shape's inscribed cross-rectangle at center so content
    // doesn't get chopped by asymmetric dips in the shape outline.
    this._applyShapePadding(wrapper, pts, w, h);
  }

  /**
   * Compute the shape's inscribed rectangle at center (vertical slice at
   * center-x, horizontal slice at center-y) and apply it as padding to the
   * content child so inline text sits within the visible shape region.
   */
  _applyShapePadding(wrapper, pts, w, h) {
    const cx = w / 2;
    const cy = h / 2;
    let topY = 0;
    let botY = h;
    let leftX = 0;
    let rightX = w;

    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];

      // Edge crosses vertical line x = cx?
      if (a.x !== b.x && (a.x - cx) * (b.x - cx) <= 0) {
        const t = (cx - a.x) / (b.x - a.x);
        const y = a.y + t * (b.y - a.y);
        if (y < cy) topY = Math.max(topY, y);
        else botY = Math.min(botY, y);
      }

      // Edge crosses horizontal line y = cy?
      if (a.y !== b.y && (a.y - cy) * (b.y - cy) <= 0) {
        const t = (cy - a.y) / (b.y - a.y);
        const x = a.x + t * (b.x - a.x);
        if (x < cx) leftX = Math.max(leftX, x);
        else rightX = Math.min(rightX, x);
      }
    }

    const padTop = Math.max(0, topY);
    const padBot = Math.max(0, h - botY);
    const padLeft = Math.max(0, leftX);
    const padRight = Math.max(0, w - rightX);

    const child = wrapper.querySelector('.block-text, .block-image, .block-split');
    if (!child) return;
    // Combine with the child's base padding via CSS max() so the shape
    // padding never makes the inside smaller than the normal aesthetic.
    const base = 'clamp(0.35rem, 4cqi, 1.5rem)';
    child.style.paddingTop = `max(${base}, ${padTop}px)`;
    child.style.paddingBottom = `max(${base}, ${padBot}px)`;
    child.style.paddingLeft = `max(${base}, ${padLeft}px)`;
    child.style.paddingRight = `max(${base}, ${padRight}px)`;
  }

  _applyCircleShape(wrapper, config) {
    wrapper.querySelectorAll('.shape-clip-defs, .shape-border-overlay').forEach(el => el.remove());

    const s = config.style || {};
    const w = wrapper.offsetWidth;
    const h = wrapper.offsetHeight;
    if (w === 0 || h === 0) return;

    // Straddle the wrapper edge: expand the clip ellipse outward by bw/2 so
    // the outer half of the border stroke isn't clipped.
    const bwc = s.borderShow !== false ? (s.borderWidth ?? 1) : 0;
    const halfc = bwc / 2;
    wrapper.style.clipPath = halfc > 0
      ? `ellipse(${w / 2 + halfc}px ${h / 2 + halfc}px at 50% 50%)`
      : 'ellipse(50% 50% at 50% 50%)';
    wrapper.style.borderRadius = '0';

    // Border overlay — ellipse ring centered on the wrapper edge
    if (s.borderShow !== false) {
      const bc = s.borderColor || '#1e1e1e';
      const ns = 'http://www.w3.org/2000/svg';

      const borderSvg = document.createElementNS(ns, 'svg');
      borderSvg.classList.add('shape-border-overlay');
      borderSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);

      const ellipse = document.createElementNS(ns, 'ellipse');
      ellipse.setAttribute('cx', w / 2);
      ellipse.setAttribute('cy', h / 2);
      ellipse.setAttribute('rx', w / 2);
      ellipse.setAttribute('ry', h / 2);
      ellipse.setAttribute('fill', 'none');
      ellipse.setAttribute('stroke', bc);
      ellipse.setAttribute('stroke-width', bwc);
      borderSvg.appendChild(ellipse);
      wrapper.appendChild(borderSvg);
    }

    wrapper.style.boxShadow = 'none';
  }

  _clearShape(wrapper) {
    wrapper.querySelectorAll('.shape-clip-defs, .shape-border-overlay').forEach(el => el.remove());
    wrapper.style.clipPath = '';
    const child = wrapper.querySelector('.block-text, .block-image, .block-split');
    if (child) {
      child.style.paddingTop = '';
      child.style.paddingBottom = '';
      child.style.paddingLeft = '';
      child.style.paddingRight = '';
    }
  }

  /**
   * Render a line element's SVG path from its anchor list.
   * Anchors are in absolute grid-cell units (0..colSpan, 0..rowSpan).
   */
  _applyLine(wrapper, config) {
    const svg = wrapper.querySelector('.line-svg');
    if (!svg) return;

    const s = config.style || {};
    const content = config.content || {};
    const anchors = content.anchors || [];

    const w = wrapper.offsetWidth;
    const h = wrapper.offsetHeight;

    // Strip old children
    while (svg.firstChild) svg.firstChild.remove();

    // Wrapper decorations off
    wrapper.style.boxShadow = 'none';
    wrapper.style.background = '';
    wrapper.style.border = 'none';
    wrapper.style.clipPath = '';
    wrapper.style.borderRadius = '0';
    wrapper.style.opacity = s.opacity ?? 1;

    if (w === 0 || h === 0 || anchors.length < 2) return;

    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

    // Gap-aware mapping: integer grid-line coords land exactly on panel edges.
    const pts = anchors.map(a => this.gridToPixel(a.x, a.y));

    const d = s.smooth ? this._smoothPolyline(pts) : this._sharpPolyline(pts);

    const ns = 'http://www.w3.org/2000/svg';
    const path = document.createElementNS(ns, 'path');
    path.classList.add('line-path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', s.borderColor || '#e8e8e8');
    path.setAttribute('stroke-width', s.borderWidth ?? 2);
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  }

  _sharpPolyline(pts) {
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  }

  /** Chaikin-style smoothing: use original points as quadratic control points,
      endpoints as midpoints between successive anchors. */
  _smoothPolyline(pts) {
    if (pts.length < 3) return this._sharpPolyline(pts);
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i].x + pts[i + 1].x) / 2;
      const my = (pts[i].y + pts[i + 1].y) / 2;
      d += ` Q${pts[i].x},${pts[i].y} ${mx},${my}`;
    }
    const last = pts[pts.length - 1];
    d += ` L${last.x},${last.y}`;
    return d;
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
      this.gap = layout.grid.gap ?? this.gap;
      this.setup();
    }
    this.background = layout.background || null;
    this.applyBackground();
    layout.elements.forEach((el) => {
      // Migrate legacy zIndex → layer
      if (el.zIndex != null && !el.layer) {
        el.layer = Math.max(1, Math.min(10, el.zIndex <= 0 ? 10 : 11 - el.zIndex));
        delete el.zIndex;
      }
      this.addElement(el);
    });
    this.setupScrollAnimations();
  }

  getLayoutData() {
    const elements = [];
    this.elements.forEach(({ config }) => elements.push(config));
    const data = {
      grid: {
        columns: this.columns,
        rowHeight: this.rowHeight,
        gap: this.gap,
      },
      elements,
    };
    if (this.background) data.background = this.background;
    return data;
  }

  /**
   * Apply the background config to the #pg-bg layer.
   * Supports: solid, gradient (linear), animated (flow / aurora presets).
   */
  applyBackground() {
    const el = this._bgEl;
    if (!el) return;

    el.style.animation = '';
    el.style.backgroundSize = '';
    el.style.backgroundImage = '';
    el.style.backgroundColor = '';

    const bg = this.background;
    if (!bg) { this._applyParallaxScroll(); return; }

    const color1 = bg.color1 || '#0a0a0a';
    const color2 = bg.color2 || '#1a1a3a';
    const angle = bg.angle ?? 135;

    if (bg.type === 'solid') {
      el.style.backgroundColor = color1;
    } else if (bg.type === 'gradient') {
      el.style.backgroundImage = `linear-gradient(${angle}deg, ${color1}, ${color2})`;
    } else if (bg.type === 'animated') {
      const preset = bg.preset || 'flow';
      el.style.backgroundImage = `linear-gradient(${angle}deg, ${color1}, ${color2}, ${color1})`;
      el.style.backgroundSize = '400% 400%';
      el.style.animation = preset === 'aurora'
        ? 'bg-aurora 25s linear infinite'
        : 'bg-flow 20s ease-in-out infinite';
    }

    this._applyParallaxScroll();
  }

  // ── Scroll animations ──

  /** Set up scroll-triggered animations. Uses grid rows as trigger points. */
  setupScrollAnimations() {
    // Remove previous scroll listener
    if (this._animScrollHandler) {
      window.removeEventListener('scroll', this._animScrollHandler);
      this._animScrollHandler = null;
    }

    if (this.editModeActive) {
      // In edit mode, make everything visible and un-animated
      this.elements.forEach(({ wrapper }) => {
        delete wrapper.dataset.animState;
        delete wrapper.dataset.scrollPlayed;
        wrapper.style.animation = '';
      });
      return;
    }

    // Collect animated elements and set initial state
    const animated = [];
    this.elements.forEach(({ config, wrapper }) => {
      const a = config.animation;
      if (!a || !a.enabled) return;
      // Default trigger row = the element's own row (animates when it scrolls into view)
      if (a.triggerRow == null) a.triggerRow = config.gridRow;
      if (a.entrance && a.entrance !== 'none') {
        wrapper.dataset.animState = 'hidden';
        wrapper.style.animation = '';
      }
      // Reset scroll effect state
      delete wrapper.dataset.scrollPlayed;
      animated.push({ config, wrapper });
    });

    if (animated.length === 0) return;

    const checkScroll = () => {
      // The pixel offset of the viewport's bottom edge relative to the grid container top
      const containerTop = this.container.getBoundingClientRect().top + window.scrollY;
      const viewportBottom = window.scrollY + window.innerHeight;
      const scrollIntoGrid = viewportBottom - containerTop;
      // Convert to grid row number (1-based)
      const rowH = this.rowHeight + this.gap;
      const revealedRow = rowH > 0 ? Math.floor(scrollIntoGrid / rowH) + 1 : 999;

      for (const entry of animated) {
        const a = entry.config.animation;
        const triggerRow = a.triggerRow ?? entry.config.gridRow;
        const scrollRow = a.scrollTriggerRow ?? triggerRow;
        const state = entry.wrapper.dataset.animState;

        // Exit row only applies when explicitly set and above entrance row
        const exitRow = (a.exitTriggerRow != null && a.exitTriggerRow > triggerRow)
          ? a.exitTriggerRow : null;

        // Visible zone: from entrance row up to (but not including) exit row.
        // When no exit row is set, visible zone is unbounded above.
        const inVisibleZone = revealedRow >= triggerRow
          && (exitRow == null || revealedRow < exitRow);

        if (inVisibleZone) {
          if (state === 'hidden' || state === 'exited') {
            this._playEntrance(entry);
          }
        } else {
          if (state === 'visible' || state === 'entering') {
            this._playExit(entry);
          }
        }

        // Scroll effect — plays once when scrollTriggerRow is reached, resets when above
        if (a.scroll && a.scroll !== 'none') {
          if (revealedRow >= scrollRow) {
            if (!entry.wrapper.dataset.scrollPlayed) {
              this._playScrollEffect(entry);
            }
          } else {
            // Reset so it replays on next scroll-down
            delete entry.wrapper.dataset.scrollPlayed;
          }
        }
      }
    };

    this._animScrollHandler = checkScroll;
    window.addEventListener('scroll', this._animScrollHandler, { passive: true });
    // Run once immediately to handle elements already in view
    checkScroll();
  }

  _playEntrance(entry) {
    const { config, wrapper } = entry;
    const anim = config.animation;
    if (!anim || !anim.entrance || anim.entrance === 'none') {
      wrapper.dataset.animState = 'visible';
      return;
    }
    const state = wrapper.dataset.animState;
    if (state === 'visible' || state === 'entering') return;

    const dur = anim.entranceDuration ?? anim.duration ?? 0.6;
    wrapper.dataset.animState = 'entering';
    wrapper.style.animation = `anim-${anim.entrance} ${dur}s ease both`;
    wrapper.addEventListener('animationend', () => {
      wrapper.dataset.animState = 'visible';
      wrapper.style.animation = '';
    }, { once: true });
  }

  _playExit(entry) {
    const { config, wrapper } = entry;
    const anim = config.animation;
    if (!anim || !anim.exit || anim.exit === 'none') {
      // No exit animation — panel stays visible
      return;
    }
    const state = wrapper.dataset.animState;
    if (state === 'hidden' || state === 'exited' || state === 'exiting') return;

    const dur = anim.exitDuration ?? anim.duration ?? 0.6;
    wrapper.dataset.animState = 'exiting';
    wrapper.style.animation = `anim-${anim.exit} ${dur}s ease both`;
    wrapper.addEventListener('animationend', () => {
      wrapper.dataset.animState = 'exited';
      wrapper.style.animation = '';
    }, { once: true });
  }

  _playScrollEffect(entry) {
    const { config, wrapper } = entry;
    const anim = config.animation;
    if (!anim || !anim.scroll || anim.scroll === 'none') return;
    wrapper.dataset.scrollPlayed = '1';
    const dur = anim.scrollDuration ?? anim.duration ?? 0.6;
    wrapper.style.animation = '';
    void wrapper.offsetWidth; // force reflow to restart if same animation
    wrapper.style.animation = `anim-${anim.scroll} ${dur}s ease both`;
    wrapper.addEventListener('animationend', () => {
      wrapper.style.animation = '';
    }, { once: true });
  }

  /** Apply z-index and data-layer attribute for a wrapper based on its config.layer. */
  _applyLayerStyle(wrapper, config) {
    const layer = config.layer || 1;
    wrapper.style.zIndex = 11 - layer; // layer 1 → z-index 10, layer 10 → z-index 1
    wrapper.dataset.layer = layer;
  }

  /** Update a single element's layer and re-apply parallax. */
  setLayer(id, layer) {
    const entry = this.elements.get(id);
    if (!entry) return;
    entry.config.layer = Math.max(1, Math.min(10, layer));
    this._applyLayerStyle(entry.wrapper, entry.config);
    this._applyParallaxScroll();
  }

  /** Shift bg layer and all panel layers based on scroll + parallax depth. */
  _applyParallaxScroll() {
    // Disable parallax in edit mode so panels stay aligned with the grid
    if (this.editModeActive) {
      if (this._bgEl) this._bgEl.style.transform = '';
      this.elements.forEach(({ wrapper }) => { wrapper.style.translate = ''; });
      if (this.onParallaxUpdate) this.onParallaxUpdate();
      return;
    }

    const bgDepth = (this.background && this.background.parallax) || 0;

    // Background layer
    if (this._bgEl) {
      if (bgDepth === 0) {
        this._bgEl.style.transform = '';
      } else {
        const y = window.scrollY * bgDepth * -0.5;
        this._bgEl.style.transform = `translateY(${y}px)`;
      }
    }

    // Panel layers: layer 1 = no shift, layer 10 = max shift (approaching bg parallax)
    // Uses `translate` property (not `transform`) to avoid conflicts with animations.
    if (bgDepth === 0) {
      this.elements.forEach(({ wrapper }) => { wrapper.style.translate = ''; });
    } else {
      this.elements.forEach(({ config, wrapper }) => {
        const layer = config.layer || 1;
        // fraction: layer 1 → 0, layer 10 → 0.9 (never quite as much as bg)
        const fraction = (layer - 1) / 10;
        const y = window.scrollY * bgDepth * fraction * -0.5;
        wrapper.style.translate = y === 0 ? '' : `0 ${y}px`;
      });
    }
    if (this.onParallaxUpdate) this.onParallaxUpdate();
  }
}
