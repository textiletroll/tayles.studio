import { createTextBlock } from '../elements/TextBlock.js';
import { createImageBlock } from '../elements/ImageBlock.js';
import { createSplitBlock } from '../elements/SplitBlock.js';
import { createLineBlock } from '../elements/LineBlock.js';
import { createViewport } from '../elements/Viewport.js';
import { createPicture } from '../elements/Picture.js';
import { createIframe } from '../elements/Iframe.js';
import { createStitchEffect, createWanderStitchEffect, createPathedStitchEffect } from '../effects/StitchEffect.js';
import { createBorderStitch } from '../effects/BorderStitch.js';
import { STITCH_PALETTES } from '../effects/StitchEffect.js';
import { getTextureUrl } from '../textures/textures.js';

const elementFactories = {
  text: createTextBlock,
  image: createImageBlock,
  split: createSplitBlock,
  line: createLineBlock,
  viewport: createViewport,
  picture: createPicture,
  iframe: createIframe,
};

/**
 * Compute the axis-aligned bounding box of a shape in grid-local units.
 * Returns { x, y, w, h } where all values are in grid cells.
 * For unshaped or circle-preset panels, returns the full footprint.
 */
/**
 * Build a CSS gradient string with optional hard stops and cyclic color
 * rotation. The gradient is "wrapped" by emitting stops outside the 0–100%
 * range — linear-gradient interpolates them and clips to the visible range,
 * which avoids the visible discontinuity that plain stop-shifting would
 * introduce when colors wrap around the loop seam.
 *
 *   faded=true  → smooth blends between adjacent colors (default)
 *   faded=false → hard stops at evenly-spaced boundaries
 *   colorRotate (0..1) → cyclic phase shift along the gradient axis
 */
function buildBgGradient(angle, colors, faded, colorRotate) {
  const N = colors.length;
  if (N < 2) return colors[0] || '#000';
  const r = ((Number(colorRotate) || 0) % 1 + 1) % 1;
  const stops = [];
  for (let i = -2; i <= N + 2; i++) {
    const ci = ((i % N) + N) % N;
    const p = (i / N - r) * 100;
    stops.push({ c: colors[ci], p });
  }
  if (faded) {
    return `linear-gradient(${angle}deg, ${stops.map(s => `${s.c} ${s.p.toFixed(2)}%`).join(', ')})`;
  }
  const hard = [];
  for (let i = 0; i < stops.length - 1; i++) {
    hard.push(`${stops[i].c} ${stops[i].p.toFixed(2)}%`);
    hard.push(`${stops[i].c} ${stops[i + 1].p.toFixed(2)}%`);
  }
  return `linear-gradient(${angle}deg, ${hard.join(', ')})`;
}

/** Resolve the edge-rendering mode for a polygon shape. New field
 *  `shape.edge` ('sharp' | 'rounded' | 'curve') takes precedence. Legacy
 *  `shape.smooth: true` maps to 'curve' (its post-unification meaning), and
 *  `shape.smooth: false`/missing maps to 'sharp'. Exported for the editor UI. */
export function resolveShapeEdge(shape) {
  if (!shape) return 'sharp';
  if (shape.edge === 'sharp' || shape.edge === 'rounded' || shape.edge === 'curve') {
    return shape.edge;
  }
  return shape.smooth ? 'curve' : 'sharp';
}

/** Same tri-state resolver for lines. Reads from `style.edge`, falls back to
 *  legacy `style.smooth` (boolean). 'rounded' for lines uses
 *  `style.borderRadius` as the corner radius. */
