/**
 * ShapeEditor — handles custom panel shapes via anchor points.
 *
 * Anchor points sit at grid intersections along the panel perimeter.
 * Alt+Click adds an anchor; drag to reshape; Alt+Right-Click removes.
 */
export class ShapeEditor {
  constructor(board, editMode) {
    this.board = board;
    this.editMode = editMode;
    this._handles = [];       // DOM elements for anchor circles
    this._activeId = null;    // element id with visible handles
  }

  // ── Public API (called by EditMode) ──

  /** Show anchor handles when an element with shape data is selected. */
  onSelectionChange(id) {
    this.deactivate();
    if (!id) return;
    const entry = this.board.elements.get(id);
    if (!entry) return;
    const shape = entry.config.style?.shape;
    if (shape && shape.anchors && shape.anchors.length >= 3) {
      this._activeId = id;
      this._renderHandles();
    }
  }

  /** Remove all anchor handles from the DOM. */
  deactivate() {
    this._handles.forEach(h => h.remove());
    this._handles = [];
    this._activeId = null;
  }

  /** Handle an Alt+Click on a panel — add an anchor. */
  handleAltClick(id, wrapper, e) {
    e.preventDefault();
    e.stopPropagation();
    const config = this.board.elements.get(id)?.config;
    if (!config) return;
    if (!config.style) config.style = {};

    const colSpan = config.colSpan || 1;
    const rowSpan = config.rowSpan || 1;
    const rect = wrapper.getBoundingClientRect();

    // Convert click to local grid coords
    let gx = ((e.clientX - rect.left) / rect.width) * colSpan;
    let gy = ((e.clientY - rect.top) / rect.height) * rowSpan;

    // Snap to half-grid intersections (0, 0.5, 1, 1.5, ...)
    gx = Math.round(gx * 2) / 2;
    gy = Math.round(gy * 2) / 2;

    // Clamp to panel bounds
    gx = Math.max(0, Math.min(colSpan, gx));
    gy = Math.max(0, Math.min(rowSpan, gy));

    // Project to nearest perimeter edge if interior
    const proj = this._projectToPerimeter(gx, gy, colSpan, rowSpan);
    gx = proj.x;
    gy = proj.y;

    // Auto-create default rectangle anchors if shape doesn't exist yet
    if (!config.style.shape || !config.style.shape.anchors || config.style.shape.anchors.length < 3) {
      config.style.shape = {
        anchors: [
          { x: 0, y: 0 },
          { x: colSpan, y: 0 },
          { x: colSpan, y: rowSpan },
          { x: 0, y: rowSpan },
        ],
        smooth: false,
      };
    }

    // Don't add duplicate
    const anchors = config.style.shape.anchors;
    if (anchors.some(a => a.x === gx && a.y === gy)) return;

    // Insert at correct position in the ordered array
    const idx = this._findInsertIndex(anchors, gx, gy);
    anchors.splice(idx, 0, { x: gx, y: gy });

    this.board.applyDesign(config.id);
    this._activeId = id;
    this._renderHandles();
    this.editMode._populatePanelEditor();
  }

  /** Handle Alt+Right-Click — remove an anchor. Called from anchor handle contextmenu. */
  _removeAnchor(index) {
    const config = this.board.elements.get(this._activeId)?.config;
    if (!config?.style?.shape?.anchors) return;
    const anchors = config.style.shape.anchors;
    if (anchors.length <= 3) return; // minimum 3
    anchors.splice(index, 1);
    this.board.applyDesign(config.id);
    this._renderHandles();
    this.editMode._populatePanelEditor();
  }

  /** Build the Shape section for the panel editor sidebar. */
  buildShapeSection(config) {
    if (!config.style) config.style = {};
    const s = config.style;
    const section = this.editMode._peSection('Shape', false);
    const applyDesign = () => {
      this.board.applyDesign(config.id);
      this._renderHandles();
    };

    const shape = s.shape;
    const isCircle = shape && shape.preset === 'circle';
    const hasAnchors = shape && shape.anchors && shape.anchors.length >= 3;

    if (isCircle) {
      section.appendChild(this.editMode._peReadonly('Type', 'Circle'));

      // Reset button
      const resetBtn = document.createElement('button');
      resetBtn.classList.add('edit-btn');
      resetBtn.textContent = 'Reset Shape';
      resetBtn.style.marginTop = '4px';
      resetBtn.addEventListener('click', () => {
        delete s.shape;
        this.deactivate();
        this.board.applyDesign(config.id);
        this.editMode._populatePanelEditor();
      });
      section.appendChild(resetBtn);
    } else if (hasAnchors) {
      // Smooth toggle
      const smoothCheck = document.createElement('input');
      smoothCheck.type = 'checkbox';
      smoothCheck.checked = !!shape.smooth;
      smoothCheck.addEventListener('change', () => {
        shape.smooth = smoothCheck.checked;
        applyDesign();
      });
      section.appendChild(this.editMode._peField('Smooth', smoothCheck));

      // Anchor count
      section.appendChild(this.editMode._peReadonly('Anchors', `${shape.anchors.length}`));

      // Reset button
      const resetBtn = document.createElement('button');
      resetBtn.classList.add('edit-btn');
      resetBtn.textContent = 'Reset Shape';
      resetBtn.style.marginTop = '4px';
      resetBtn.addEventListener('click', () => {
        delete s.shape;
        this.deactivate();
        this.board.applyDesign(config.id);
        this.editMode._populatePanelEditor();
      });
      section.appendChild(resetBtn);
    } else {
      // Init button
      const initBtn = document.createElement('button');
      initBtn.classList.add('edit-btn');
      initBtn.textContent = 'Initialize Shape';
      initBtn.addEventListener('click', () => {
        const colSpan = config.colSpan || 1;
        const rowSpan = config.rowSpan || 1;
        s.shape = {
          anchors: [
            { x: 0, y: 0 },
            { x: colSpan, y: 0 },
            { x: colSpan, y: rowSpan },
            { x: 0, y: rowSpan },
          ],
          smooth: false,
        };
        this.board.applyDesign(config.id);
        this._activeId = config.id;
        this._renderHandles();
        this.editMode._populatePanelEditor();
      });
      section.appendChild(initBtn);
    }

    // Hint
    const hint = document.createElement('div');
    hint.classList.add('pe-hint');
    hint.textContent = 'Alt+Click on panel edge to add anchors';
    section.appendChild(hint);

    return section;
  }

