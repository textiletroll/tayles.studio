/**
 * EditMode — toggles editing on a PegBoard instance.
 * Only available when the page is loaded with ?edit in the URL.
 * Saves layout back to src/data/layout.json via dev server on exit.
 */

import { ShapeEditor } from './ShapeEditor.js';
import { applySplitBoundary } from '../elements/SplitBlock.js';
import { computeShapeBBox } from '../grid/PegBoard.js';

let _idCounter = 0;
function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${++_idCounter}`;
}

export class EditMode {
  constructor(board) {
    this.board = board;
    this.active = false;
    this.dragging = null;
    this.resizing = null;
    this._contextMenu = null;
    this._selectedId = null;
    this._panelEditorVisible = false;
    this._panelEditorEl = null;

    this._onPointerMove = this._onPointerMove.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onContextMenu = this._onContextMenu.bind(this);
    this._onDismissMenu = this._onDismissMenu.bind(this);
    this._onBackgroundPointerDown = this._onBackgroundPointerDown.bind(this);
    this._onDrawMove = this._onDrawMove.bind(this);
    this._onDrawUp = this._onDrawUp.bind(this);
    this._onDrawStart = this._onDrawStart.bind(this);
    this._shapeEditor = new ShapeEditor(board, this);

    if (new URLSearchParams(window.location.search).has('edit')) {
      this._buildUI();
      this._buildPanelEditor();
    }
  }

  // ── Toggle ──

  toggle() {
    this.active ? this.disable() : this.enable();
  }

  enable() {
    this.active = true;
    this.board.editModeActive = true;
    this.board._applyParallaxScroll();  // clear parallax translations for grid alignment
    this.board.setupScrollAnimations(); // disables animations, makes all visible
    this.board.container.classList.add('edit-mode');
    this.toggleBtn.textContent = 'Exit Edit';
    this._attachElementHandlers();
    this._buildGridOverlay();
    this.board.container.addEventListener('contextmenu', this._onContextMenu);
    document.addEventListener('pointerdown', this._onDismissMenu);
    document.addEventListener('pointerdown', this._onBackgroundPointerDown);

    // Alt modifier — toggles shape anchor visibility
    this._onAltDown = (e) => {
      if (e.key === 'Alt') this.board.container.classList.add('alt-active');
    };
    this._onAltUp = (e) => {
      if (e.key === 'Alt') this.board.container.classList.remove('alt-active');
    };
    this._onAltBlur = () => this.board.container.classList.remove('alt-active');
    document.addEventListener('keydown', this._onAltDown);
    document.addEventListener('keyup', this._onAltUp);
    window.addEventListener('blur', this._onAltBlur);

    // Keep overlays in sync with parallax (scroll + layer changes)
    this.board.onParallaxUpdate = () => this._syncBoundsOverlay();
  }

  disable() {
    this.active = false;
    this.board.editModeActive = false;
    this.board._applyParallaxScroll();  // restore parallax translations
    this.board.container.classList.remove('edit-mode', 'alt-active');
    this.toggleBtn.textContent = 'Edit';
    this._detachElementHandlers();
    this._removeGridOverlay();
    this._dismissMenu();
    this._cancelDraw();
    this._cancelLineMode();
    this._shapeEditor.deactivate();
    this._removeBoundsOverlay();
    this._removeLineAnchors();
    this._selectElement(null);
    this.board.container.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('pointerdown', this._onDismissMenu);
    document.removeEventListener('pointerdown', this._onBackgroundPointerDown);
    document.removeEventListener('keydown', this._onAltDown);
    document.removeEventListener('keyup', this._onAltUp);
    window.removeEventListener('blur', this._onAltBlur);
    this.board.onParallaxUpdate = null;
    this._saveLayout();
    this.board.setupScrollAnimations(); // re-enable animations
  }

  // ── UI chrome ──

  _buildUI() {
    const bar = document.createElement('div');
    bar.classList.add('edit-bar');

    this.toggleBtn = document.createElement('button');
    this.toggleBtn.textContent = 'Edit';
    this.toggleBtn.classList.add('edit-btn');
    this.toggleBtn.addEventListener('click', () => this.toggle());

    this.saveBtn = document.createElement('button');
    this.saveBtn.textContent = 'Save';
    this.saveBtn.classList.add('edit-btn');
    this.saveBtn.addEventListener('click', () => this._saveLayout());

    // View dropdown
    const viewWrap = document.createElement('div');
    viewWrap.classList.add('edit-dropdown');

    const viewBtn = document.createElement('button');
    viewBtn.textContent = 'View';
    viewBtn.classList.add('edit-btn');
    viewWrap.appendChild(viewBtn);

    const viewMenu = document.createElement('div');
    viewMenu.classList.add('edit-dropdown-menu');

    const panelEditorItem = document.createElement('label');
    panelEditorItem.classList.add('edit-dropdown-item');
    this._peCheckbox = document.createElement('input');
    this._peCheckbox.type = 'checkbox';
    this._peCheckbox.checked = false;
    this._peCheckbox.addEventListener('change', () => {
      this._panelEditorVisible = this._peCheckbox.checked;
      this._togglePanelEditor();
    });
    panelEditorItem.append(this._peCheckbox, ' Panel Editor');
    viewMenu.appendChild(panelEditorItem);

    viewWrap.appendChild(viewMenu);

    bar.append(this.toggleBtn, this.saveBtn, viewWrap);
    document.body.prepend(bar);
  }

  // ── Panel Editor sidebar ──

  _buildPanelEditor() {
    const sidebar = document.createElement('div');
    sidebar.classList.add('panel-editor');
    sidebar.innerHTML = '<div class="panel-editor-empty">Select a panel to edit</div>';
    this._panelEditorEl = sidebar;
    document.body.appendChild(sidebar);
  }

  _togglePanelEditor() {
    this._panelEditorEl.classList.toggle('panel-editor-open', this._panelEditorVisible);
    if (this._peCheckbox) this._peCheckbox.checked = this._panelEditorVisible;
  }

  _selectElement(id) {
    // Deselect previous
    if (this._selectedId) {
      const prev = this.board.elements.get(this._selectedId);
      if (prev) {
        prev.wrapper.classList.remove('is-selected');
        prev.wrapper.classList.remove('has-shape-bounds');
      }
    }
    this._removeBoundsOverlay();
    this._removeLineAnchors();
    if (this._frameEditId && this._frameEditId !== id) {
      this._exitFrameEdit();
    }

    this._selectedId = id;

    if (id) {
      const entry = this.board.elements.get(id);
      if (entry) {
        entry.wrapper.classList.add('is-selected');
        if (entry.config.type === 'line') {
          this._renderLineAnchors(id);
        } else if (entry.config.style?.shape) {
          // For shaped elements, create a bounds overlay outside the clip-path
          this._createBoundsOverlay(id);
        }
      }
    }

    this._shapeEditor.onSelectionChange(id);
    this._populatePanelEditor();
  }

  // ── Bounds overlay for shaped elements ──
  // A dashed rectangle overlay that sits outside the clip-path so resize handles
  // and shape anchors remain visible and interactive.

  _createBoundsOverlay(id) {
    this._removeBoundsOverlay();
    const entry = this.board.elements.get(id);
    if (!entry) return;
    const { config, wrapper } = entry;

    // Outer: grid-sized transparent container that inherits the wrapper's transform.
    // Hosts anchor handles (positioned in grid-local percentages).
    const overlay = document.createElement('div');
    overlay.classList.add('shape-bounds');
    overlay.style.gridColumn = `${config.gridColumn} / span ${config.colSpan || 1}`;
    overlay.style.gridRow = `${config.gridRow} / span ${config.rowSpan || 1}`;
    overlay.style.translate = wrapper.style.translate;

    // Inner: the visible dashed box that tightly wraps the shape's bbox.
    // Hosts the resize handles so they sit on the actual visible shape.
    const box = document.createElement('div');
    box.classList.add('shape-bounds-box');

    const edges = [
      'top', 'bottom', 'left', 'right',
      'top-left', 'top-right', 'bottom-left', 'bottom-right',
    ];
    edges.forEach(edge => {
      const handle = document.createElement('div');
      handle.classList.add('edit-resize-handle', `edit-resize-${edge}`);
      handle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this._startResize(id, wrapper, edge, e, overlay);
      });
      box.appendChild(handle);
    });

    overlay.appendChild(box);
    this.board.container.appendChild(overlay);
    this._boundsOverlay = overlay;
    this._boundsBox = box;
    wrapper.classList.add('has-shape-bounds');

    this._syncBoundsOverlay();
  }

  _removeBoundsOverlay() {
    if (this._boundsOverlay) {
      this._boundsOverlay.remove();
      this._boundsOverlay = null;
      this._boundsBox = null;
    }
  }

  /** Recreate the bounds overlay if the selected element's shape state changed. */
  _refreshBoundsOverlay() {
    if (!this._selectedId) return;
    const entry = this.board.elements.get(this._selectedId);
    if (!entry) return;
    const hasShape = !!entry.config.style?.shape;
    const hasOverlay = !!this._boundsOverlay;
    if (hasShape && !hasOverlay) {
      this._createBoundsOverlay(this._selectedId);
    } else if (!hasShape && hasOverlay) {
      entry.wrapper.classList.remove('has-shape-bounds');
      this._removeBoundsOverlay();
    } else {
      this._syncBoundsOverlay();
    }
  }

  _syncBoundsOverlay() {
    if (!this._selectedId) return;
    const config = this.board.elements.get(this._selectedId)?.config;
    if (!config) return;
    const gc = `${config.gridColumn} / span ${config.colSpan || 1}`;
    const gr = `${config.gridRow} / span ${config.rowSpan || 1}`;

    // Match the wrapper's parallax translate on overlays
    const entry = this.board.elements.get(this._selectedId);
    const wrapperTranslate = entry ? entry.wrapper.style.translate : '';

    if (this._boundsOverlay) {
      this._boundsOverlay.style.gridColumn = gc;
      this._boundsOverlay.style.gridRow = gr;
      this._boundsOverlay.style.translate = wrapperTranslate;

      // Tight bbox for the inner dashed box + resize handles
      if (this._boundsBox) {
        const colSpan = config.colSpan || 1;
        const rowSpan = config.rowSpan || 1;
        const bbox = computeShapeBBox(config);
        this._boundsBox.style.left = `${(bbox.x / colSpan) * 100}%`;
        this._boundsBox.style.top = `${(bbox.y / rowSpan) * 100}%`;
        this._boundsBox.style.width = `${(bbox.w / colSpan) * 100}%`;
        this._boundsBox.style.height = `${(bbox.h / rowSpan) * 100}%`;
      }
    }
    if (this._frameOverlay) {
      this._frameOverlay.style.gridColumn = gc;
      this._frameOverlay.style.gridRow = gr;
      this._frameOverlay.style.translate = wrapperTranslate;
    }
    if (this._lineBounds) {
      this._lineBounds.style.gridColumn = gc;
      this._lineBounds.style.gridRow = gr;
      this._lineBounds.style.translate = wrapperTranslate;
    }
  }

  _populatePanelEditor() {
    if (!this._panelEditorEl) return;

    // Snapshot current section open/closed states before clearing
    if (!this._sectionStates) this._sectionStates = new Map();
    this._panelEditorEl.querySelectorAll('.pe-section-title').forEach(heading => {
      const title = heading.textContent.trim();
      const body = heading.nextElementSibling;
      if (body) this._sectionStates.set(title, !body.classList.contains('pe-collapsed'));
    });

    const body = this._panelEditorEl;
    body.innerHTML = '';

    if (!this._selectedId) {
      body.innerHTML = '<div class="panel-editor-empty">Select a panel to edit</div>';
      return;
    }

    const entry = this.board.elements.get(this._selectedId);
    if (!entry) {
      body.innerHTML = '<div class="panel-editor-empty">Panel not found</div>';
      return;
    }

    const { config } = entry;

    // Header — type dropdown + id
    const header = document.createElement('div');
    header.classList.add('pe-header');

    if (config.type === 'line') {
      const typeLabel = document.createElement('div');
      typeLabel.classList.add('pe-type-readonly');
      typeLabel.textContent = 'Line';
      header.appendChild(typeLabel);
    } else {
      const typeSelect = document.createElement('select');
      typeSelect.classList.add('pe-input', 'pe-type-select');
      [['text', 'Text'], ['image', 'Image'], ['split', 'Split']].forEach(([val, label]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        if (val === config.type) opt.selected = true;
        typeSelect.appendChild(opt);
      });
      typeSelect.addEventListener('change', () => {
        this._changePanelType(config.id, typeSelect.value);
      });
      header.appendChild(typeSelect);
    }

    const idLabel = document.createElement('div');
    idLabel.classList.add('pe-header-id');
    idLabel.textContent = config.id;
    header.appendChild(idLabel);
    body.appendChild(header);

    if (config.type === 'line') {
      body.appendChild(this._buildLineEditor(config));
    } else {
      // Type-specific controls first (the important stuff)
      if (config.type === 'text') {
        body.appendChild(this._buildTextEditor(config));
      } else if (config.type === 'image') {
        body.appendChild(this._buildImageEditor(config));
      } else if (config.type === 'split') {
        body.appendChild(this._buildSplitEditor(config));
      }

      // Design section
      body.appendChild(this._buildDesignEditor(config));

      // Shape section
      body.appendChild(this._shapeEditor.buildShapeSection(config));
    }

    // Animation section (all element types)
    body.appendChild(this._buildAnimationEditor(config));

    // Position info last
    const posSection = this._peSection('Position');
    posSection.appendChild(this._peReadonly('Column', config.gridColumn));
    posSection.appendChild(this._peReadonly('Row', config.gridRow));
    posSection.appendChild(this._peReadonly('Width', config.colSpan));
    posSection.appendChild(this._peReadonly('Height', config.rowSpan));
    const layerInput = this._peNumberInput(config.layer || 1, 1, 10, 1, (v) => {
      this.board.setLayer(config.id, v);
    });
    posSection.appendChild(this._peField('Layer', layerInput));
    body.appendChild(posSection);

    // Auto-open sidebar if not visible
    if (!this._panelEditorVisible) {
      this._panelEditorVisible = true;
      this._togglePanelEditor();
    }
  }

  // ── Rich text toolbar ──

  _buildRichTextArea(html, onChange) {
    const wrap = document.createElement('div');
    wrap.classList.add('pe-richtext');

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.classList.add('pe-toolbar');

    const buttons = [
      { cmd: 'bold', label: 'B', title: 'Bold', style: 'font-weight:700' },
      { cmd: 'italic', label: 'I', title: 'Italic', style: 'font-style:italic' },
      { cmd: 'underline', label: 'U', title: 'Underline', style: 'text-decoration:underline' },
      { cmd: 'strikeThrough', label: 'S', title: 'Strikethrough', style: 'text-decoration:line-through' },
      { cmd: 'createLink', label: '\uD83D\uDD17', title: 'Link', style: '' },
      { cmd: 'removeFormat', label: '\u2715', title: 'Clear formatting', style: '' },
    ];

    buttons.forEach(({ cmd, label, title, style }) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.classList.add('pe-toolbar-btn');
      btn.title = title;
      btn.innerHTML = `<span style="${style}">${label}</span>`;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault(); // keep focus in the editable area
        if (cmd === 'createLink') {
          const url = prompt('Enter URL:');
          if (url) document.execCommand(cmd, false, url);
        } else {
          document.execCommand(cmd, false, null);
        }
        // Read back after command
        onChange(editable.innerHTML);
      });
      toolbar.appendChild(btn);
    });

    // Editable area
    const editable = document.createElement('div');
    editable.classList.add('pe-editable');
    editable.contentEditable = 'true';
    editable.innerHTML = html || '';
    editable.addEventListener('input', () => {
      onChange(editable.innerHTML);
    });

    wrap.append(toolbar, editable);
    return wrap;
  }

  // ── Text editor ──

  _buildTextEditor(config) {
    const section = this._peSection('Content');
    const content = config.content;

    // Font size (cqi) — migrate from legacy tag if needed
    if (!content.fontSize) {
      content.fontSize = { h1: 13, h2: 9, h3: 6.5 }[content.tag] ?? 4;
      delete content.tag;
    }
    const fsInput = this._peNumberInput(content.fontSize, 1, 30, 0.5, (v) => {
      content.fontSize = v;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('Font size', fsInput));

    // Rich text editor for main text
    const richText = this._buildRichTextArea(content.text, (html) => {
      content.text = html;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('Text', richText));

    // Text color (stored on style for applyDesign to set on wrapper)
    if (!config.style) config.style = {};
    const tcInput = this._peColorInput(config.style.textColor || '#e8e8e8', (v) => {
      config.style.textColor = v;
      this.board.applyDesign(config.id);
    });
    section.appendChild(this._peField('Text color', tcInput));

    // Rich text editor for subtext
    const richSub = this._buildRichTextArea(content.subtext || '', (html) => {
      content.subtext = html || undefined;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('Subtext', richSub));

    // Subtext color
    const stcInput = this._peColorInput(content.subtextColor || '#666666', (v) => {
      content.subtextColor = v;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('Sub color', stcInput));

    // Horizontal alignment
    const hAlignSelect = document.createElement('select');
    hAlignSelect.classList.add('pe-input');
    ['left', 'center', 'right'].forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v.charAt(0).toUpperCase() + v.slice(1);
      if (v === (content.align || 'left')) opt.selected = true;
      hAlignSelect.appendChild(opt);
    });
    hAlignSelect.addEventListener('change', () => {
      content.align = hAlignSelect.value;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('H align', hAlignSelect));

    // Vertical alignment
    const vAlignSelect = document.createElement('select');
    vAlignSelect.classList.add('pe-input');
    [['top', 'flex-start'], ['center', 'center'], ['bottom', 'flex-end']].forEach(([label, val]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = label.charAt(0).toUpperCase() + label.slice(1);
      if (val === (content.vAlign || 'center')) opt.selected = true;
      vAlignSelect.appendChild(opt);
    });
    vAlignSelect.addEventListener('change', () => {
      content.vAlign = vAlignSelect.value;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('V align', vAlignSelect));

    // Text frame section
    section.appendChild(this._buildTextFrameControls(config));

    return section;
  }

  _buildTextFrameControls(config) {
    const content = config.content;
    if (!content.frame) {
      content.frame = { x: 0, y: 0, width: 100, height: 100, rotation: 0 };
    }
    const f = content.frame;
    const section = this._peSection('Text Frame', false);

    const rebuild = () => this._rebuildSelected();

    const xInput = this._peNumberInput(f.x, 0, 100, 1, (v) => { f.x = v; rebuild(); });
    section.appendChild(this._peField('X %', xInput));

    const yInput = this._peNumberInput(f.y, 0, 100, 1, (v) => { f.y = v; rebuild(); });
    section.appendChild(this._peField('Y %', yInput));

    const wInput = this._peNumberInput(f.width, 5, 100, 1, (v) => { f.width = v; rebuild(); });
    section.appendChild(this._peField('W %', wInput));

    const hInput = this._peNumberInput(f.height, 5, 100, 1, (v) => { f.height = v; rebuild(); });
    section.appendChild(this._peField('H %', hInput));

    const rotInput = this._peNumberInput(f.rotation, -180, 180, 1, (v) => { f.rotation = v; rebuild(); });
    section.appendChild(this._peField('Rotation', rotInput));

    const resetBtn = document.createElement('button');
    resetBtn.classList.add('edit-btn');
    resetBtn.textContent = 'Reset Frame';
    resetBtn.style.marginTop = '4px';
    resetBtn.addEventListener('click', () => {
      content.frame = { x: 0, y: 0, width: 100, height: 100, rotation: 0 };
      this._rebuildSelected();
      this._populatePanelEditor();
    });
    section.appendChild(resetBtn);

    const hint = document.createElement('div');
    hint.classList.add('pe-hint');
    hint.textContent = 'Click & drag selected panel to move text frame. Double-click for resize/rotate handles.';
    section.appendChild(hint);

    return section;
  }

  // ── Image editor ──

  _buildImageEditor(config) {
    const section = this._peSection('Content');
    const content = config.content;

    const srcInput = document.createElement('input');
    srcInput.type = 'text';
    srcInput.classList.add('pe-input');
    srcInput.value = content.src || '';
    srcInput.addEventListener('input', () => {
      content.src = srcInput.value;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('Image URL', srcInput));

    const altInput = document.createElement('input');
    altInput.type = 'text';
    altInput.classList.add('pe-input');
    altInput.value = content.alt || '';
    altInput.addEventListener('input', () => {
      content.alt = altInput.value;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('Alt text', altInput));

    const captionInput = document.createElement('input');
    captionInput.type = 'text';
    captionInput.classList.add('pe-input');
    captionInput.value = content.caption || '';
    captionInput.placeholder = 'Optional caption';
    captionInput.addEventListener('input', () => {
      content.caption = captionInput.value || undefined;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('Caption', captionInput));

    return section;
  }

  // ── Split editor ──

  _buildSplitEditor(config) {
    const section = this._peSection('Split');
    const content = config.content;

    const ratioInput = document.createElement('input');
    ratioInput.type = 'range';
    ratioInput.classList.add('pe-input', 'pe-range');
    ratioInput.min = '0.1';
    ratioInput.max = '0.9';
    ratioInput.step = '0.01';
    ratioInput.value = content.ratio ?? 0.5;
    ratioInput.addEventListener('input', () => {
      content.ratio = parseFloat(ratioInput.value);
      this._recomputeSplitClips(config);
    });
    section.appendChild(this._peField('Ratio', ratioInput));

    const angleInput = document.createElement('input');
    angleInput.type = 'range';
    angleInput.classList.add('pe-input', 'pe-range');
    angleInput.min = '-45';
    angleInput.max = '45';
    angleInput.step = '1';
    angleInput.value = content.angle ?? 0;
    angleInput.addEventListener('input', () => {
      content.angle = parseFloat(angleInput.value);
      this._recomputeSplitClips(config);
    });
    section.appendChild(this._peField('Angle', angleInput));

    const blendInput = document.createElement('input');
    blendInput.type = 'range';
    blendInput.classList.add('pe-input', 'pe-range');
    blendInput.min = '0';
    blendInput.max = '1';
    blendInput.step = '0.01';
    blendInput.value = content.blend ?? 0;
    blendInput.addEventListener('input', () => {
      content.blend = parseFloat(blendInput.value);
      this._recomputeSplitClips(config);
    });
    section.appendChild(this._peField('Blend', blendInput));

    const leftSection = this._peSection('Left side');
    leftSection.appendChild(this._buildSideEditor(config, content.left, 'left'));
    section.appendChild(leftSection);

    const rightSection = this._peSection('Right side');
    rightSection.appendChild(this._buildSideEditor(config, content.right, 'right'));
    section.appendChild(rightSection);

    return section;
  }

  _buildSideEditor(parentConfig, sideContent, side) {
    const wrap = document.createElement('div');

    const typeSelect = document.createElement('select');
    typeSelect.classList.add('pe-input');
    ['text', 'image'].forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t.charAt(0).toUpperCase() + t.slice(1);
      if (t === sideContent.type) opt.selected = true;
      typeSelect.appendChild(opt);
    });
    typeSelect.addEventListener('change', () => {
      const newType = typeSelect.value;
      if (newType === 'text') {
        parentConfig.content[side] = {
          type: 'text', fontSize: 9, text: 'New text',
          align: side === 'right' ? 'right' : 'left',
        };
      } else {
        parentConfig.content[side] = { type: 'image', src: '/placeholder.svg', alt: '' };
      }
      this._rebuildSelected();
      this._populatePanelEditor();
    });
    wrap.appendChild(this._peField('Type', typeSelect));

    if (sideContent.type === 'text') {
      // Font size (cqi) — migrate from legacy tag if needed
      if (!sideContent.fontSize) {
        sideContent.fontSize = { h1: 13, h2: 9, h3: 6.5 }[sideContent.tag] ?? 4;
        delete sideContent.tag;
      }
      const fsInput = this._peNumberInput(sideContent.fontSize, 1, 30, 0.5, (v) => {
        sideContent.fontSize = v;
        this._rebuildSelected();
      });
      wrap.appendChild(this._peField('Font size', fsInput));

      const richText = this._buildRichTextArea(sideContent.text, (html) => {
        sideContent.text = html;
        this._rebuildSelected();
      });
      wrap.appendChild(this._peField('Text', richText));

      const richSub = this._buildRichTextArea(sideContent.subtext || '', (html) => {
        sideContent.subtext = html || undefined;
        this._rebuildSelected();
      });
      wrap.appendChild(this._peField('Subtext', richSub));

      // Subtext color
      const stcInput = this._peColorInput(sideContent.subtextColor || '#666666', (v) => {
        sideContent.subtextColor = v;
        this._rebuildSelected();
      });
      wrap.appendChild(this._peField('Sub color', stcInput));

      const hAlignSelect = document.createElement('select');
      hAlignSelect.classList.add('pe-input');
      ['left', 'center', 'right'].forEach(v => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = v.charAt(0).toUpperCase() + v.slice(1);
        if (v === (sideContent.align || 'left')) opt.selected = true;
        hAlignSelect.appendChild(opt);
      });
      hAlignSelect.addEventListener('change', () => {
        sideContent.align = hAlignSelect.value;
        this._rebuildSelected();
      });
      wrap.appendChild(this._peField('H align', hAlignSelect));

      const vAlignSelect = document.createElement('select');
      vAlignSelect.classList.add('pe-input');
      [['top', 'flex-start'], ['center', 'center'], ['bottom', 'flex-end']].forEach(([label, val]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label.charAt(0).toUpperCase() + label.slice(1);
        if (val === (sideContent.vAlign || 'center')) opt.selected = true;
        vAlignSelect.appendChild(opt);
      });
      vAlignSelect.addEventListener('change', () => {
        sideContent.vAlign = vAlignSelect.value;
        this._rebuildSelected();
      });
      wrap.appendChild(this._peField('V align', vAlignSelect));
    } else if (sideContent.type === 'image') {
      const srcInput = document.createElement('input');
      srcInput.type = 'text';
      srcInput.classList.add('pe-input');
      srcInput.value = sideContent.src || '';
      srcInput.addEventListener('input', () => {
        sideContent.src = srcInput.value;
        this._rebuildSelected();
      });
      wrap.appendChild(this._peField('Image URL', srcInput));

      const altInput = document.createElement('input');
      altInput.type = 'text';
      altInput.classList.add('pe-input');
      altInput.value = sideContent.alt || '';
      altInput.addEventListener('input', () => {
        sideContent.alt = altInput.value;
        this._rebuildSelected();
      });
      wrap.appendChild(this._peField('Alt text', altInput));
    }

    return wrap;
  }

  // ── Design editor ──

  _buildDesignEditor(config) {
    if (!config.style) config.style = {};
    const s = config.style;
    const section = this._peSection('Design');

    const applyDesign = () => this.board.applyDesign(config.id);

    // Border toggle
    const borderCheck = document.createElement('input');
    borderCheck.type = 'checkbox';
    borderCheck.checked = s.borderShow !== false;
    borderCheck.addEventListener('change', () => {
      s.borderShow = borderCheck.checked;
      applyDesign();
    });
    section.appendChild(this._peField('Border', borderCheck));

    // Border width
    const bwInput = this._peNumberInput(s.borderWidth ?? 1, 0, 10, 1, (v) => {
      s.borderWidth = v;
      applyDesign();
    });
    section.appendChild(this._peField('Thickness', bwInput));

    // Border color
    const bcInput = this._peColorInput(s.borderColor || '#1e1e1e', (v) => {
      s.borderColor = v;
      applyDesign();
    });
    section.appendChild(this._peField('Border clr', bcInput));

    // Border radius
    const brInput = this._peNumberInput(s.borderRadius ?? 8, 0, 50, 1, (v) => {
      s.borderRadius = v;
      applyDesign();
    });
    section.appendChild(this._peField('Roundness', brInput));

    // Opacity
    const opInput = document.createElement('input');
    opInput.type = 'range';
    opInput.classList.add('pe-input', 'pe-range');
    opInput.min = '0';
    opInput.max = '1';
    opInput.step = '0.05';
    opInput.value = s.opacity ?? 1;
    opInput.addEventListener('input', () => {
      s.opacity = parseFloat(opInput.value);
      applyDesign();
    });
    section.appendChild(this._peField('Opacity', opInput));

    // Split side opacity
    if (config.type === 'split') {
      const loInput = document.createElement('input');
      loInput.type = 'range';
      loInput.classList.add('pe-input', 'pe-range');
      loInput.min = '0';
      loInput.max = '1';
      loInput.step = '0.05';
      loInput.value = s.leftOpacity ?? 1;
      loInput.addEventListener('input', () => {
        s.leftOpacity = parseFloat(loInput.value);
        applyDesign();
      });
      section.appendChild(this._peField('Left opa.', loInput));

      const roInput = document.createElement('input');
      roInput.type = 'range';
      roInput.classList.add('pe-input', 'pe-range');
      roInput.min = '0';
      roInput.max = '1';
      roInput.step = '0.05';
      roInput.value = s.rightOpacity ?? 1;
      roInput.addEventListener('input', () => {
        s.rightOpacity = parseFloat(roInput.value);
        applyDesign();
      });
      section.appendChild(this._peField('Right opa.', roInput));
    }

    // Background color(s) — split panels get per-side controls
    if (config.type === 'split') {
      const addSideBg = (key, label) => {
        const transCheck = document.createElement('input');
        transCheck.type = 'checkbox';
        transCheck.checked = s[key] === 'transparent';
        const colorInput = this._peColorInput(
          s[key] && s[key] !== 'transparent' ? s[key] : '#141414',
          (v) => {
            s[key] = v;
            transCheck.checked = false;
            applyDesign();
          }
        );
        colorInput.disabled = s[key] === 'transparent';
        transCheck.addEventListener('change', () => {
          if (transCheck.checked) {
            s[key] = 'transparent';
            colorInput.disabled = true;
          } else {
            s[key] = '#141414';
            colorInput.disabled = false;
            const text = colorInput.querySelector('.pe-color-text');
            const picker = colorInput.querySelector('.pe-color-picker');
            if (text) text.value = '#141414';
            if (picker) picker.value = '#141414';
          }
          applyDesign();
        });
        section.appendChild(this._peField(`${label} trans`, transCheck));
        section.appendChild(this._peField(`${label} bg`, colorInput));
      };
      addSideBg('leftBgColor', 'Left');
      addSideBg('rightBgColor', 'Right');
    } else {
      const bgTransCheck = document.createElement('input');
      bgTransCheck.type = 'checkbox';
      bgTransCheck.checked = s.bgColor === 'transparent';
      bgTransCheck.addEventListener('change', () => {
        if (bgTransCheck.checked) {
          s.bgColor = 'transparent';
          bgInput.disabled = true;
        } else {
          s.bgColor = '#141414';
          bgInput.disabled = false;
          const text = bgInput.querySelector('.pe-color-text');
          const picker = bgInput.querySelector('.pe-color-picker');
          if (text) text.value = '#141414';
          if (picker) picker.value = '#141414';
        }
        applyDesign();
      });
      section.appendChild(this._peField('Transparent', bgTransCheck));

      const bgInput = this._peColorInput(
        s.bgColor && s.bgColor !== 'transparent' ? s.bgColor : '#141414',
        (v) => {
          s.bgColor = v;
          bgTransCheck.checked = false;
          applyDesign();
        }
      );
      bgInput.disabled = s.bgColor === 'transparent';
      section.appendChild(this._peField('Bg color', bgInput));
    }

    return section;
  }

  // ── Line editor ──

  _buildLineEditor(config) {
    if (!config.style) config.style = {};
    const s = config.style;
    const section = this._peSection('Line', true);

    const applyDesign = () => this.board.applyDesign(config.id);

    // Thickness
    const bwInput = this._peNumberInput(s.borderWidth ?? 2, 0, 40, 1, (v) => {
      s.borderWidth = v;
      applyDesign();
    });
    section.appendChild(this._peField('Thickness', bwInput));

    // Color
    const bcInput = this._peColorInput(s.borderColor || '#e8e8e8', (v) => {
      s.borderColor = v;
      applyDesign();
    });
    section.appendChild(this._peField('Color', bcInput));

    // Smooth
    const smoothCheck = document.createElement('input');
    smoothCheck.type = 'checkbox';
    smoothCheck.checked = !!s.smooth;
    smoothCheck.addEventListener('change', () => {
      s.smooth = smoothCheck.checked;
      applyDesign();
    });
    section.appendChild(this._peField('Smooth', smoothCheck));

    // Opacity
    const opInput = document.createElement('input');
    opInput.type = 'range';
    opInput.classList.add('pe-input', 'pe-range');
    opInput.min = '0';
    opInput.max = '1';
    opInput.step = '0.05';
    opInput.value = s.opacity ?? 1;
    opInput.addEventListener('input', () => {
      s.opacity = parseFloat(opInput.value);
      applyDesign();
    });
    section.appendChild(this._peField('Opacity', opInput));

    // Anchor count
    const anchors = config.content?.anchors || [];
    section.appendChild(this._peReadonly('Anchors', `${anchors.length}`));

    const hint = document.createElement('div');
    hint.classList.add('pe-hint');
    hint.textContent = 'Drag anchor to move · Right-click anchor to remove';
    section.appendChild(hint);

    return section;
  }

  // ── Animation editor ──

  _buildAnimationEditor(config) {
    const defaultDur = 0.6;
    const defaultRow = config.gridRow;
    if (!config.animation) config.animation = { enabled: false, entrance: 'fadeInUp', exit: 'none', scroll: 'none' };
    const a = config.animation;
    // Migrate legacy single duration to per-type durations
    if (a.duration != null && a.entranceDuration == null) a.entranceDuration = a.duration;
    if (a.duration != null && a.exitDuration == null) a.exitDuration = a.duration;
    if (a.duration != null && a.scrollDuration == null) a.scrollDuration = a.duration;

    const section = this._peSection('Animation');

    // Enable toggle
    const enableCheck = document.createElement('input');
    enableCheck.type = 'checkbox';
    enableCheck.checked = !!a.enabled;

    const fields = document.createElement('div');
    fields.style.display = a.enabled ? '' : 'none';

    enableCheck.addEventListener('change', () => {
      a.enabled = enableCheck.checked;
      fields.style.display = a.enabled ? '' : 'none';
    });
    section.appendChild(this._peField('Enabled', enableCheck));

    // Helper: build a paired row with trigger-row + duration side by side
    const buildRowDurPair = (label, rowVal, durVal, onRow, onDur) => {
      const pair = document.createElement('div');
      pair.classList.add('pe-field');
      const lbl = document.createElement('label');
      lbl.classList.add('pe-label');
      lbl.textContent = label;
      const rowInput = this._peNumberInput(rowVal, 1, 999, 1, onRow);
      const durLbl = document.createElement('span');
      durLbl.textContent = 'Duration (s)';
      durLbl.style.cssText = 'font-size:0.75rem;color:#888;white-space:nowrap;margin-left:0.25rem;';
      const durInput = this._peNumberInput(durVal, 0.1, 3, 0.1, onDur);
      pair.append(lbl, rowInput, durLbl, durInput);
      return pair;
    };

    // Entrance effect
    const entranceEffects = [
      ['none', 'None'],
      ['fadeIn', 'Fade in'],
      ['fadeInUp', 'Fade in up'],
      ['fadeInDown', 'Fade in down'],
      ['fadeInLeft', 'Fade in left'],
      ['fadeInRight', 'Fade in right'],
      ['zoomIn', 'Zoom in'],
      ['slideInUp', 'Slide in up'],
      ['slideInLeft', 'Slide in left'],
      ['slideInRight', 'Slide in right'],
      ['flipInX', 'Flip in'],
    ];
    const entranceSel = document.createElement('select');
    entranceSel.classList.add('pe-input');
    entranceEffects.forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = lbl;
      if (a.entrance === val) opt.selected = true;
      entranceSel.appendChild(opt);
    });
    entranceSel.addEventListener('change', () => { a.entrance = entranceSel.value; });
    fields.appendChild(this._peField('Entrance', entranceSel));

    // Entrance row + duration
    fields.appendChild(buildRowDurPair(
      'Entrance row',
      a.triggerRow ?? defaultRow,
      a.entranceDuration ?? defaultDur,
      (v) => { a.triggerRow = v; },
      (v) => { a.entranceDuration = v; },
    ));

    // Exit effect
    const exitEffects = [
      ['none', 'None'],
      ['fadeOut', 'Fade out'],
      ['fadeOutDown', 'Fade out down'],
      ['fadeOutUp', 'Fade out up'],
      ['zoomOut', 'Zoom out'],
    ];
    const exitSel = document.createElement('select');
    exitSel.classList.add('pe-input');
    exitEffects.forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = lbl;
      if (a.exit === val) opt.selected = true;
      exitSel.appendChild(opt);
    });
    exitSel.addEventListener('change', () => { a.exit = exitSel.value; });
    fields.appendChild(this._peField('Exit', exitSel));

    // Exit row + duration
    fields.appendChild(buildRowDurPair(
      'Exit row',
      a.exitTriggerRow ?? a.triggerRow ?? defaultRow,
      a.exitDuration ?? defaultDur,
      (v) => { a.exitTriggerRow = v; },
      (v) => { a.exitDuration = v; },
    ));

    // Scroll effect
    const scrollEffects = [
      ['none', 'None'],
      ['pulse', 'Pulse'],
      ['shake', 'Shake'],
      ['bounce', 'Bounce'],
      ['wiggle', 'Wiggle'],
      ['float', 'Float'],
      ['spin', 'Spin'],
      ['flash', 'Flash'],
    ];
    const scrollSel = document.createElement('select');
    scrollSel.classList.add('pe-input');
    scrollEffects.forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = lbl;
      if (a.scroll === val) opt.selected = true;
      scrollSel.appendChild(opt);
    });
    scrollSel.addEventListener('change', () => { a.scroll = scrollSel.value; });
    fields.appendChild(this._peField('Scroll effect', scrollSel));

    // Scroll row + duration
    fields.appendChild(buildRowDurPair(
      'Scroll row',
      a.scrollTriggerRow ?? a.triggerRow ?? defaultRow,
      a.scrollDuration ?? defaultDur,
      (v) => { a.scrollTriggerRow = v; },
      (v) => { a.scrollDuration = v; },
    ));

    // Preview button
    const previewBtn = document.createElement('button');
    previewBtn.classList.add('pe-input');
    previewBtn.textContent = 'Preview';
    previewBtn.style.cursor = 'pointer';
    previewBtn.style.marginTop = '0.25rem';
    previewBtn.addEventListener('click', () => {
      const entry = this.board.elements.get(config.id);
      if (!entry) return;
      const { wrapper } = entry;
      let effect, dur;
      if (a.entrance && a.entrance !== 'none') { effect = a.entrance; dur = a.entranceDuration; }
      else if (a.scroll && a.scroll !== 'none') { effect = a.scroll; dur = a.scrollDuration; }
      else { effect = a.exit; dur = a.exitDuration; }
      if (!effect || effect === 'none') return;
      wrapper.style.animation = '';
      void wrapper.offsetWidth;
      wrapper.style.animation = `anim-${effect} ${dur ?? defaultDur}s ease both`;
      wrapper.addEventListener('animationend', () => { wrapper.style.animation = ''; }, { once: true });
    });
    fields.appendChild(previewBtn);

    section.appendChild(fields);
    return section;
  }

  // ── Panel editor helpers ──

  _peSection(title, startOpen = false) {
    const section = document.createElement('div');
    section.classList.add('pe-section');

    // Restore previous open/closed state if available
    const remembered = this._sectionStates && this._sectionStates.has(title);
    const isOpen = remembered ? this._sectionStates.get(title) : startOpen;

    const heading = document.createElement('div');
    heading.classList.add('pe-section-title');

    const arrow = document.createElement('span');
    arrow.classList.add('pe-section-arrow');
    arrow.textContent = isOpen ? '\u25BC' : '\u25B6';

    heading.append(arrow, ` ${title}`);

    const content = document.createElement('div');
    content.classList.add('pe-section-body');
    if (!isOpen) content.classList.add('pe-collapsed');

    heading.addEventListener('click', () => {
      const collapsed = content.classList.toggle('pe-collapsed');
      arrow.textContent = collapsed ? '\u25B6' : '\u25BC';
      if (!this._sectionStates) this._sectionStates = new Map();
      this._sectionStates.set(title, !collapsed);
    });

    section.append(heading, content);

    // Override appendChild to target the body, not the section root
    const originalAppend = section.appendChild.bind(section);
    section.appendChild = (child) => content.appendChild(child);

    return section;
  }

  _peField(label, inputEl) {
    const row = document.createElement('div');
    row.classList.add('pe-field');
    const lbl = document.createElement('label');
    lbl.classList.add('pe-label');
    lbl.textContent = label;
    row.append(lbl, inputEl);
    return row;
  }

  _peReadonly(label, value) {
    const row = document.createElement('div');
    row.classList.add('pe-field');
    const lbl = document.createElement('span');
    lbl.classList.add('pe-label');
    lbl.textContent = label;
    const val = document.createElement('span');
    val.classList.add('pe-value');
    val.textContent = value;
    row.append(lbl, val);
    return row;
  }

  _peNumberInput(value, min, max, step, onChange) {
    const input = document.createElement('input');
    input.type = 'number';
    input.classList.add('pe-input');
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value;
    input.addEventListener('input', () => onChange(parseFloat(input.value) || 0));
    return input;
  }

  _peColorInput(value, onChange) {
    const wrap = document.createElement('div');
    wrap.classList.add('pe-color-wrap');
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.classList.add('pe-color-picker');
    picker.value = value;
    const text = document.createElement('input');
    text.type = 'text';
    text.classList.add('pe-input', 'pe-color-text');
    text.value = value;
    picker.addEventListener('input', () => {
      text.value = picker.value;
      onChange(picker.value);
    });
    text.addEventListener('input', () => {
      picker.value = text.value;
      onChange(text.value);
    });
    wrap.append(picker, text);
    return wrap;
  }

  _rebuildSelected() {
    if (!this._selectedId) return;
    this.board.rebuildElement(this._selectedId);
  }

  _changePanelType(id, newType) {
    const entry = this.board.elements.get(id);
    if (!entry || entry.config.type === newType) return;

    this._exitFrameEdit();

    const defaults = {
      text: { fontSize: 9, text: 'New text' },
      image: { src: '/placeholder.svg', alt: 'New image' },
      split: {
        ratio: 0.5, angle: 0,
        left: { type: 'text', fontSize: 9, text: 'Left' },
        right: { type: 'image', src: '/placeholder.svg', alt: 'Right' },
      },
    };

    entry.config.type = newType;
    entry.config.content = defaults[newType];
    entry.wrapper.dataset.type = newType;

    this.board.rebuildElement(id);
    this._populatePanelEditor();
  }

  // ── Text frame interactive editing ──

  _enterFrameEdit(id) {
    this._exitFrameEdit();
    const entry = this.board.elements.get(id);
    if (!entry || entry.config.type !== 'text') return;
    this._frameEditId = id;
    // Hide bounds overlay resize handles so they don't intercept frame handles
    if (this._boundsOverlay) this._boundsOverlay.classList.add('frame-editing');
    this._showFrameHandles(id);
  }

  _exitFrameEdit() {
    if (this._boundsOverlay) this._boundsOverlay.classList.remove('frame-editing');
    if (this._frameOverlay) {
      this._frameOverlay.remove();
      this._frameOverlay = null;
    }
    this._frameEditId = null;
  }

  _showFrameHandles(id) {
    // Remove old overlay
    if (this._frameOverlay) {
      this._frameOverlay.remove();
      this._frameOverlay = null;
    }

    const entry = this.board.elements.get(id);
    if (!entry) return;
    const { config, wrapper } = entry;
    const content = config.content;
    if (!content.frame) {
      content.frame = { x: 0, y: 0, width: 100, height: 100, rotation: 0 };
    }
    const f = content.frame;

    // Create frame overlay as a grid sibling (not a wrapper child)
    // so it's never clipped by overflow:hidden or clip-path
    const container = document.createElement('div');
    container.classList.add('text-frame-container');
    container.style.gridColumn = `${config.gridColumn} / span ${config.colSpan || 1}`;
    container.style.gridRow = `${config.gridRow} / span ${config.rowSpan || 1}`;

    const overlay = document.createElement('div');
    overlay.classList.add('text-frame-overlay');
    overlay.style.left = `${f.x}%`;
    overlay.style.top = `${f.y}%`;
    overlay.style.width = `${f.width}%`;
    overlay.style.height = `${f.height}%`;
    if (f.rotation) overlay.style.transform = `rotate(${f.rotation}deg)`;

    // Drag to reposition
    overlay.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.frame-resize-handle') || e.target.closest('.frame-rotate-handle')) return;
      e.preventDefault();
      e.stopPropagation();
      this._startFrameDrag(id, overlay, e);
    });

    // Resize handles (4 corners)
    ['top-left', 'top-right', 'bottom-left', 'bottom-right'].forEach(corner => {
      const handle = document.createElement('div');
      handle.classList.add('frame-resize-handle', `frame-resize-${corner}`);
      handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._startFrameResize(id, overlay, corner, e);
      });
      overlay.appendChild(handle);
    });

    // Rotate handle (top center, above the frame)
    const rotHandle = document.createElement('div');
    rotHandle.classList.add('frame-rotate-handle');
    rotHandle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this._startFrameRotate(id, overlay, e);
    });
    overlay.appendChild(rotHandle);

    container.appendChild(overlay);
    this.board.container.appendChild(container);
    this._frameOverlay = container;
  }

  /** Update the .block-text element's frame styles without a full rebuild. */
  _applyFrameStyle(id) {
    const entry = this.board.elements.get(id);
    if (!entry) return;
    const el = entry.element;
    const f = entry.config.content.frame;
    if (!el || !f) return;
    if (f.x || f.y || f.width !== 100 || f.height !== 100 || f.rotation) {
      el.style.position = 'absolute';
      el.style.left = `${f.x}%`;
      el.style.top = `${f.y}%`;
      el.style.width = `${f.width}%`;
      el.style.height = `${f.height}%`;
      el.style.transform = f.rotation ? `rotate(${f.rotation}deg)` : '';
    } else {
      el.style.position = '';
      el.style.left = '';
      el.style.top = '';
      el.style.width = '';
      el.style.height = '';
      el.style.transform = '';
    }
  }

  /** Drag the text frame directly when the panel is already selected.
   *  No clamping — the panel clips via overflow:hidden. */
  _startInlineFrameDrag(id, wrapper, e) {
    const entry = this.board.elements.get(id);
    if (!entry) return;
    const content = entry.config.content;
    if (!content.frame) content.frame = { x: 0, y: 0, width: 100, height: 100, rotation: 0 };
    const f = content.frame;
    const rect = wrapper.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startFx = f.x;
    const startFy = f.y;

    wrapper.setPointerCapture(e.pointerId);
    wrapper.style.cursor = 'grabbing';

    const onMove = (me) => {
      const dx = ((me.clientX - startX) / rect.width) * 100;
      const dy = ((me.clientY - startY) / rect.height) * 100;
      f.x = Math.round(startFx + dx);
      f.y = Math.round(startFy + dy);
      this._applyFrameStyle(id);
    };

    const onUp = () => {
      wrapper.releasePointerCapture(e.pointerId);
      wrapper.removeEventListener('pointermove', onMove);
      wrapper.removeEventListener('pointerup', onUp);
      wrapper.style.cursor = '';
      this._populatePanelEditor();
    };

    wrapper.addEventListener('pointermove', onMove);
    wrapper.addEventListener('pointerup', onUp);
  }

  _startFrameDrag(id, overlay, e) {
    const entry = this.board.elements.get(id);
    if (!entry) return;
    const wrapper = entry.wrapper;
    const f = entry.config.content.frame;
    const rect = wrapper.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startFx = f.x;
    const startFy = f.y;

    overlay.setPointerCapture(e.pointerId);

    const onMove = (me) => {
      const dx = ((me.clientX - startX) / rect.width) * 100;
      const dy = ((me.clientY - startY) / rect.height) * 100;
      f.x = Math.round(startFx + dx);
      f.y = Math.round(startFy + dy);
      overlay.style.left = `${f.x}%`;
      overlay.style.top = `${f.y}%`;
      this._applyFrameStyle(id);
    };

    const onUp = () => {
      overlay.removeEventListener('pointermove', onMove);
      overlay.removeEventListener('pointerup', onUp);
      this._populatePanelEditor();
    };

    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerup', onUp);
  }

  _startFrameResize(id, overlay, corner, e) {
    const entry = this.board.elements.get(id);
    if (!entry) return;
    const wrapper = entry.wrapper;
    const f = entry.config.content.frame;
    const rect = wrapper.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startFx = f.x;
    const startFy = f.y;
    const startFw = f.width;
    const startFh = f.height;

    overlay.setPointerCapture(e.pointerId);

    const onMove = (me) => {
      const dx = ((me.clientX - startX) / rect.width) * 100;
      const dy = ((me.clientY - startY) / rect.height) * 100;

      if (corner.includes('right')) {
        f.width = Math.round(Math.max(5, Math.min(100 - f.x, startFw + dx)));
      }
      if (corner.includes('left')) {
        const newX = Math.max(0, startFx + dx);
        const newW = startFw - (newX - startFx);
        if (newW >= 5) { f.x = Math.round(newX); f.width = Math.round(newW); }
      }
      if (corner.includes('bottom')) {
        f.height = Math.round(Math.max(5, Math.min(100 - f.y, startFh + dy)));
      }
      if (corner.includes('top')) {
        const newY = Math.max(0, startFy + dy);
        const newH = startFh - (newY - startFy);
        if (newH >= 5) { f.y = Math.round(newY); f.height = Math.round(newH); }
      }

      overlay.style.left = `${f.x}%`;
      overlay.style.top = `${f.y}%`;
      overlay.style.width = `${f.width}%`;
      overlay.style.height = `${f.height}%`;
      this._applyFrameStyle(id);
    };

    const onUp = () => {
      overlay.removeEventListener('pointermove', onMove);
      overlay.removeEventListener('pointerup', onUp);
      this._populatePanelEditor();
    };

    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerup', onUp);
  }

  _startFrameRotate(id, overlay, e) {
    const entry = this.board.elements.get(id);
    if (!entry) return;
    const wrapper = entry.wrapper;
    const f = entry.config.content.frame;
    const rect = wrapper.getBoundingClientRect();

    // Center of the frame in viewport coords
    const cx = rect.left + (f.x + f.width / 2) / 100 * rect.width;
    const cy = rect.top + (f.y + f.height / 2) / 100 * rect.height;

    overlay.setPointerCapture(e.pointerId);

    const onMove = (me) => {
      const angle = Math.atan2(me.clientY - cy, me.clientX - cx) * (180 / Math.PI) + 90;
      f.rotation = Math.round(angle);
      overlay.style.transform = `rotate(${f.rotation}deg)`;
      this._applyFrameStyle(id);
    };

    const onUp = () => {
      overlay.removeEventListener('pointermove', onMove);
      overlay.removeEventListener('pointerup', onUp);
      this._populatePanelEditor();
    };

    overlay.addEventListener('pointermove', onMove);
    overlay.addEventListener('pointerup', onUp);
  }

  _recomputeSplitClips(config) {
    const entry = this.board.elements.get(config.id);
    if (!entry) return;
    const { wrapper } = entry;
    const { ratio = 0.5, angle = 0, blend = 0 } = config.content;

    const leftSide = wrapper.querySelector('.split-left');
    const rightSide = wrapper.querySelector('.split-right');
    if (leftSide && rightSide) {
      applySplitBoundary(leftSide, rightSide, ratio, angle, blend);
    }
  }

  // ── Grid overlay (vertical + horizontal lines) ──

  _buildGridOverlay() {
    this._removeGridOverlay();
    const overlay = document.createElement('div');
    overlay.classList.add('edit-grid-overlay');

    const rect = this.board.container.getBoundingClientRect();
    const cols = this.board.columns;
    const gap = this.board.gap;
    const totalGap = (cols - 1) * gap;
    const colWidth = (rect.width - totalGap) / cols;

    for (let i = 0; i <= cols; i++) {
      const line = document.createElement('div');
      line.classList.add('edit-grid-line', 'edit-grid-line-v');
      line.style.left = `${i * (colWidth + gap) - gap / 2}px`;
      overlay.appendChild(line);
    }

    const cellH = this.board.rowHeight + gap;
    const rowCount = Math.ceil(rect.height / cellH) + 4;
    for (let i = 0; i <= rowCount; i++) {
      const line = document.createElement('div');
      line.classList.add('edit-grid-line', 'edit-grid-line-h');
      line.style.top = `${i * cellH - gap / 2}px`;
      overlay.appendChild(line);

      // Row number label in the left margin
      if (i > 0 && i <= rowCount) {
        const label = document.createElement('div');
        label.classList.add('edit-row-label');
        label.textContent = i;
        label.style.top = `${(i - 1) * cellH}px`;
        overlay.appendChild(label);
      }
    }

    this.board.container.style.position = 'relative';
    this.board.container.appendChild(overlay);
    this._overlay = overlay;

    // Rebuild on resize to keep lines aligned with dynamic row heights
    if (!this._overlayRO) {
      this._overlayRO = new ResizeObserver(() => {
        if (this._overlay) this._buildGridOverlay();
      });
    }
    this._overlayRO.observe(this.board.container);
  }

  _removeGridOverlay() {
    if (this._overlay) {
      this._overlay.remove();
      this._overlay = null;
    }
    if (this._overlayRO) {
      this._overlayRO.disconnect();
    }
  }

  // ── Element drag / resize handlers ──

  _attachElementHandlers() {
    this.board.elements.forEach(({ wrapper, config }) => {
      this._makeEditable(wrapper, config);
    });
  }

  _makeEditable(wrapper, config) {
    wrapper.classList.add('edit-element');

    // Lines: wrapper has pointer-events:none; only the SVG stroke is hit.
    // Clicking the path selects the line and starts a whole-line drag.
    // Alt+click on the path inserts a new anchor at that point.
    // Anchor handles get their own pointerdown handler and stop propagation.
    if (config.type === 'line') {
      wrapper.addEventListener('pointerdown', wrapper._editDragStart = (e) => {
        if (e.button !== 0) return;
        if (e.target.closest('.line-anchor')) return;
        if (!e.target.closest('.line-path')) return;
        e.preventDefault();
        e.stopPropagation();
        this._selectElement(config.id);
        if (e.altKey) {
          this._addLineAnchorAtPoint(config.id, e.clientX, e.clientY);
          return;
        }
        this._startLineDrag(config.id, e);
      }, true);
      return;
    }

    // Use a capturing listener on the wrapper so it fires before any child elements
    // can interfere (important for split blocks with absolute-positioned sides)
    wrapper.addEventListener('pointerdown', wrapper._editDragStart = (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.edit-resize-handle')) return;
      if (e.target.closest('.shape-anchor')) return;
      if (e.target.closest('.text-frame-overlay')) return; // frame handles itself
      if (e.target.closest('.frame-resize-handle') || e.target.closest('.frame-rotate-handle')) return;

      // Alt+Click: add shape anchor
      if (e.altKey) {
        this._selectElement(config.id);
        this._shapeEditor.handleAltClick(config.id, wrapper, e);
        return;
      }

      // Select on click — exit frame edit if clicking panel body
      if (this._frameEditId === config.id) {
        this._exitFrameEdit();
        e.preventDefault();
        return;
      }

      // Already-selected text panel: drag the text frame instead of the panel
      if (config.type === 'text' && this._selectedId === config.id) {
        e.preventDefault();
        this._startInlineFrameDrag(config.id, wrapper, e);
        return;
      }

      this._selectElement(config.id);
      this._startDrag(config.id, wrapper, e);
    }, true);

    // Double-click on text panel enters frame edit mode
    if (config.type === 'text') {
      wrapper.addEventListener('dblclick', wrapper._editFrameStart = (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._selectElement(config.id);
        this._enterFrameEdit(config.id);
      });
    }

    this._addResizeHandles(wrapper, config.id);
  }

  _detachElementHandlers() {
    this._exitFrameEdit();
    this.board.elements.forEach(({ wrapper }) => {
      wrapper.classList.remove('edit-element', 'is-selected');
      if (wrapper._editDragStart) {
        wrapper.removeEventListener('pointerdown', wrapper._editDragStart, true);
        delete wrapper._editDragStart;
      }
      if (wrapper._editFrameStart) {
        wrapper.removeEventListener('dblclick', wrapper._editFrameStart);
        delete wrapper._editFrameStart;
      }
      wrapper.querySelectorAll('.edit-resize-handle').forEach(h => h.remove());
    });
  }

  // ── Drag to reposition (with click-offset tracking) ──

  _startDrag(id, wrapper, e) {
    e.preventDefault();
    const containerRect = this.board.container.getBoundingClientRect();
    const config = this.board.elements.get(id).config;
    const cellW = containerRect.width / this.board.columns;
    const cellH = this.board.rowHeight + this.board.gap;

    const elLeft = (config.gridColumn - 1) * cellW + containerRect.left;
    const elTop = (config.gridRow - 1) * cellH + containerRect.top;
    const offsetCols = Math.floor((e.clientX - elLeft) / cellW);
    const offsetRows = Math.floor((e.clientY - elTop) / cellH);

    this.dragging = { id, wrapper, offsetCols, offsetRows };
    wrapper.classList.add('is-dragging');
    wrapper.setPointerCapture(e.pointerId);
    wrapper.addEventListener('pointermove', this._onPointerMove);
    wrapper.addEventListener('pointerup', this._onPointerUp);
  }

  _onPointerMove(e) {
    if (this.dragging) this._handleDragMove(e);
    else if (this.resizing) this._handleResizeMove(e);
  }

  _onPointerUp(e) {
    if (this.dragging) this._finishDrag(e);
    else if (this.resizing) this._finishResize(e);
  }

  _handleDragMove(e) {
    const { wrapper, id, offsetCols, offsetRows } = this.dragging;
    const containerRect = this.board.container.getBoundingClientRect();
    const cell = this._clientToCell(e.clientX, e.clientY, containerRect);
    const config = this.board.elements.get(id).config;

    const col = Math.max(1, Math.min(this.board.columns - (config.colSpan || 1) + 1, cell.col - offsetCols));
    const row = Math.max(1, cell.row - offsetRows);

    wrapper.style.gridColumn = `${col} / span ${config.colSpan || 1}`;
    wrapper.style.gridRow = `${row} / span ${config.rowSpan || 1}`;
    config.gridColumn = col;
    config.gridRow = row;
    this._syncBoundsOverlay();
  }

  _finishDrag(e) {
    const { wrapper } = this.dragging;
    wrapper.classList.remove('is-dragging');
    wrapper.releasePointerCapture(e.pointerId);
    wrapper.removeEventListener('pointermove', this._onPointerMove);
    wrapper.removeEventListener('pointerup', this._onPointerUp);
    this.dragging = null;
    // Refresh position display in panel editor
    this._populatePanelEditor();
  }

  // ── Resize handles (all 4 edges + all 4 corners) ──

  _addResizeHandles(wrapper, id) {
    const edges = [
      'top', 'bottom', 'left', 'right',
      'top-left', 'top-right', 'bottom-left', 'bottom-right',
    ];
    edges.forEach(edge => {
      const handle = document.createElement('div');
      handle.classList.add('edit-resize-handle', `edit-resize-${edge}`);
      handle.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        this._selectElement(id);
        this._startResize(id, wrapper, edge, e);
      });
      wrapper.appendChild(handle);
    });
  }

  _startResize(id, wrapper, edge, e, captureEl) {
    e.preventDefault();
    const config = this.board.elements.get(id).config;
    const el = captureEl || wrapper;
    // Snapshot anchor positions so we can scale from originals during drag
    const origAnchors = config.style?.shape?.anchors
      ? config.style.shape.anchors.map(a => ({ x: a.x, y: a.y }))
      : null;
    this.resizing = {
      id,
      wrapper,
      edge,
      captureEl: el,
      origAnchors,
      startX: e.clientX,
      startY: e.clientY,
      startCol: config.gridColumn,
      startRow: config.gridRow,
      startColSpan: config.colSpan || 1,
      startRowSpan: config.rowSpan || 1,
    };
    wrapper.classList.add('is-resizing');
    el.setPointerCapture(e.pointerId);
    el.addEventListener('pointermove', this._onPointerMove);
    el.addEventListener('pointerup', this._onPointerUp);
  }

  _handleResizeMove(e) {
    const { edge, startX, startY, startCol, startRow, startColSpan, startRowSpan, id, wrapper } = this.resizing;
    const containerRect = this.board.container.getBoundingClientRect();
    const cellW = containerRect.width / this.board.columns;
    const cellH = this.board.rowHeight + this.board.gap;

    const dCols = Math.round((e.clientX - startX) / cellW);
    const dRows = Math.round((e.clientY - startY) / cellH);

    const config = this.board.elements.get(id).config;

    if (edge.includes('right')) {
      const newSpan = Math.max(1, startColSpan + dCols);
      config.colSpan = Math.min(newSpan, this.board.columns - config.gridColumn + 1);
    }

    if (edge.includes('left')) {
      const newCol = Math.max(1, startCol + dCols);
      const rightEdgeCol = startCol + startColSpan;
      const newSpan = rightEdgeCol - newCol;
      if (newSpan >= 1) {
        config.gridColumn = newCol;
        config.colSpan = newSpan;
      }
    }

    if (edge.includes('bottom')) {
      config.rowSpan = Math.max(1, startRowSpan + dRows);
    }

    if (edge.includes('top')) {
      const newRow = Math.max(1, startRow + dRows);
      const bottomEdgeRow = startRow + startRowSpan;
      const newSpan = bottomEdgeRow - newRow;
      if (newSpan >= 1) {
        config.gridRow = newRow;
        config.rowSpan = newSpan;
      }
    }

    wrapper.style.gridColumn = `${config.gridColumn} / span ${config.colSpan}`;
    wrapper.style.gridRow = `${config.gridRow} / span ${config.rowSpan}`;
    this._syncBoundsOverlay();

    // Live preview for shaped elements — scale anchors from originals and re-render
    const { origAnchors } = this.resizing;
    if (origAnchors && config.style?.shape?.anchors) {
      const xScale = config.colSpan / startColSpan;
      const yScale = config.rowSpan / startRowSpan;
      origAnchors.forEach((orig, i) => {
        config.style.shape.anchors[i] = {
          x: orig.x * xScale,
          y: orig.y * yScale,
        };
      });
      this.board.applyDesign(id);
    }
  }

  _finishResize(e) {
    const { wrapper, captureEl, startColSpan, startRowSpan } = this.resizing;
    const el = captureEl || wrapper;
    wrapper.classList.remove('is-resizing');
    el.releasePointerCapture(e.pointerId);
    el.removeEventListener('pointermove', this._onPointerMove);
    el.removeEventListener('pointerup', this._onPointerUp);
    this.resizing = null;

    // Snap scaled anchors to half-grid after resize
    const resizedEntry = this.board.elements.get(this._selectedId);
    if (resizedEntry?.config.style?.shape?.anchors) {
      const config = resizedEntry.config;
      const newColSpan = config.colSpan || 1;
      const newRowSpan = config.rowSpan || 1;
      config.style.shape.anchors.forEach(a => {
        a.x = Math.round(a.x * 2) / 2;
        a.y = Math.round(a.y * 2) / 2;
        a.x = Math.max(0, Math.min(newColSpan, a.x));
        a.y = Math.max(0, Math.min(newRowSpan, a.y));
      });
    }

    // Re-apply shape and handles after resize changes dimensions
    if (resizedEntry?.config.style?.shape) {
      this.board.applyDesign(this._selectedId);
      this._shapeEditor.onSelectionChange(this._selectedId);
    }
    this._syncBoundsOverlay();
    this._populatePanelEditor();
  }

  // ── Context menu (with nested submenus) ──

  _onContextMenu(e) {
    e.preventDefault();
    this._dismissMenu();

    const containerRect = this.board.container.getBoundingClientRect();
    const cell = this._clientToCell(e.clientX, e.clientY, containerRect);
    const clickedElement = e.target.closest('.peg-element');

    const menu = document.createElement('div');
    menu.classList.add('edit-context-menu');
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    if (clickedElement) {
      const id = clickedElement.dataset.id;

      {
        const entry = this.board.elements.get(id);
        const currentLayer = entry ? (entry.config.layer || 1) : 1;
        const layerItems = [];
        for (let i = 1; i <= 10; i++) {
          const label = i === currentLayer ? `Layer ${i}  ●` : `Layer ${i}`;
          layerItems.push({
            label,
            action: () => { this.board.setLayer(id, i); this._dismissMenu(); },
          });
        }
        this._addSubmenu(menu, 'Layer', layerItems);
      }

      this._addMenuItem(menu, 'Duplicate panel', () => {
        const entry = this.board.elements.get(id);
        if (entry) {
          const clone = JSON.parse(JSON.stringify(entry.config));
          clone.id = uniqueId(clone.type);
          clone.gridColumn = Math.min(clone.gridColumn + 2, this.board.columns);
          clone.gridRow = clone.gridRow + 1;
          this.board.addElement(clone);
          this._makeEditable(
            this.board.elements.get(clone.id).wrapper,
            this.board.elements.get(clone.id).config
          );
        }
        this._dismissMenu();
      });

      this._addDeleteConfirmItem(menu, id);
    } else {
      const shapes = ['Rectangle', 'Circle', 'Triangle'];
      const types = [
        { label: 'Text', type: 'text' },
        { label: 'Image', type: 'image' },
        { label: 'Split', type: 'split' },
      ];
      types.forEach(({ label, type }) => {
        this._addSubmenu(menu, `${label} panel`, shapes.map(shape => ({
          label: shape,
          action: () => {
            this._enterDrawMode(type, shape.toLowerCase());
            this._dismissMenu();
          },
        })));
      });

      this._addMenuItem(menu, 'Add line', () => {
        this._enterLineMode();
        this._dismissMenu();
      });

      this._addMenuItem(menu, 'Background settings', () => {
        this._dismissMenu();
        this._openBackgroundDialog();
      });
    }

    document.body.appendChild(menu);
    this._contextMenu = menu;
  }

  _addMenuItem(menu, label, onClick) {
    const item = document.createElement('div');
    item.classList.add('edit-context-item');
    item.textContent = label;
    item.addEventListener('pointerup', (e) => {
      e.stopPropagation();
      onClick();
    });
    menu.appendChild(item);
  }

  /** Delete menu item with inline confirm (✓ / ✕) to prevent accidental deletion. */
  _addDeleteConfirmItem(menu, id) {
    const item = document.createElement('div');
    item.classList.add('edit-context-item');

    const onDefaultClick = (e) => {
      e.stopPropagation();
      showConfirm();
    };

    const showDefault = () => {
      item.removeEventListener('pointerup', onDefaultClick);
      item.innerHTML = '';
      item.classList.remove('edit-context-confirm');
      item.textContent = 'Delete panel';
      item.addEventListener('pointerup', onDefaultClick);
    };

    const showConfirm = () => {
      item.removeEventListener('pointerup', onDefaultClick);
      item.innerHTML = '';
      item.classList.add('edit-context-confirm');

      const label = document.createElement('span');
      label.classList.add('edit-context-confirm-label');
      label.textContent = 'Delete?';

      const yes = document.createElement('span');
      yes.classList.add('edit-context-confirm-btn', 'is-yes');
      yes.textContent = '\u2713';
      yes.addEventListener('pointerup', (ev) => {
        ev.stopPropagation();
        this.board.removeElement(id);
        if (this._selectedId === id) this._selectElement(null);
        this._dismissMenu();
      });

      const no = document.createElement('span');
      no.classList.add('edit-context-confirm-btn', 'is-no');
      no.textContent = '\u2715';
      no.addEventListener('pointerup', (ev) => {
        ev.stopPropagation();
        showDefault();
      });

      item.append(label, yes, no);
    };

    showDefault();
    menu.appendChild(item);
  }

  _addSubmenu(menu, label, items) {
    const parent = document.createElement('div');
    parent.classList.add('edit-context-item', 'edit-context-parent');
    parent.textContent = label;

    const arrow = document.createElement('span');
    arrow.classList.add('edit-context-arrow');
    arrow.textContent = '\u25B6';
    parent.appendChild(arrow);

    const sub = document.createElement('div');
    sub.classList.add('edit-context-submenu');

    items.forEach(({ label: itemLabel, action }) => {
      const item = document.createElement('div');
      item.classList.add('edit-context-item');
      item.textContent = itemLabel;
      item.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        action();
      });
      sub.appendChild(item);
    });

    parent.appendChild(sub);
    menu.appendChild(parent);
  }

  _onDismissMenu(e) {
    if (this._contextMenu && !this._contextMenu.contains(e.target)) {
      this._dismissMenu();
    }
  }

  _onBackgroundPointerDown(e) {
    if (e.button !== 0) return;
    if (!this._selectedId) return;
    if (this.dragging || this.resizing) return;
    if (e.target.closest(
      '.peg-element, .shape-bounds, .line-bounds, .text-frame-overlay, ' +
      '.shape-anchor, .line-anchor, .edit-context-menu, .panel-editor, .edit-bar'
    )) return;
    this._selectElement(null);
  }

  _dismissMenu() {
    if (this._contextMenu) {
      this._contextMenu.remove();
      this._contextMenu = null;
    }
  }

  // ── Draw-to-create flow ──

  _enterDrawMode(type, shape = 'rectangle') {
    this._drawType = type;
    this._drawShape = shape;
    this.board.container.classList.add('edit-draw-mode');
    this._flash(`Click and drag to place ${shape} ${type} panel`);
    this.board.container.addEventListener('pointerdown', this._onDrawStart);
  }

  _cancelDraw() {
    this._drawType = null;
    this._drawShape = null;
    this.board.container.classList.remove('edit-draw-mode');
    this.board.container.removeEventListener('pointerdown', this._onDrawStart);
    if (this._drawGhost) {
      this._drawGhost.remove();
      this._drawGhost = null;
    }
  }

  _onDrawStart(e) {
    if (e.button !== 0) return;
    if (e.target.closest('.peg-element')) return;

    e.preventDefault();
    const containerRect = this.board.container.getBoundingClientRect();
    const startCell = this._clientToCell(e.clientX, e.clientY, containerRect);

    const ghost = document.createElement('div');
    ghost.classList.add('edit-draw-ghost');
    this.board.container.appendChild(ghost);
    this._drawGhost = ghost;

    this._drawing = { startCell };
    this._updateGhost(startCell, startCell);

    document.addEventListener('pointermove', this._onDrawMove);
    document.addEventListener('pointerup', this._onDrawUp);
  }

  _onDrawMove(e) {
    if (!this._drawing) return;
    const containerRect = this.board.container.getBoundingClientRect();
    const currentCell = this._clientToCell(e.clientX, e.clientY, containerRect);
    this._updateGhost(this._drawing.startCell, currentCell);
  }

  _onDrawUp(e) {
    document.removeEventListener('pointermove', this._onDrawMove);
    document.removeEventListener('pointerup', this._onDrawUp);

    if (!this._drawing) return;

    const containerRect = this.board.container.getBoundingClientRect();
    const endCell = this._clientToCell(e.clientX, e.clientY, containerRect);
    const { startCell } = this._drawing;

    const col = Math.min(startCell.col, endCell.col);
    const row = Math.min(startCell.row, endCell.row);
    const colSpan = Math.max(1, Math.abs(endCell.col - startCell.col) + 1);
    const rowSpan = Math.max(1, Math.abs(endCell.row - startCell.row) + 1);

    this._createPanel(this._drawType, col, row, colSpan, rowSpan, this._drawShape);

    this._drawing = null;
    this._cancelDraw();
  }

  _updateGhost(from, to) {
    if (!this._drawGhost) return;
    const col = Math.min(from.col, to.col);
    const row = Math.min(from.row, to.row);
    const colSpan = Math.max(1, Math.abs(to.col - from.col) + 1);
    const rowSpan = Math.max(1, Math.abs(to.row - from.row) + 1);

    this._drawGhost.style.gridColumn = `${col} / span ${colSpan}`;
    this._drawGhost.style.gridRow = `${row} / span ${rowSpan}`;
  }

  _createPanel(type, col, row, colSpan, rowSpan, shapePreset = 'rectangle') {
    const defaults = {
      text: { fontSize: 9, text: 'New text' },
      image: { src: '/placeholder.svg', alt: 'New image' },
      split: {
        ratio: 0.5, angle: 0,
        left: { type: 'text', fontSize: 9, text: 'Left' },
        right: { type: 'image', src: '/placeholder.svg', alt: 'Right' },
      },
    };

    const config = {
      id: uniqueId(type),
      type,
      gridColumn: col,
      gridRow: row,
      colSpan,
      rowSpan,
      content: defaults[type],
      style: {},
    };

    // Apply shape preset
    if (shapePreset === 'circle') {
      config.style.shape = { preset: 'circle' };
    } else if (shapePreset === 'triangle') {
      config.style.shape = {
        preset: 'triangle',
        anchors: [
          { x: colSpan / 2, y: 0 },
          { x: colSpan, y: rowSpan },
          { x: 0, y: rowSpan },
        ],
        smooth: false,
      };
    }

    this.board.addElement(config);
    const entry = this.board.elements.get(config.id);
    if (entry) {
      this._makeEditable(entry.wrapper, entry.config);
      this._selectElement(config.id);
    }
  }

  // ── Line draw mode ──

  _enterLineMode() {
    this._cancelLineMode();
    this._lineMode = { anchors: [] };
    this.board.container.classList.add('edit-line-mode');
    this._flash('Click to add anchors · Right-click to undo · Esc to finish');

    this._onLineModeDown = (e) => this._lineModeDown(e);
    this._onLineModeContextMenu = (e) => this._lineModeRightClick(e);
    this._onLineModeKey = (e) => this._lineModeKey(e);

    // Capture pointerdown before panel handlers
    this.board.container.addEventListener('pointerdown', this._onLineModeDown, true);
    this.board.container.addEventListener('contextmenu', this._onLineModeContextMenu, true);
    document.addEventListener('keydown', this._onLineModeKey);

    this._createLineGhost();
  }

  _cancelLineMode() {
    if (!this._lineMode) return;
    this.board.container.classList.remove('edit-line-mode');
    this.board.container.removeEventListener('pointerdown', this._onLineModeDown, true);
    this.board.container.removeEventListener('contextmenu', this._onLineModeContextMenu, true);
    document.removeEventListener('keydown', this._onLineModeKey);
    this._removeLineGhost();
    this._lineMode = null;
  }

  _lineModeDown(e) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = this.board.container.getBoundingClientRect();
    const pt = this._clientToGridCoords(e.clientX, e.clientY, rect);
    this._lineMode.anchors.push(pt);
    this._updateLineGhost();
  }

  _lineModeRightClick(e) {
    e.preventDefault();
    e.stopImmediatePropagation();
    if (this._lineMode.anchors.length > 0) {
      this._lineMode.anchors.pop();
      this._updateLineGhost();
    }
  }

  _lineModeKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      this._finalizeLine();
    }
  }

  _createLineGhost() {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.classList.add('line-ghost');
    svg.setAttribute('preserveAspectRatio', 'none');
    this.board.container.appendChild(svg);
    this._lineGhost = svg;
    this._updateLineGhost();
  }

  _removeLineGhost() {
    if (this._lineGhost) {
      this._lineGhost.remove();
      this._lineGhost = null;
    }
  }

  _updateLineGhost() {
    if (!this._lineGhost || !this._lineMode) return;
    while (this._lineGhost.firstChild) this._lineGhost.firstChild.remove();

    const anchors = this._lineMode.anchors;
    const cols = this.board.columns;
    const maxY = anchors.length ? Math.max(...anchors.map(a => a.y)) : 1;
    const rowSpan = Math.max(1, Math.ceil(maxY) + 1);

    this._lineGhost.style.gridColumn = `1 / span ${cols}`;
    this._lineGhost.style.gridRow = `1 / span ${rowSpan}`;

    const w = this._lineGhost.clientWidth;
    const h = this._lineGhost.clientHeight;
    if (w === 0 || h === 0) return;

    this._lineGhost.setAttribute('viewBox', `0 0 ${w} ${h}`);

    const pts = anchors.map(a => this.board.gridToPixel(a.x, a.y));

    const ns = 'http://www.w3.org/2000/svg';
    if (pts.length >= 2) {
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' '));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', '#64a0ff');
      path.setAttribute('stroke-width', '2');
      path.setAttribute('stroke-dasharray', '4,3');
      this._lineGhost.appendChild(path);
    }
    pts.forEach(p => {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', p.x);
      c.setAttribute('cy', p.y);
      c.setAttribute('r', '5');
      c.setAttribute('fill', '#64a0ff');
      this._lineGhost.appendChild(c);
    });
  }

  _finalizeLine() {
    if (!this._lineMode) return;
    const anchors = this._lineMode.anchors.slice();
    this._cancelLineMode();

    if (anchors.length < 2) return;

    const maxY = Math.max(...anchors.map(a => a.y));
    const rowSpan = Math.max(1, Math.ceil(maxY));

    const config = {
      id: uniqueId('line'),
      type: 'line',
      gridColumn: 1,
      gridRow: 1,
      colSpan: this.board.columns,
      rowSpan,
      content: { anchors },
      style: {
        borderWidth: 2,
        borderColor: '#e8e8e8',
        smooth: false,
      },
    };

    this.board.addElement(config);
    const entry = this.board.elements.get(config.id);
    if (entry) {
      this._makeEditable(entry.wrapper, entry.config);
      this._selectElement(config.id);
    }
  }

  /** Convert a client point to absolute grid coordinates (half-grid snap). */
  _clientToGridCoords(clientX, clientY, containerRect) {
    const px = clientX - containerRect.left;
    const py = clientY - containerRect.top;
    const { x, y } = this.board.pixelToGrid(px, py);
    let gx = Math.round(x * 2) / 2;
    let gy = Math.round(y * 2) / 2;
    gx = Math.max(0, Math.min(this.board.columns, gx));
    gy = Math.max(0, gy);
    return { x: gx, y: gy };
  }

  // ── Line anchor editing ──

  _renderLineAnchors(id) {
    this._removeLineAnchors();
    const entry = this.board.elements.get(id);
    if (!entry) return;
    const { config } = entry;
    const anchors = config.content?.anchors || [];

    const overlay = document.createElement('div');
    overlay.classList.add('line-bounds');
    overlay.style.gridColumn = `${config.gridColumn} / span ${config.colSpan || 1}`;
    overlay.style.gridRow = `${config.gridRow} / span ${config.rowSpan || 1}`;
    overlay.style.translate = entry.wrapper.style.translate;
    this.board.container.appendChild(overlay);
    this._lineBounds = overlay;
    this._lineAnchorHandles = [];

    anchors.forEach((a, i) => {
      const handle = document.createElement('div');
      handle.classList.add('line-anchor');
      const p = this.board.gridToPixel(a.x, a.y);
      handle.style.left = `${p.x}px`;
      handle.style.top = `${p.y}px`;

      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        this._startLineAnchorDrag(id, i, handle, e);
      });

      handle.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._removeLineAnchor(id, i);
      });

      overlay.appendChild(handle);
      this._lineAnchorHandles.push(handle);
    });
  }

  _removeLineAnchors() {
    if (this._lineBounds) {
      this._lineBounds.remove();
      this._lineBounds = null;
    }
    this._lineAnchorHandles = [];
  }

  _startLineDrag(id, e) {
    const entry = this.board.elements.get(id);
    if (!entry) return;
    const { config } = entry;
    const startAnchors = (config.content?.anchors || []).map(a => ({ x: a.x, y: a.y }));
    if (startAnchors.length < 2) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const minX = Math.min(...startAnchors.map(a => a.x));
    const minY = Math.min(...startAnchors.map(a => a.y));

    // Window-level listeners — SVG path pointer capture is unreliable
    // (pointer-events: stroke means non-stroke pixels don't dispatch moves).
    const onMove = (me) => {
      const g = this.board.pixelToGrid(me.clientX - startX, me.clientY - startY);
      // Snap delta to half-grid units so anchors keep their grid alignment
      let dCol = Math.round(g.x * 2) / 2;
      let dRow = Math.round(g.y * 2) / 2;
      if (minX + dCol < 0) dCol = -minX;
      if (minY + dRow < 0) dRow = -minY;
      config.content.anchors = startAnchors.map(a => ({
        x: a.x + dCol,
        y: a.y + dRow,
      }));
      this._ensureLineRowSpan(config);
      this.board.applyDesign(id);
      this._syncLineBounds(id);
      this._updateLineAnchorPositions(id);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this._populatePanelEditor();
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  _addLineAnchorAtPoint(id, clientX, clientY) {
    const entry = this.board.elements.get(id);
    if (!entry) return;
    const { config } = entry;
    const anchors = config.content?.anchors || [];
    if (anchors.length < 2) return;

    const rect = this.board.container.getBoundingClientRect();
    const pt = this._clientToGridCoords(clientX, clientY, rect);

    // Project click onto each segment, insert at the closest one
    let bestSeg = 0;
    let bestDist = Infinity;
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i];
      const b = anchors[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) continue;
      let t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + t * dx;
      const py = a.y + t * dy;
      const d = (pt.x - px) ** 2 + (pt.y - py) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestSeg = i;
      }
    }
    anchors.splice(bestSeg + 1, 0, pt);
    this._ensureLineRowSpan(config);
    this.board.applyDesign(id);
    this._renderLineAnchors(id);
    this._populatePanelEditor();
  }

  _startLineAnchorDrag(id, index, handle, e) {
    const entry = this.board.elements.get(id);
    if (!entry) return;

    handle.classList.add('is-dragging');
    handle.setPointerCapture(e.pointerId);

    const onMove = (me) => {
      const rect = this.board.container.getBoundingClientRect();
      const pt = this._clientToGridCoords(me.clientX, me.clientY, rect);
      entry.config.content.anchors[index] = pt;
      this._ensureLineRowSpan(entry.config);
      this.board.applyDesign(id);
      this._syncLineBounds(id);
      this._updateLineAnchorPositions(id);
    };

    const onUp = () => {
      handle.classList.remove('is-dragging');
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      this._populatePanelEditor();
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
  }

  _removeLineAnchor(id, index) {
    const entry = this.board.elements.get(id);
    if (!entry) return;
    const anchors = entry.config.content?.anchors;
    if (!anchors || anchors.length <= 2) return;
    anchors.splice(index, 1);
    this._ensureLineRowSpan(entry.config);
    this.board.applyDesign(id);
    this._renderLineAnchors(id);
    this._populatePanelEditor();
  }

  _ensureLineRowSpan(config) {
    const anchors = config.content?.anchors || [];
    if (anchors.length === 0) return;
    const maxY = Math.max(...anchors.map(a => a.y));
    const needed = Math.max(1, Math.ceil(maxY));
    if (needed !== config.rowSpan) {
      config.rowSpan = needed;
      const entry = this.board.elements.get(config.id);
      if (entry) {
        entry.wrapper.style.gridRow = `${config.gridRow} / span ${needed}`;
      }
    }
  }

  _syncLineBounds(id) {
    if (!this._lineBounds) return;
    const config = this.board.elements.get(id)?.config;
    if (!config) return;
    this._lineBounds.style.gridColumn = `${config.gridColumn} / span ${config.colSpan || 1}`;
    this._lineBounds.style.gridRow = `${config.gridRow} / span ${config.rowSpan || 1}`;
  }

  _updateLineAnchorPositions(id) {
    const config = this.board.elements.get(id)?.config;
    if (!config || !this._lineAnchorHandles) return;
    const anchors = config.content?.anchors || [];
    anchors.forEach((a, i) => {
      const handle = this._lineAnchorHandles[i];
      if (!handle) return;
      const p = this.board.gridToPixel(a.x, a.y);
      handle.style.left = `${p.x}px`;
      handle.style.top = `${p.y}px`;
    });
  }

  // ── Layer ordering (handled by PegBoard.setLayer) ──

  // ── Cell math ──

  _clientToCell(clientX, clientY, containerRect) {
    const x = clientX - containerRect.left;
    const y = clientY - containerRect.top;
    const cellW = containerRect.width / this.board.columns;
    const cellH = this.board.rowHeight + this.board.gap;
    return {
      col: Math.max(1, Math.floor(x / cellW) + 1),
      row: Math.max(1, Math.floor(y / cellH) + 1),
    };
  }

  // ── Background settings dialog ──

  _openBackgroundDialog() {
    // Snapshot current background so Cancel can revert
    const original = this.board.background
      ? JSON.parse(JSON.stringify(this.board.background))
      : null;
    const state = original
      ? { ...original }
      : { type: 'solid', color1: '#0a0a0a', color2: '#1a1a3a', angle: 135, preset: 'flow' };
    // Ensure defaults exist for fields that may be missing
    state.color1 = state.color1 || '#0a0a0a';
    state.color2 = state.color2 || '#1a1a3a';
    state.angle = state.angle ?? 135;
    state.preset = state.preset || 'flow';

    const backdrop = document.createElement('div');
    backdrop.classList.add('bg-modal-backdrop');

    const modal = document.createElement('div');
    modal.classList.add('bg-modal');

    const header = document.createElement('div');
    header.classList.add('bg-modal-header');
    const title = document.createElement('div');
    title.classList.add('bg-modal-title');
    title.textContent = 'Background settings';
    const closeBtn = document.createElement('button');
    closeBtn.classList.add('bg-modal-close');
    closeBtn.textContent = '\u2715';
    header.append(title, closeBtn);
    modal.appendChild(header);

    const mkField = (labelText) => {
      const row = document.createElement('div');
      row.classList.add('bg-modal-field');
      const label = document.createElement('label');
      label.textContent = labelText;
      row.appendChild(label);
      modal.appendChild(row);
      return row;
    };

    // Type
    const typeRow = mkField('Type');
    const typeSel = document.createElement('select');
    [
      ['solid', 'Solid'],
      ['gradient', 'Gradient'],
      ['animated', 'Animated'],
    ].forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      if (state.type === val) opt.selected = true;
      typeSel.appendChild(opt);
    });
    typeRow.appendChild(typeSel);

    // Color 1
    const color1Row = mkField('Color');
    const color1Input = document.createElement('input');
    color1Input.type = 'color';
    color1Input.value = state.color1;
    color1Row.appendChild(color1Input);

    // Color 2
    const color2Row = mkField('Color 2');
    const color2Input = document.createElement('input');
    color2Input.type = 'color';
    color2Input.value = state.color2;
    color2Row.appendChild(color2Input);

    // Angle
    const angleRow = mkField('Angle');
    const angleInput = document.createElement('input');
    angleInput.type = 'number';
    angleInput.min = '0';
    angleInput.max = '360';
    angleInput.step = '1';
    angleInput.value = state.angle;
    angleRow.appendChild(angleInput);

    // Preset
    const presetRow = mkField('Animation');
    const presetSel = document.createElement('select');
    [
      ['flow', 'Flow (horizontal pan)'],
      ['aurora', 'Aurora (diagonal drift)'],
    ].forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      if (state.preset === val) opt.selected = true;
      presetSel.appendChild(opt);
    });
    presetRow.appendChild(presetSel);

    // Parallax depth
    state.parallax = state.parallax ?? 0;
    const parallaxRow = mkField('Parallax');
    const parallaxSlider = document.createElement('input');
    parallaxSlider.type = 'range';
    parallaxSlider.min = '0';
    parallaxSlider.max = '1';
    parallaxSlider.step = '0.05';
    parallaxSlider.value = state.parallax;
    parallaxSlider.classList.add('bg-modal-range');
    const parallaxVal = document.createElement('span');
    parallaxVal.classList.add('bg-modal-range-val');
    parallaxVal.textContent = state.parallax.toFixed(2);
    parallaxRow.append(parallaxSlider, parallaxVal);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const syncVisibility = () => {
      const t = state.type;
      color1Row.classList.toggle('is-hidden', false);
      // Color 1 label text tweaks for solid vs. gradient
      color1Row.querySelector('label').textContent = t === 'solid' ? 'Color' : 'Color 1';
      color2Row.classList.toggle('is-hidden', t === 'solid');
      angleRow.classList.toggle('is-hidden', t === 'solid');
      presetRow.classList.toggle('is-hidden', t !== 'animated');
      // Parallax only makes sense for non-solid types
      parallaxRow.classList.toggle('is-hidden', t === 'solid');
    };

    const apply = () => {
      this.board.background = { ...state };
      this.board.applyBackground();
    };

    syncVisibility();
    apply();

    typeSel.addEventListener('change', () => {
      state.type = typeSel.value;
      syncVisibility();
      apply();
    });
    color1Input.addEventListener('input', () => { state.color1 = color1Input.value; apply(); });
    color2Input.addEventListener('input', () => { state.color2 = color2Input.value; apply(); });
    angleInput.addEventListener('input', () => {
      const v = parseInt(angleInput.value, 10);
      if (!Number.isNaN(v)) { state.angle = v; apply(); }
    });
    presetSel.addEventListener('change', () => { state.preset = presetSel.value; apply(); });
    parallaxSlider.addEventListener('input', () => {
      state.parallax = parseFloat(parallaxSlider.value);
      parallaxVal.textContent = state.parallax.toFixed(2);
      apply();
    });

    const close = (save) => {
      if (save) {
        this._saveLayout();
      } else {
        this.board.background = original;
        this.board.applyBackground();
      }
      backdrop.remove();
    };

    closeBtn.addEventListener('click', () => close(true));
    backdrop.addEventListener('pointerdown', (e) => {
      if (e.target === backdrop) close(true);
    });
  }

  // ── Save layout to disk (dev server only) ──

  async _saveLayout() {
    const data = this.board.getLayoutData();
    const json = JSON.stringify(data, null, 2);
    try {
      const res = await fetch('/api/save-layout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      });
      if (res.ok) {
        this._flash('Layout saved');
      } else {
        this._flash('Save failed — are you on the dev server?', true);
      }
    } catch {
      this._flash('Save failed — are you on the dev server?', true);
    }
  }

  _flash(message, isError = false) {
    const el = document.createElement('div');
    el.classList.add('edit-flash');
    if (isError) el.classList.add('edit-flash-error');
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2000);
  }
}