export function resolveLineEdge(style) {
  if (!style) return 'sharp';
  if (style.edge === 'sharp' || style.edge === 'rounded' || style.edge === 'curve') {
    return style.edge;
  }
  return style.smooth ? 'curve' : 'sharp';
}

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
    this._zoomFactor = 1;

    this.setup();
  }

  setup() {
    this.container.classList.add('pegboard');
    this.container.style.setProperty('--pg-columns', this.columns);
    this.container.style.setProperty('--pg-gap', `${this.gap}px`);
    this._gridRO.observe(this.container);
    // Window resize catches cases where the container has a fixed width (zoom mode)
    // and the ResizeObserver won't fire when the viewport grows.
    if (!this._onWindowResize) {
      this._onWindowResize = () => this._syncRowHeight();
      window.addEventListener('resize', this._onWindowResize);
    }
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
    // Use parent's content width to avoid feedback loops when zoom is applied
    const parent = this.container.parentElement;
    const available = parent ? parent.clientWidth - parseFloat(getComputedStyle(parent).paddingLeft) - parseFloat(getComputedStyle(parent).paddingRight) : window.innerWidth;
    if (available === 0) return;

    const minCellSize = 18; // minimum usable cell size in px
    const naturalCell = (available - (this.columns - 1) * this.gap) / this.columns;

    if (naturalCell < minCellSize) {
      // Force grid to a design width where cells are usable, then zoom to fit
      const designWidth = this.columns * minCellSize + (this.columns - 1) * this.gap;
      const zoomFactor = available / designWidth;
      this.container.style.width = `${designWidth}px`;
      this.container.style.zoom = zoomFactor;
      this.rowHeight = minCellSize;
      this._zoomFactor = zoomFactor;
    } else {
      this.container.style.width = '';
      this.container.style.zoom = '';
      this.rowHeight = Math.round(naturalCell);
      this._zoomFactor = 1;
    }

    this.container.style.setProperty('--pg-row-height', `${this.rowHeight}px`);

    // Locked panels are pinned via position:fixed at coords measured from the
    // grid layout — re-measure when the grid reflows so they track row-height
    // changes (window resize, zoom mode toggling).
    if (this.elements && this.elements.size) this._applyAllLockedStates();
  }

  /** Column width in pixels (matches CSS grid layout — gap-aware).
   *  When zoom is active, clientWidth reports the unzoomed (design) width,
   *  which is exactly what grid coord math needs. */
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

    const element = factory(config.content, config);
    // Lines render as wrapper-direct SVG; everything else lives inside a
    // wrapper-sized .shape-clip layer that owns the bg + clip-path so frame-
    // positioned content can't escape the shape silhouette.
    let clipLayer = null;
    let borderEl = null;
    if (config.type === 'line' || config.type === 'picture' || config.type === 'iframe') {
      // Pictures: no border overlay, no shape clip — the PNG alpha is the
      // silhouette. Lines: SVG stroke is the border.
      wrapper.appendChild(element);
    } else {
      clipLayer = document.createElement('div');
      clipLayer.classList.add('shape-clip');
      clipLayer.appendChild(element);
      wrapper.appendChild(clipLayer);
      // Border overlay — straddle border via outer+inset box-shadow lives
      // here. See applyDesign for why this exists instead of CSS outline.
      borderEl = document.createElement('div');
      borderEl.classList.add('peg-border');
      wrapper.appendChild(borderEl);
    }

    // If this element has an entrance animation OR a spawn trigger (delay /
    // shifted spawnRow), hide it immediately so it never flashes on screen
    // before its trigger fires. setupScrollAnimations re-asserts the same
    // hidden state after init, but we need it set before the wrapper is
    // appended to avoid a single-frame flash.
    const a = config.animation;
    const hasEntranceAnim = a && a.enabled && a.entrance && a.entrance !== 'none';
    const spawnDelay = Math.max(0, config.spawnDelay ?? a?.entranceDelay ?? 0);
    const spawnRow = config.spawnRow ?? a?.triggerRow ?? config.gridRow;
    const hasSpawnTrigger = spawnDelay > 0 || spawnRow > config.gridRow;
    if (!this.editModeActive && (hasEntranceAnim || hasSpawnTrigger)) {
      wrapper.dataset.animState = 'hidden';
    }

    this.container.appendChild(wrapper);
    this.elements.set(config.id, { config, wrapper, element, clipLayer, borderEl });

    this.applyDesign(config.id);
  }

  removeElement(id) {
    const entry = this.elements.get(id);
    if (entry) {
      this._cancelPendingEntrance(entry);
      if (entry.borderStitch) { entry.borderStitch.destroy(); entry.borderStitch = null; }
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

    // Destroy stitched border so applyDesign can rebuild it from the new content
    if (entry.borderStitch) { entry.borderStitch.destroy(); entry.borderStitch = null; }

    if (entry.element) {
      entry.element.remove();
    }
    // Tear down any existing clip layer — type may have changed (e.g. line ↔ text)
    if (entry.clipLayer) {
      entry.clipLayer.remove();
      entry.clipLayer = null;
    }

    const factory = elementFactories[config.type];
    if (!factory) return;

    const element = factory(config.content, config);
    if (config.type === 'line' || config.type === 'picture' || config.type === 'iframe') {
      wrapper.insertBefore(element, wrapper.firstChild);
      if (entry.borderEl) { entry.borderEl.remove(); entry.borderEl = null; }
    } else {
      const clipLayer = document.createElement('div');
      clipLayer.classList.add('shape-clip');
      clipLayer.appendChild(element);
      wrapper.insertBefore(clipLayer, wrapper.firstChild);
      entry.clipLayer = clipLayer;
      // Ensure border overlay exists (type may have just changed from line)
      if (!entry.borderEl) {
        const borderEl = document.createElement('div');
        borderEl.classList.add('peg-border');
        wrapper.appendChild(borderEl);
        entry.borderEl = borderEl;
      }
    }
    entry.element = element;

    this.applyDesign(id);
  }

  /** Apply design styles from config.style to the wrapper element. */
  applyDesign(id) {
    const entry = this.elements.get(id);
    if (!entry) return;
    const { config, wrapper } = entry;
    const s = config.style || {};

    // Hover lift — applies to all types including lines (drop-shadow follows
    // clip-path shapes and line strokes). Default on for back-compat.
    if (s.hoverLift !== false) {
      wrapper.dataset.hoverLift = '';
    } else {
      delete wrapper.dataset.hoverLift;
    }

    // Lines are transparent overlays — skip all panel-style decoration
    if (config.type === 'line') {
      this._applyLine(wrapper, config);
      this._shapeRO.observe(wrapper);
      this._applyBorderStitch(config.id);
      return;
    }

    // Iframes: minimal — opacity, border-radius (rect-only — no shape support),
    // and rotation on the inner iframe (wrapper transform stays free for
    // scroll animations + parallax, mirroring the picture pattern).
    if (config.type === 'iframe') {
      wrapper.style.boxShadow = '';
      wrapper.style.border = 'none';
      wrapper.style.outline = 'none';
      wrapper.style.background = 'transparent';
      wrapper.style.borderRadius = `${s.borderRadius ?? 0}px`;
      wrapper.style.opacity = s.opacity ?? 1;
      const block = entry.element;
      const frame = block && block.querySelector('iframe');
      if (block) {
        block.style.borderRadius = `${s.borderRadius ?? 0}px`;
      }
      if (frame) {
        const rot = Number(s.rotation) || 0;
        frame.style.transform = rot ? `rotate(${rot}deg)` : '';
      }
      return;
    }

    // Pictures: no border, no shape, no bg, no texture, no border-stitch.
    // Just opacity + rotation (applied to the inner img so wrapper transform
    // stays free for scroll animations).
    if (config.type === 'picture') {
      wrapper.style.boxShadow = '';
      wrapper.style.border = 'none';
      wrapper.style.outline = 'none';
      wrapper.style.background = 'transparent';
      wrapper.style.borderRadius = '';
      wrapper.style.opacity = s.opacity ?? 1;
      const img = entry.element && entry.element.querySelector('img');
      if (img) {
        const fit = (config.content && config.content.fit) || 'contain';
        img.style.objectFit = fit;
        const rot = Number(s.rotation) || 0;
        img.style.transform = rot ? `rotate(${rot}deg)` : '';
      }
      return;
    }

    // ── Border invariant (DO NOT CHANGE without good reason) ──
    // Border is drawn via outer + inset box-shadow on a `.peg-border` overlay
    // sized to the wrapper edge. The two shadows are bw/2 each, so the visible
    // border CENTERS exactly on the wrapper edge — bw/2 outside, bw/2 inside.
    // This is what makes lines (centered SVG strokes at gridToPixel coords)
    // and adjacent panels' borders OVERLAP PIXEL-FOR-PIXEL when placed at the
    // same grid coord. Outline can NOT achieve this — outline-offset positive
    // puts it fully outside, negative puts it fully inside, neither straddles.
    wrapper.style.boxShadow = '';
    wrapper.style.border = 'none';
    wrapper.style.outline = 'none';
    wrapper.style.outlineOffset = '';
    const borderEl = entry.borderEl;
    if (borderEl) {
      if (s.borderShow === false) {
        borderEl.style.boxShadow = 'none';
      } else {
        const bw = s.borderWidth ?? 1;
        const bc = s.borderColor || '#1e1e1e';
        const half = bw / 2;
        // Outer half + inset half → straddle. Both follow border-radius.
        borderEl.style.boxShadow =
          `0 0 0 ${half}px ${bc}, inset 0 0 0 ${half}px ${bc}`;
      }
    }

    // Border radius
    wrapper.style.borderRadius = `${s.borderRadius ?? 8}px`;

    // Opacity
    wrapper.style.opacity = s.opacity ?? 1;

    // Background color — bg always lives on .shape-clip (wrapper-sized layer
    // that owns clip-path for shaped panels), so the wrapper stays unclipped
    // and filter: drop-shadow on hover renders correctly. Wrapper itself stays
    // transparent — its CSS bg is suppressed for clip-layer panels.
    const clipLayer = entry.clipLayer || wrapper.querySelector('.shape-clip');
    wrapper.style.background = 'transparent';
    if (config.type === 'split') {
      if (clipLayer) clipLayer.style.background = '';
    } else {
      if (clipLayer) clipLayer.style.background = s.bgColor || '';
    }
    // Texture — overlay the chosen material pattern on top of the bg color.
    // Procedural tile is generated lazily in textures.js (cached per color).
    // Skipped for split panels (each side has its own bg).
    if (clipLayer && config.type !== 'split') {
      const texType = s.texture && s.texture.type;
      if (texType && texType !== 'none') {
        const url = getTextureUrl(texType, s.bgColor || '#141414');
        if (url) {
          clipLayer.style.backgroundImage = `url(${url})`;
          clipLayer.style.backgroundRepeat = 'repeat';
        } else {
          clipLayer.style.backgroundImage = '';
        }
      } else {
        clipLayer.style.backgroundImage = '';
      }
    }
    // Legacy: clear any bg that was previously set on the content child
    const contentChild = wrapper.querySelector('.block-text, .block-image, .block-split');
    if (contentChild) contentChild.style.background = '';

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

    // Custom shape — shapes use SVG borders, so hide the rect border overlay
    const shape = s.shape;
    if (shape && shape.preset === 'circle') {
      if (borderEl) borderEl.style.boxShadow = 'none';
      this._applyCircleShape(wrapper, config);
      this._shapeRO.observe(wrapper);
    } else if (shape && shape.anchors && shape.anchors.length >= 3) {
      if (borderEl) borderEl.style.boxShadow = 'none';
      this._applyShape(wrapper, config);
      this._shapeRO.observe(wrapper);
    } else {
      this._clearShape(wrapper);
      this._shapeRO.unobserve(wrapper);
    }

    // Stitched border overlay — replaces the native border drawn above.
    // Must run last so it can hide the just-applied outline / SVG overlay.
    this._applyBorderStitch(config.id);
    if (config.style && config.style.borderStitch && config.style.borderStitch.enabled) {
      this._shapeRO.observe(wrapper);
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

    // Build the path. Three edge modes:
    //   'sharp'   → anchor-to-anchor straight edges (default)
    //   'rounded' → straight edges + corners rounded by borderRadius
    //   'curve'   → Chaikin curve through every anchor (matches line smooth)
    // Legacy `shape.smooth: true` maps to 'curve' for backward compat.

    // Clip to the original anchor polygon (no outset). The border ring
    // sits fully inside this clip so containment can't cut it off.
    const bw = s.borderShow !== false ? (s.borderWidth ?? 1) : 0;
    const edge = resolveShapeEdge(shape);
    const radius = edge === 'rounded' ? (s.borderRadius ?? 8) : 0;
    const clipPathD = edge === 'curve'
      ? this._smoothPolygonPath(pts)
      : this._roundedPolygonPath(pts, radius);

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

    // Apply clip-path to the wrapper-sized .shape-clip layer (not the wrapper)
    // so the wrapper stays unclipped and filter: drop-shadow on hover renders
    // fully. Clipping the layer (not the content child) means frame-positioned
    // text inside still gets clipped to the shape silhouette.
    wrapper.style.clipPath = '';
    wrapper.style.borderRadius = '0';
    const clipLayer = wrapper.querySelector('.shape-clip');
    if (clipLayer) {
      clipLayer.style.clipPath = `url(#${clipId})`;
    }

    // Border overlay — filled ring fully inside the clip.
    // Outer edge = anchor polygon, inner edge = inset by full bw.
    if (s.borderShow !== false && bw > 0) {
      const bc = s.borderColor || '#1e1e1e';

      const innerInsetPts = this._insetPolygon(pts, bw);
      const innerPathD = innerInsetPts.length >= 3
        ? (edge === 'curve'
            ? this._smoothPolygonPath(innerInsetPts)
            : this._roundedPolygonPath(innerInsetPts, radius))
        : '';

      const borderSvg = document.createElementNS(ns, 'svg');
      borderSvg.classList.add('shape-border-overlay');
      borderSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);

      const borderPath = document.createElementNS(ns, 'path');
      // Outer CW (anchor polygon) + inner CCW → evenodd fills the ring
      borderPath.setAttribute('d', clipPathD + ' ' + this._reversePath(innerPathD));
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

    // Clip the .shape-clip layer (not the wrapper, not the content child) so
    // frame-positioned text inside is also clipped to the ellipse silhouette
    // and the wrapper stays unclipped for filter: drop-shadow on hover.
    wrapper.style.clipPath = '';
    wrapper.style.borderRadius = '0';
    const clipLayerC = wrapper.querySelector('.shape-clip');
    if (clipLayerC) {
      clipLayerC.style.clipPath = 'ellipse(50% 50% at 50% 50%)';
    }

    // Border overlay — ellipse ring fully inside the clip.
    // Outer stroke edge aligns with clip edge; inner edge is bw inward.
    const bwc = s.borderShow !== false ? (s.borderWidth ?? 1) : 0;
    if (s.borderShow !== false && bwc > 0) {
      const bc = s.borderColor || '#1e1e1e';
      const ns = 'http://www.w3.org/2000/svg';
      const halfc = bwc / 2;

      const borderSvg = document.createElementNS(ns, 'svg');
      borderSvg.classList.add('shape-border-overlay');
      borderSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);

      const ellipse = document.createElementNS(ns, 'ellipse');
      ellipse.setAttribute('cx', w / 2);
      ellipse.setAttribute('cy', h / 2);
      // Inset radii by half the stroke so outer edge sits at w/2, h/2
      ellipse.setAttribute('rx', w / 2 - halfc);
      ellipse.setAttribute('ry', h / 2 - halfc);
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
    const layer = wrapper.querySelector('.shape-clip');
    if (layer) layer.style.clipPath = '';
    const child = wrapper.querySelector('.block-text, .block-image, .block-split');
    if (child) {
      child.style.clipPath = '';
      child.style.background = '';
      child.style.paddingTop = '';
      child.style.paddingBottom = '';
      child.style.paddingLeft = '';
      child.style.paddingRight = '';
    }
  }

  /**
   * Compute the polyline that traces the element's border, in wrapper-local
   * pixel coordinates. Used by the stitched-border overlay so stitches sit
   * exactly where the normal border would.
   *  - rect (no shape):   four corners (with rounded corner sampling if r>0)
   *  - circle preset:     ellipse sampled as a polygon
   *  - polygon shape:     anchor pixel coords
   *  - line:              line anchor pixel coords (open path)
   * Returns { points: [{x,y}], closed: bool } or null if dimensions unready.
   */
  _computeBorderPath(entry) {
    const { config, wrapper } = entry;
    const w = wrapper.clientWidth;
    const h = wrapper.clientHeight;
    if (w === 0 || h === 0) return null;
    const s = config.style || {};

    if (config.type === 'line') {
      const anchors = (config.content && config.content.anchors) || [];
      if (anchors.length < 2) return null;
      // Lines render their SVG with viewBox 0..w / 0..h on the wrapper. Anchors
      // are in absolute grid units; gridToPixel maps to container-local px.
      // For typical lines at grid origin spanning the full grid, those coords
      // match the wrapper-local space — same assumption _applyLine relies on.
      const rawPts = anchors.map(a => this.gridToPixel(a.x, a.y));
      // Match stitch path to the visible edge mode so stitches sit on the
      // actual curve, not on straight chords between anchors.
      const lineEdge = resolveLineEdge(s);
      const r = s.borderRadius ?? 8;
      let points;
      if (lineEdge === 'curve') points = this._sampleSmoothLine(rawPts);
      else if (lineEdge === 'rounded') points = this._sampleRoundedPolyline(rawPts, r);
      else points = rawPts;
      return { points, closed: !!(s.closed || (config.content && config.content.closed)) };
    }

    const shape = s.shape;
    if (shape && shape.preset === 'circle') {
      const cx = w / 2, cy = h / 2;
      const rx = w / 2, ry = h / 2;
      const N = Math.max(48, Math.round((w + h) / 8));
      const points = [];
      for (let i = 0; i < N; i++) {
        const t = (i / N) * Math.PI * 2;
        points.push({ x: cx + Math.cos(t) * rx, y: cy + Math.sin(t) * ry });
      }
      return { points, closed: true };
    }

    if (shape && shape.anchors && shape.anchors.length >= 3) {
      const colSpan = config.colSpan || 1;
      const rowSpan = config.rowSpan || 1;
      const rawPts = shape.anchors.map(a => ({
        x: (a.x / colSpan) * w,
        y: (a.y / rowSpan) * h,
      }));
      // Match stitch path to visible edge mode: 'curve' samples the Chaikin
      // curve, 'rounded' samples each corner's quadratic, 'sharp' uses anchors.
      const edgeMode = resolveShapeEdge(shape);
      let points;
      if (edgeMode === 'curve') {
        points = this._sampleSmoothPolygon(rawPts);
      } else if (edgeMode === 'rounded') {
        points = this._sampleRoundedPolygon(rawPts, s.borderRadius ?? 8);
      } else {
        points = rawPts;
      }
      return { points, closed: true };
    }

    // Plain rect — sample rounded corners if borderRadius > 0
    const r = Math.min(s.borderRadius ?? 0, Math.min(w, h) / 2);
    if (r <= 0.5) {
      return {
        points: [
          { x: 0, y: 0 },
          { x: w, y: 0 },
          { x: w, y: h },
          { x: 0, y: h },
        ],
        closed: true,
      };
    }
    const arcPts = (cx, cy, startAngle) => {
      const N = 6;
      const out = [];
      for (let i = 0; i <= N; i++) {
        const t = startAngle + (i / N) * (Math.PI / 2);
        out.push({ x: cx + Math.cos(t) * r, y: cy + Math.sin(t) * r });
      }
      return out;
    };
    const pts = [];
    pts.push({ x: r, y: 0 });
    pts.push({ x: w - r, y: 0 });
    pts.push(...arcPts(w - r, r, -Math.PI / 2));
    pts.push({ x: w, y: h - r });
    pts.push(...arcPts(w - r, h - r, 0));
    pts.push({ x: r, y: h });
    pts.push(...arcPts(r, h - r, Math.PI / 2));
    pts.push({ x: 0, y: r });
    pts.push(...arcPts(r, r, Math.PI));
    return { points: pts, closed: true };
  }

  /**
   * Apply or update the stitched-border overlay for an element. When enabled,
   * the normal border (CSS outline / SVG ring / line stroke) is hidden and a
   * canvas of stitches is rendered along the same perimeter path. Idempotent:
   * safe to call repeatedly from applyDesign / resize.
   *
   * Entrance behavior: if the panel has a hidden scroll-anim state, defer
   * play() to _playEntrance; if not, paint immediately. In edit mode the
   * stitches always render statically (full draw, no entrance animation) so
   * the editor isn't fighting an animation while the user adjusts the panel.
   */
  _applyBorderStitch(id) {
    const entry = this.elements.get(id);
    if (!entry) return;
    const { config, wrapper } = entry;
    const bs = (config.style && config.style.borderStitch) || null;
    const enabled = bs && bs.enabled && bs.style && bs.style !== 'none';

    if (!enabled) {
      if (entry.borderStitch) {
        entry.borderStitch.destroy();
        entry.borderStitch = null;
      }
      // Restore line stroke + text overflow if previously overridden
      if (config.type === 'line') {
        const path = wrapper.querySelector('.line-path');
        if (path) path.style.opacity = '';
      }
      if (config.type === 'text') {
        wrapper.style.overflow = 'hidden';
      }
      return;
    }

    // Hide the native border so stitches replace it.
    if (config.type === 'line') {
      const path = wrapper.querySelector('.line-path');
      if (path) path.style.opacity = '0';
    } else {
      // .peg-border carries the rect border (box-shadow); hide it.
      if (entry.borderEl) entry.borderEl.style.boxShadow = 'none';
      // Hide SVG border overlay (shapes & circles)
      const overlay = wrapper.querySelector('.shape-border-overlay');
      if (overlay) overlay.style.display = 'none';
    }
    // Stitched border canvas overhangs the wrapper edge so perpendicular
    // stitches (satin/zigzag/etc.) straddle it. Text panels normally clip
    // their frame with overflow:hidden — that would also clip the canvas
    // overhang, so allow overflow when border stitch is active.
    if (config.type === 'text') {
      wrapper.style.overflow = 'visible';
    }

    const pathInfo = this._computeBorderPath(entry);
    if (!pathInfo) return;

    // Resolve color list: borderColor (single) by default, palette/customColors when chosen.
    const s = config.style || {};
    let colors = null;
    if (bs.palette && bs.palette !== 'border') {
      if (bs.palette === 'custom' && Array.isArray(bs.customColors) && bs.customColors.length) {
        colors = bs.customColors.slice();
      } else {
        colors = STITCH_PALETTES[bs.palette] || null;
      }
    }
    const baseColor = s.borderColor || '#1e1e1e';

    const opts = {
      points: pathInfo.points,
      closed: pathInfo.closed,
      style: bs.style,
      stitchLen: bs.stitchLen ?? 8,
      color: baseColor,
      colors,
      colorBlend: !!bs.colorBlend,
      width: s.borderWidth ?? 1.8,
      animated: !this.editModeActive && bs.animated !== false,
      duration: bs.duration ?? 1.0,
      flow: !!bs.flow,
      flowDir: bs.flowDir === 'ccw' ? 'ccw' : 'cw',
      flowSpeed: bs.flowSpeed ?? 60,
    };

    if (entry.borderStitch) {
      entry.borderStitch.update(opts);
      entry.borderStitch.resize();
    } else {
      entry.borderStitch = createBorderStitch(wrapper, opts);
      // If the panel is hidden waiting on a scroll trigger, defer play to
      // _playEntrance. Otherwise paint immediately.
      const animState = wrapper.dataset.animState;
      if (animState !== 'hidden') {
        entry.borderStitch.play();
      }
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

    // Three edge modes (parallel to polygon shapes):
    //   'sharp'   → straight anchor-to-anchor segments
    //   'rounded' → straight segments with corners rounded by borderRadius
    //   'curve'   → Chaikin curve through every anchor (legacy `smooth: true`)
    const edge = resolveLineEdge(s);
    const r = s.borderRadius ?? 8;
    const d = edge === 'curve'   ? this._smoothPolyline(pts)
            : edge === 'rounded' ? this._roundedPolyline(pts, r)
            :                      this._sharpPolyline(pts);

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

  /** Open polyline with rounded corners at every interior anchor. Each
   *  corner is a quadratic Bezier from a point `r` along the inbound edge,
   *  through the anchor (control), to a point `r` along the outbound edge.
   *  `r` clamps to half the shorter adjacent edge so corners can't bow into
   *  each other. Used for line edge='rounded'. */
  _roundedPolyline(pts, radius) {
    const n = pts.length;
    if (n < 3 || radius <= 0) return this._sharpPolyline(pts);
    let d = `M${pts[0].x},${pts[0].y}`;
    for (let i = 1; i < n - 1; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const next = pts[i + 1];
      const dx1 = prev.x - curr.x, dy1 = prev.y - curr.y;
      const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      if (len1 === 0 || len2 === 0) continue;
      const r = Math.min(radius, len1 / 2, len2 / 2);
      const startX = curr.x + (dx1 / len1) * r;
      const startY = curr.y + (dy1 / len1) * r;
      const endX = curr.x + (dx2 / len2) * r;
      const endY = curr.y + (dy2 / len2) * r;
      d += ` L${startX},${startY} Q${curr.x},${curr.y} ${endX},${endY}`;
    }
    const last = pts[n - 1];
    d += ` L${last.x},${last.y}`;
    return d;
  }

  /** Sample _roundedPolyline as a dense polyline for stitched-border use. */
  _sampleRoundedPolyline(pts, radius, segments = 6) {
    const n = pts.length;
    if (n < 3 || radius <= 0) return pts.slice();
    const out = [{ x: pts[0].x, y: pts[0].y }];
    for (let i = 1; i < n - 1; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const next = pts[i + 1];
      const dx1 = prev.x - curr.x, dy1 = prev.y - curr.y;
      const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      if (len1 === 0 || len2 === 0) continue;
      const r = Math.min(radius, len1 / 2, len2 / 2);
      const startX = curr.x + (dx1 / len1) * r;
      const startY = curr.y + (dy1 / len1) * r;
      const endX = curr.x + (dx2 / len2) * r;
      const endY = curr.y + (dy2 / len2) * r;
      out.push({ x: startX, y: startY });
      for (let s = 1; s <= segments; s++) {
        const t = s / segments;
        const u = 1 - t;
        out.push({
          x: u * u * startX + 2 * u * t * curr.x + t * t * endX,
          y: u * u * startY + 2 * u * t * curr.y + t * t * endY,
        });
      }
    }
    out.push({ x: pts[n - 1].x, y: pts[n - 1].y });
    return out;
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

  /** Closed polygon variant of _smoothPolyline — Chaikin-style quadratic
   *  curve through every anchor, with no straight start/end legs (the loop
   *  closes through pts[0] back to mid(pts[0], pts[1])). Each anchor acts as
   *  the control point of one Bezier segment between consecutive edge
   *  midpoints. Used for shape clip-path and SVG border ring when
   *  `shape.smooth` is on. */
  _smoothPolygonPath(pts) {
    const n = pts.length;
    if (n < 3) return '';
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const m0 = mid(pts[0], pts[1]);
    let d = `M${m0.x},${m0.y}`;
    for (let i = 1; i <= n; i++) {
      const ctrl = pts[i % n];
      const next = mid(pts[i % n], pts[(i + 1) % n]);
      d += ` Q${ctrl.x},${ctrl.y} ${next.x},${next.y}`;
    }
    d += ' Z';
    return d;
  }

  /** Sample a rounded-corner polygon (the path _roundedPolygonPath produces)
   *  as a dense polyline. Each corner becomes a quadratic curve with the
   *  anchor as control point and offset entry/exit points; straight edges
   *  between corners stay as straight chords. Used for stitched borders on
   *  rounded-mode polygons so stitches follow the visible boundary. */
  _sampleRoundedPolygon(pts, radius, segments = 6) {
    const n = pts.length;
    if (n < 3 || radius <= 0) return pts.slice();
    const get = (i) => pts[((i % n) + n) % n];
    const out = [];
    for (let i = 0; i < n; i++) {
      const prev = get(i - 1);
      const curr = get(i);
      const next = get(i + 1);
      const dx1 = prev.x - curr.x, dy1 = prev.y - curr.y;
      const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
      const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2);
      if (len1 === 0 || len2 === 0) { out.push({ x: curr.x, y: curr.y }); continue; }
      const r = Math.min(radius, len1 / 2, len2 / 2);
      const startX = curr.x + (dx1 / len1) * r;
      const startY = curr.y + (dy1 / len1) * r;
      const endX = curr.x + (dx2 / len2) * r;
      const endY = curr.y + (dy2 / len2) * r;
      out.push({ x: startX, y: startY });
      for (let s = 1; s <= segments; s++) {
        const t = s / segments;
        const u = 1 - t;
        out.push({
          x: u * u * startX + 2 * u * t * curr.x + t * t * endX,
          y: u * u * startY + 2 * u * t * curr.y + t * t * endY,
        });
      }
    }
    return out;
  }

  /** Closed-polygon counterpart of _sampleSmoothLine — produces a dense
   *  polyline tracing _smoothPolygonPath, used by stitched borders on smooth
   *  shaped panels so stitches follow the visible curve. */
  _sampleSmoothPolygon(pts, segments = 16) {
    const n = pts.length;
    if (n < 3) return pts.slice();
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const out = [];
    for (let i = 0; i < n; i++) {
      const start = mid(pts[i], pts[(i + 1) % n]);
      const ctrl = pts[(i + 1) % n];
      const end = mid(pts[(i + 1) % n], pts[(i + 2) % n]);
      for (let s = 0; s < segments; s++) {
        const t = s / segments;
        const u = 1 - t;
        out.push({
          x: u * u * start.x + 2 * u * t * ctrl.x + t * t * end.x,
          y: u * u * start.y + 2 * u * t * ctrl.y + t * t * end.y,
        });
      }
    }
    return out;
  }

  /** Sample the same smoothed curve _smoothPolyline produces as a dense
   *  polyline. Used for stitched-border stitches on smooth lines so they
   *  follow the visible curve. Each interior anchor becomes the control point
   *  of a quadratic Bezier from prev-midpoint to next-midpoint; we sample
   *  each Bezier at `segments` steps. The trailing straight segment from the
   *  final midpoint to the last anchor is preserved as-is. */
  _sampleSmoothLine(pts, segments = 16) {
    if (pts.length < 3) return pts.slice();
    const out = [{ x: pts[0].x, y: pts[0].y }];
    for (let i = 1; i < pts.length - 1; i++) {
      const start = i === 1
        ? { x: pts[0].x, y: pts[0].y }
        : { x: (pts[i - 1].x + pts[i].x) / 2, y: (pts[i - 1].y + pts[i].y) / 2 };
      const end = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
      const ctrl = pts[i];
      for (let s = 1; s <= segments; s++) {
        const t = s / segments;
        const u = 1 - t;
        out.push({
          x: u * u * start.x + 2 * u * t * ctrl.x + t * t * end.x,
          y: u * u * start.y + 2 * u * t * ctrl.y + t * t * end.y,
        });
      }
    }
    out.push({ x: pts[pts.length - 1].x, y: pts[pts.length - 1].y });
    return out;
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
    // Apply after layout settles — grid coords aren't accurate until the
    // browser has laid out all elements.
    requestAnimationFrame(() => this._applyAllLockedStates());
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
   * Overlay effects (e.g. stitch) are layered on top.
   */
  applyBackground() {
    const el = this._bgEl;
    if (!el) return;

    el.style.animation = '';
    el.style.backgroundSize = '';
    el.style.backgroundImage = '';
    el.style.backgroundColor = '';

    const bg = this.background;
    if (!bg) {
      this._destroyStitchEffect();
      this._applyParallaxScroll();
      return;
    }

    // Colors model: `bg.colors` is the canonical N-color array. Older layouts
    // stored the two-stop form as `bg.color1` / `bg.color2`; fall back to that
    // here so existing files keep rendering until they're re-saved.
    const colors = (Array.isArray(bg.colors) && bg.colors.length >= 1)
      ? bg.colors
      : [bg.color1 || '#0a0a0a', bg.color2 || '#1a1a3a'];
    const angle = bg.angle ?? 135;

    const faded = bg.faded !== false;     // default true (smooth fade)
    const colorRotate = bg.colorRotate ?? 0; // 0..1 cyclic shift along gradient

    if (bg.type === 'solid') {
      el.style.backgroundColor = colors[0];
    } else if (bg.type === 'gradient') {
      const cs = colors.length >= 2 ? colors : [colors[0], colors[0]];
      el.style.backgroundImage = buildBgGradient(angle, cs, faded, colorRotate);
    } else if (bg.type === 'animated') {
      const preset = bg.preset || 'flow';
      const cs = colors.length >= 2 ? colors : [colors[0], colors[0]];
      el.style.backgroundImage = buildBgGradient(angle, cs, faded, colorRotate);
      // Viewport-relative size so the gradient pattern doesn't rescale when
      // the bg element's height grows (parallax sizing, document reflow).
      el.style.backgroundSize = '400vw 400vh';
      el.style.animation = preset === 'aurora'
        ? 'bg-aurora 25s linear infinite'
        : 'bg-flow 20s ease-in-out infinite';
    }

    // Overlay effects
    this._applyStitchEffect(bg);

    // Page-scroll length — when set, forces the grid container tall enough to
    // produce N viewport-heights of scroll regardless of panel placement. vh
    // units adapt to display/resolution automatically. Min 1 (= one viewport,
    // no scroll); undefined/0 falls back to content-driven height.
    const sl = Number(bg.scrollLength);
    if (sl && sl >= 1) {
      this.container.style.minHeight = `calc(${sl} * 100vh)`;
    } else {
      this.container.style.minHeight = '';
    }

    this._sizeBgForParallax();
    this._applyParallaxScroll();
  }

  /**
   * Size the bg element tall enough that parallax shift never exposes empty
   * space below it. Called once from applyBackground (and from a document
   * ResizeObserver below, in case content height grows after initial render).
   * Kept separate from _applyParallaxScroll so scroll events never resize the
   * bg — that was causing first-scroll gradient rescale jumps and stitch
   * trail wipes.
   */
  _sizeBgForParallax() {
    if (!this._bgEl) return;
    const bgEnabled = !this.background || this.background.parallaxBg !== false;
    const bgDepth = bgEnabled ? ((this.background && this.background.parallax) || 0) : 0;
    if (bgDepth === 0) {
      this._bgEl.style.height = '';
      return;
    }
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const maxShift = maxScroll * bgDepth * 0.5;
    const next = `calc(100vh + ${maxShift}px)`;
    // Skip redundant assignments — repeated identical writes to style.height
    // could still notify ResizeObserver in some browsers, which would reset
    // the stitch trail unnecessarily.
    if (this._bgEl.style.height !== next) {
      this._bgEl.style.height = next;
    }

    // Set up a one-time observer so the height re-sizes when document height
    // grows after initial layout (fonts loading, images settling, etc.) —
    // without this, the first parallax scroll would expose blank space.
    if (!this._bgSizeRO) {
      this._bgSizeRO = new ResizeObserver(() => this._sizeBgForParallax());
      this._bgSizeRO.observe(document.documentElement);
    }
  }

  /** Create or destroy the stitch canvas overlay based on background config. */
  _applyStitchEffect(bg) {
    const isStitch = bg.effect === 'stitch'
      || bg.effect === 'stitch-wander'
      || bg.effect === 'stitch-pathed';
    if (isStitch) {
      const s = bg.stitch || {};
      const path = bg.stitchPath || { points: [], closed: true };

      // If the variant changed, destroy and recreate
      if (this._stitchCtrl && this._stitchVariant !== bg.effect) {
        this._destroyStitchEffect();
      }

      if (this._stitchCtrl) {
        this._stitchCtrl.setSpeed(s.speed ?? 120);
        this._stitchCtrl.setStitchLen(s.stitchLen ?? 10);
        this._stitchCtrl.setPalette(s.palette ?? 'warm');
        if (this._stitchCtrl.setCustomColors) {
          this._stitchCtrl.setCustomColors(s.customColors || null);
        }
        this._stitchCtrl.setStyle(s.style ?? 'running');
        this._stitchCtrl.setCurliness(s.curliness ?? 3);
        if (bg.effect === 'stitch-pathed' && this._stitchCtrl.setPoints) {
          // Per-point `sharp` flags ride along on each point object via setPoints.
          this._stitchCtrl.setPoints(path.points || []);
          this._stitchCtrl.setClosed(path.closed !== false);
          this._stitchCtrl.setContinuous(!!path.continuous);
        }
      } else {
        let factory;
        if (bg.effect === 'stitch-wander') factory = createWanderStitchEffect;
        else if (bg.effect === 'stitch-pathed') factory = createPathedStitchEffect;
        else factory = createStitchEffect;

        const opts = {
          speed:     s.speed ?? 120,
          stitchLen: s.stitchLen ?? 10,
          palette:   s.palette ?? 'warm',
          style:     s.style ?? 'running',
          curliness: s.curliness ?? (bg.effect === 'stitch-wander' ? 5 : 3),
          customColors: s.customColors || null,
        };
        if (bg.effect === 'stitch-pathed') {
          opts.points = path.points || [];
          opts.closed = path.closed !== false;
          opts.continuous = !!path.continuous;
        }
        this._stitchCtrl = factory(this._bgEl, opts);
        this._stitchVariant = bg.effect;
      }
    } else {
      this._destroyStitchEffect();
    }
  }

  _destroyStitchEffect() {
    if (this._stitchCtrl) {
      this._stitchCtrl.destroy();
      this._stitchCtrl = null;
    }
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
      this.elements.forEach((entry) => {
        const { wrapper, config } = entry;
        // Any pending entrance delay must be cancelled — otherwise its timer
        // would fire mid-edit and re-trigger the entrance animation.
        this._cancelPendingEntrance(entry);
        delete wrapper.dataset.animState;
        delete wrapper.dataset.scrollPlayed;
        wrapper.style.animation = '';
        // Re-apply border stitch in static mode (no entrance animation)
        if (config.style?.borderStitch?.enabled) this._applyBorderStitch(config.id);
      });
      return;
    }

    // Re-sync border-stitch instances with the user's animated setting
    // (edit mode forces animated=false; leaving edit mode must restore).
    this.elements.forEach(({ config }) => {
      if (config.style?.borderStitch?.enabled) this._applyBorderStitch(config.id);
    });

    // Collect tracked elements and set initial state. An element is tracked
    // if it has any of:
    //   - an entrance animation enabled (existing behavior)
    //   - a non-zero spawnDelay (new — works without animation)
    //   - a spawnRow set later than its gridRow (also new — appears on scroll
    //     past where it sits, again works without animation)
    //   - any exit/scroll animation
    // Tracked elements that have a hide-able trigger (entrance anim OR spawn
    // delay/row) start as 'hidden'; otherwise they stay visible and only
    // their scroll/exit triggers matter. We push the canonical entry (not a
    // fresh {config, wrapper} pair) so per-element state like
    // `_entranceDelayTimer` survives scroll-handler rebuilds.
    const tracked = [];
    this.elements.forEach((entry) => {
      const { config, wrapper } = entry;
      // Cancel any leftover pending timer before re-initializing — covers
      // cases like loadLayout being called while a previous layout was mid-
      // animation, or setupScrollAnimations being re-invoked.
      this._cancelPendingEntrance(entry);
      const a = config.animation;
      const spawnDelay = Math.max(0, config.spawnDelay ?? a?.entranceDelay ?? 0);
      const spawnRow = config.spawnRow ?? a?.triggerRow ?? config.gridRow;
      const hasEntranceAnim = a && a.enabled && a.entrance && a.entrance !== 'none';
      const hasSpawnTrigger = spawnDelay > 0 || spawnRow > config.gridRow;
      const hasExitOrScroll = a && a.enabled && (
        (a.exit && a.exit !== 'none') || (a.scroll && a.scroll !== 'none')
      );
      if (!hasEntranceAnim && !hasSpawnTrigger && !hasExitOrScroll) return;

      if (hasEntranceAnim || hasSpawnTrigger) {
        wrapper.dataset.animState = 'hidden';
        wrapper.style.animation = '';
      }
      // Reset scroll effect state
      delete wrapper.dataset.scrollPlayed;
      tracked.push(entry);
    });

    if (tracked.length === 0) return;

    const checkScroll = () => {
      // The pixel offset of the viewport's bottom edge relative to the grid container top
      const containerTop = this.container.getBoundingClientRect().top + window.scrollY;
      const viewportBottom = window.scrollY + window.innerHeight;
      const scrollIntoGrid = viewportBottom - containerTop;
      // Convert to grid row number (1-based). Multiply by zoom since
      // scrollIntoGrid is in visual space but rowHeight is unzoomed.
      const zoom = this._zoomFactor || 1;
      const rowH = (this.rowHeight + this.gap) * zoom;
      const revealedRow = rowH > 0 ? Math.floor(scrollIntoGrid / rowH) + 1 : 999;

      for (const entry of tracked) {
        const cfg = entry.config;
        const a = cfg.animation;
        const spawnRow = cfg.spawnRow ?? a?.triggerRow ?? cfg.gridRow;
        const scrollRow = a?.scrollTriggerRow ?? spawnRow;
        const state = entry.wrapper.dataset.animState;

        // Exit row only applies when explicitly set and above the spawn row
        const exitRow = (a?.exitTriggerRow != null && a.exitTriggerRow > spawnRow)
          ? a.exitTriggerRow : null;

        // Visible zone: from spawn row up to (but not including) exit row.
        // When no exit row is set, visible zone is unbounded above.
        const inVisibleZone = revealedRow >= spawnRow
          && (exitRow == null || revealedRow < exitRow);

        if (inVisibleZone) {
          if (state === 'hidden' || state === 'exited' || state == null) {
            this._playEntrance(entry);
          }
        } else {
          if (state === 'pending') {
            // Scrolled back during the entrance delay — cancel before the
            // timer fires, panel never appeared so no exit animation needed.
            this._cancelPendingEntrance(entry);
          } else if (state === 'visible' || state === 'entering') {
            this._playExit(entry);
          }
        }

        // Scroll effect — plays once when scrollTriggerRow is reached, resets when above
        if (a?.scroll && a.scroll !== 'none') {
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
    const { wrapper } = entry;
    const state = wrapper.dataset.animState;
    if (state === 'visible' || state === 'entering' || state === 'pending') return;

    // Spawn delay (trigger-anchored, top-level on config). Lives outside
    // `animation` because we want it to apply even when no entrance animation
    // is configured — most useful for lines and for staggering reveals at a
    // shared spawn row. Legacy fallback: previous sessions briefly stored
    // `entranceDelay` inside animation; honor it if config.spawnDelay isn't
    // set so old layouts still behave.
    const cfg = entry.config;
    const delay = Math.max(0, cfg.spawnDelay ?? cfg.animation?.entranceDelay ?? 0);
    if (delay > 0) {
      wrapper.dataset.animState = 'pending';
      entry._entranceDelayTimer = setTimeout(() => {
        entry._entranceDelayTimer = null;
        // Re-check state in case it was cancelled (scroll-back) just before
        // the timer fired — _cancelPendingEntrance will have set 'hidden'.
        if (wrapper.dataset.animState !== 'pending') return;
        this._startEntranceAnimation(entry);
      }, delay * 1000);
      return;
    }
    this._startEntranceAnimation(entry);
  }

  /** Run the actual entrance: animated keyframe if `animation.enabled`, plain
   *  reveal (just become visible) otherwise. Either path also kicks off the
   *  border stitch entrance draw. */
  _startEntranceAnimation(entry) {
    const { config, wrapper } = entry;
    const anim = config.animation;
    const hasEntranceAnim = anim && anim.enabled && anim.entrance && anim.entrance !== 'none';
    if (!hasEntranceAnim) {
      wrapper.dataset.animState = 'visible';
      if (entry.borderStitch) entry.borderStitch.play();
      return;
    }
    const dur = anim.entranceDuration ?? anim.duration ?? 0.6;
    wrapper.dataset.animState = 'entering';
    wrapper.style.animation = `anim-${anim.entrance} ${dur}s ease both`;
    if (entry.borderStitch) entry.borderStitch.play();
    wrapper.addEventListener('animationend', () => {
      wrapper.dataset.animState = 'visible';
      wrapper.style.animation = '';
    }, { once: true });
  }

  /** Cancel any pending entrance-delay timer and revert state to 'hidden'.
   *  No-op if there's no pending timer. Called from _playExit (scroll-back),
   *  edit-mode toggle, and removeElement. */
  _cancelPendingEntrance(entry) {
    if (entry._entranceDelayTimer != null) {
      clearTimeout(entry._entranceDelayTimer);
      entry._entranceDelayTimer = null;
    }
    if (entry.wrapper && entry.wrapper.dataset.animState === 'pending') {
      entry.wrapper.dataset.animState = 'hidden';
    }
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

  /** Apply or clear position:fixed for a single locked element. Fixed
   *  positioning hands scroll-cancellation to the compositor, eliminating the
   *  JS-thread lag that translate-based cancellation produced. Re-measures from
   *  the grid-rendered rect each call, so callers must invoke after layout
   *  changes (resize, lock toggle, edit-mode exit). In edit mode, the panel is
   *  restored to its grid spot so drag/drop works. */
  _applyLockedState(entry) {
    const w = entry.wrapper;
    const cfg = entry.config;
    const shouldLock = cfg.locked && !this.editModeActive;
    if (!shouldLock) {
      if (w.dataset.locked === '1') {
        w.style.position = '';
        w.style.top = '';
        w.style.left = '';
        w.style.width = '';
        w.style.height = '';
        delete w.dataset.locked;
      }
      return;
    }
    // Temporarily clear any prior fixed styles so getBoundingClientRect
    // reflects the panel's grid-rendered position, not its previous fixed pin.
    if (w.dataset.locked === '1') {
      w.style.position = '';
      w.style.top = '';
      w.style.left = '';
      w.style.width = '';
      w.style.height = '';
      // Force layout flush so the next read is accurate.
      void w.offsetWidth;
    }
    w.style.translate = '';
    const rect = w.getBoundingClientRect();
    const top = rect.top + window.scrollY;
    const left = rect.left + window.scrollX;
    w.style.position = 'fixed';
    w.style.top = `${top}px`;
    w.style.left = `${left}px`;
    w.style.width = `${rect.width}px`;
    w.style.height = `${rect.height}px`;
    w.dataset.locked = '1';
  }

  _applyAllLockedStates() {
    this.elements.forEach((entry) => this._applyLockedState(entry));
  }

  /** Shift bg layer and all panel layers based on scroll + parallax depth.
   *  In edit mode, panel parallax is disabled (panels stay grid-aligned so
   *  drag/drop is predictable) but bg parallax still applies — that way the
   *  bg occupies the same on-screen position in edit and live mode, so things
   *  placed in the bg (stitch path points, etc.) don't appear to shift on
   *  save. */
  _applyParallaxScroll() {
    const rawDepth = (this.background && this.background.parallax) || 0;
    const bgEnabled = !this.background || this.background.parallaxBg !== false;
    const elEnabled = !this.background || this.background.parallaxElements !== false;
    const bgDepth = bgEnabled ? rawDepth : 0;
    const elDepth = elEnabled ? rawDepth : 0;

    // Background layer — only update transform on scroll, never the height.
    // Height is sized once in _sizeBgForParallax() (called from applyBackground)
    // because changing it on first scroll caused gradient rescale jumps and
    // wiped the stitch trail (canvas dims change → ResizeObserver fires).
    // Always applied (including edit mode) so the bg's on-screen position is
    // consistent between edit and live view.
    if (this._bgEl) {
      if (bgDepth === 0) {
        this._bgEl.style.transform = '';
      } else {
        const y = window.scrollY * bgDepth * -0.5;
        this._bgEl.style.transform = `translateY(${y}px)`;
      }
      // Sizing is owned by _sizeBgForParallax, called from applyBackground and
      // the documentElement ResizeObserver. Calling it here every scroll wrote
      // bgEl.style.height repeatedly, which invalidated layout and forced the
      // next scroll's scrollHeight read to flush — a tight feedback loop that
      // showed up as parallax stutter. Nothing else clears the height, so the
      // "defensive re-assert" was never load-bearing.
    }

    // Panel layers: in edit mode all panels stay at grid position (no parallax)
    // so drag/drop placement is reliable when scrolled. Otherwise, layer 1 = no
    // shift, layer 10 = max shift (approaching bg parallax). Uses `translate`
    // (not `transform`) to avoid conflicts with animation keyframes.
    // Locked panels are pinned via position:fixed (handled in _applyLockedState),
    // not translate-based scroll cancellation — translate runs on the JS thread
    // after compositor scroll, which produced a visible drag-behind lag.
    // Edit mode bypasses parallax so panels stay grid-aligned for drag/drop.
    this.elements.forEach(({ config, wrapper }) => {
      if (config.locked) return; // owned by _applyLockedState
      if (this.editModeActive || elDepth === 0) {
        wrapper.style.translate = '';
        return;
      }
      const layer = config.layer || 1;
      // fraction: layer 1 → 0, layer 10 → 0.9 (never quite as much as bg)
      const fraction = (layer - 1) / 10;
      const y = window.scrollY * elDepth * fraction * -0.5;
      wrapper.style.translate = y === 0 ? '' : `0 ${y}px`;
    });
    if (this.onParallaxUpdate) this.onParallaxUpdate();
  }
}