  // ── Anchor handle rendering ──

  _renderHandles() {
    this._handles.forEach(h => h.remove());
    this._handles = [];

    const entry = this.board.elements.get(this._activeId);
    if (!entry) return;
    const { config, wrapper } = entry;
    const shape = config.style?.shape;
    if (!shape || !shape.anchors || shape.anchors.length < 3) return;

    const colSpan = config.colSpan || 1;
    const rowSpan = config.rowSpan || 1;

    shape.anchors.forEach((anchor, i) => {
      const handle = document.createElement('div');
      handle.classList.add('shape-anchor');
      handle.style.left = `${(anchor.x / colSpan) * 100}%`;
      handle.style.top = `${(anchor.y / rowSpan) * 100}%`;

      // Drag
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this._startAnchorDrag(i, handle, e);
      });

      // Remove on context menu (right-click)
      handle.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._removeAnchor(i);
      });

      wrapper.appendChild(handle);
      this._handles.push(handle);
    });
  }

  // ── Anchor dragging ──

  _startAnchorDrag(index, handle, e) {
    const entry = this.board.elements.get(this._activeId);
    if (!entry) return;
    const { config, wrapper } = entry;
    const colSpan = config.colSpan || 1;
    const rowSpan = config.rowSpan || 1;

    handle.classList.add('is-dragging');
    handle.setPointerCapture(e.pointerId);

    const onMove = (me) => {
      const rect = wrapper.getBoundingClientRect();
      let gx = ((me.clientX - rect.left) / rect.width) * colSpan;
      let gy = ((me.clientY - rect.top) / rect.height) * rowSpan;

      // Snap to half-grid
      gx = Math.round(gx * 2) / 2;
      gy = Math.round(gy * 2) / 2;

      // Clamp
      gx = Math.max(0, Math.min(colSpan, gx));
      gy = Math.max(0, Math.min(rowSpan, gy));

      config.style.shape.anchors[index] = { x: gx, y: gy };

      // Update handle position
      handle.style.left = `${(gx / colSpan) * 100}%`;
      handle.style.top = `${(gy / rowSpan) * 100}%`;

      // Re-apply clip in real-time
      this.board.applyDesign(config.id);
    };

    const onUp = () => {
      handle.classList.remove('is-dragging');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      this.editMode._populatePanelEditor();
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }

  // ── Geometry helpers ──

  /** Project an interior point to the nearest perimeter position. */
  _projectToPerimeter(x, y, w, h) {
    // If already on perimeter, return as-is
    if (x === 0 || x === w || y === 0 || y === h) return { x, y };

    // Find nearest edge
    const dLeft = x;
    const dRight = w - x;
    const dTop = y;
    const dBottom = h - y;
    const minD = Math.min(dLeft, dRight, dTop, dBottom);

    if (minD === dLeft) return { x: 0, y };
    if (minD === dRight) return { x: w, y };
    if (minD === dTop) return { x, y: 0 };
    return { x, y: h };
  }

  /** Find the correct insertion index in the clockwise anchor array. */
  _findInsertIndex(anchors, px, py) {
    let bestIdx = anchors.length;
    let bestDist = Infinity;

    for (let i = 0; i < anchors.length; i++) {
      const a = anchors[i];
      const b = anchors[(i + 1) % anchors.length];
      const dist = this._pointToSegmentDist(px, py, a.x, a.y, b.x, b.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i + 1;
      }
    }
    return bestIdx;
  }

  /** Squared distance from point (px,py) to line segment (ax,ay)-(bx,by). */
  _pointToSegmentDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
      const ex = px - ax, ey = py - ay;
      return ex * ex + ey * ey;
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const ex = px - cx, ey = py - cy;
    return ex * ex + ey * ey;
  }
}
