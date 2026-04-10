/**
 * EditMode — toggles editing on a PegBoard instance.
 * Only available when the page is loaded with ?edit in the URL.
 * Saves layout back to src/data/layout.json via dev server on exit.
 */

import { ShapeEditor } from './ShapeEditor.js';
import { applySplitBoundary } from '../elements/SplitBlock.js';
import { composeTransform, computeShapeBBox } from '../grid/PegBoard.js';

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
  }

  disable() {
    this.active = false;
    this.board.container.classList.remove('edit-mode', 'alt-active');
    this.toggleBtn.textContent = 'Edit';
    this._detachElementHandlers();
    this._removeGridOverlay();
    this._dismissMenu();
    this._cancelDraw();
    this._shapeEditor.deactivate();
    this._removeBoundsOverlay();
    this._selectElement(null);
    this.board.container.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('pointerdown', this._onDismissMenu);
    document.removeEventListener('pointerdown', this._onBackgroundPointerDown);
    document.removeEventListener('keydown', this._onAltDown);
    document.removeEventListener('keyup', this._onAltUp);
    window.removeEventListener('blur', this._onAltBlur);
    this._saveLayout();
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
    if (this._frameEditId && this._frameEditId !== id) {
      this._exitFrameEdit();
    }

    this._selectedId = id;

    if (id) {
      const entry = this.board.elements.get(id);
      if (entry) {
        entry.wrapper.classList.add('is-selected');
        // For shaped elements, create a bounds overlay outside the clip-path
        if (entry.config.style?.shape) {
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
    const transform = composeTransform(config.style);

    if (this._boundsOverlay) {
      this._boundsOverlay.style.gridColumn = gc;
      this._boundsOverlay.style.gridRow = gr;
      this._boundsOverlay.style.transform = transform;

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
      this._frameOverlay.style.transform = transform;
    }
  }

  _populatePanelEditor() {
    if (!this._panelEditorEl) return;

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

    const idLabel = document.createElement('div');
    idLabel.classList.add('pe-header-id');
    idLabel.textContent = config.id;

    header.append(typeSelect, idLabel);
    body.appendChild(header);

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

    // Position info last
    const posSection = this._peSection('Position');
    posSection.appendChild(this._peReadonly('Column', config.gridColumn));
    posSection.appendChild(this._peReadonly('Row', config.gridRow));
    posSection.appendChild(this._peReadonly('Width', config.colSpan));
    posSection.appendChild(this._peReadonly('Height', config.rowSpan));
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

    // Tag selector
    const tagSelect = document.createElement('select');
    tagSelect.classList.add('pe-input');
    ['h1', 'h2', 'h3', 'p'].forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t.toUpperCase();
      if (t === content.tag) opt.selected = true;
      tagSelect.appendChild(opt);
    });
    tagSelect.addEventListener('change', () => {
      content.tag = tagSelect.value;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('Tag', tagSelect));

    // Rich text editor for main text
    const richText = this._buildRichTextArea(content.text, (html) => {
      content.text = html;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('Text', richText));

    // Rich text editor for subtext
    const richSub = this._buildRichTextArea(content.subtext || '', (html) => {
      content.subtext = html || undefined;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('Subtext', richSub));

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

    // Clip text toggle
    const clipCheck = document.createElement('input');
    clipCheck.type = 'checkbox';
    clipCheck.checked = !!content.clipFrame;
    clipCheck.addEventListener('change', () => {
      content.clipFrame = clipCheck.checked;
      rebuild();
    });
    section.appendChild(this._peField('Clip text', clipCheck));

    const resetBtn = document.createElement('button');
    resetBtn.classList.add('edit-btn');
    resetBtn.textContent = 'Reset Frame';
    resetBtn.style.marginTop = '4px';
    resetBtn.addEventListener('click', () => {
      content.frame = { x: 0, y: 0, width: 100, height: 100, rotation: 0 };
      content.clipFrame = false;
      this._rebuildSelected();
      this._populatePanelEditor();
    });
    section.appendChild(resetBtn);

    const hint = document.createElement('div');
    hint.classList.add('pe-hint');
    hint.textContent = 'Double-click panel to edit frame interactively';
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
          type: 'text', tag: 'h2', text: 'New text',
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
      const tagSelect = document.createElement('select');
      tagSelect.classList.add('pe-input');
      ['h1', 'h2', 'h3', 'p'].forEach(t => {
        const opt = document.createElement('option');
        opt.value = t;
        opt.textContent = t.toUpperCase();
        if (t === sideContent.tag) opt.selected = true;
        tagSelect.appendChild(opt);
      });
      tagSelect.addEventListener('change', () => {
        sideContent.tag = tagSelect.value;
        this._rebuildSelected();
      });
      wrap.appendChild(this._peField('Tag', tagSelect));

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

    // Text color
    const tcInput = this._peColorInput(s.textColor || '#e8e8e8', (v) => {
      s.textColor = v;
      applyDesign();
    });
    section.appendChild(this._peField('Text color', tcInput));

    return section;
  }

  // ── Panel editor helpers ──

  _peSection(title, startOpen = false) {
    const section = document.createElement('div');
    section.classList.add('pe-section');

    const heading = document.createElement('div');
    heading.classList.add('pe-section-title');

    const arrow = document.createElement('span');
    arrow.classList.add('pe-section-arrow');
    arrow.textContent = startOpen ? '\u25BC' : '\u25B6';

    heading.append(arrow, ` ${title}`);

    const content = document.createElement('div');
    content.classList.add('pe-section-body');
    if (!startOpen) content.classList.add('pe-collapsed');

    heading.addEventListener('click', () => {
      const collapsed = content.classList.toggle('pe-collapsed');
      arrow.textContent = collapsed ? '\u25B6' : '\u25BC';
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
      text: { tag: 'h2', text: 'New text' },
      image: { src: '/placeholder.svg', alt: 'New image' },
      split: {
        ratio: 0.5, angle: 0,
        left: { type: 'text', tag: 'h2', text: 'Left' },
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
    container.style.transform = composeTransform(config.style);

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
      f.x = Math.round(Math.max(0, Math.min(100 - f.width, startFx + dx)));
      f.y = Math.round(Math.max(0, Math.min(100 - f.height, startFy + dy)));
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

      this._addSubmenu(menu, 'Order', [
        { label: 'Bring to front', action: () => { this._setLayer(id, 'front'); this._dismissMenu(); } },
        { label: 'Bring forward', action: () => { this._setLayer(id, 'up'); this._dismissMenu(); } },
        { label: 'Send backward', action: () => { this._setLayer(id, 'down'); this._dismissMenu(); } },
        { label: 'Send to back', action: () => { this._setLayer(id, 'back'); this._dismissMenu(); } },
      ]);

      this._addSubmenu(menu, 'Transform', [
        { label: 'Rotate 90° CW', action: () => { this._applyTransform(id, 'rotate', 90); this._dismissMenu(); } },
        { label: 'Rotate 90° CCW', action: () => { this._applyTransform(id, 'rotate', -90); this._dismissMenu(); } },
        { label: 'Flip horizontal', action: () => { this._applyTransform(id, 'flipX'); this._dismissMenu(); } },
        { label: 'Flip vertical', action: () => { this._applyTransform(id, 'flipY'); this._dismissMenu(); } },
        { label: 'Reset', action: () => { this._applyTransform(id, 'reset'); this._dismissMenu(); } },
      ]);

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
      '.peg-element, .shape-bounds, .text-frame-overlay, .shape-anchor, ' +
      '.edit-context-menu, .panel-editor, .edit-bar'
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
      text: { tag: 'h2', text: 'New text' },
      image: { src: '/placeholder.svg', alt: 'New image' },
      split: {
        ratio: 0.5, angle: 0,
        left: { type: 'text', tag: 'h2', text: 'Left' },
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

  // ── Layer ordering ──

  _setLayer(id, mode) {
    const entry = this.board.elements.get(id);
    if (!entry) return;

    const all = [];
    this.board.elements.forEach(({ config }) => all.push(config));

    const indices = all.map(c => c.zIndex ?? 0);
    const current = entry.config.zIndex ?? 0;
    const minZ = Math.min(...indices);
    const maxZ = Math.max(...indices);

    switch (mode) {
      case 'front':
        entry.config.zIndex = maxZ + 1;
        break;
      case 'back':
        entry.config.zIndex = minZ - 1;
        break;
      case 'up': {
        const above = indices.filter(z => z > current);
        entry.config.zIndex = above.length ? Math.min(...above) + 1 : current + 1;
        break;
      }
      case 'down': {
        const below = indices.filter(z => z < current);
        entry.config.zIndex = below.length ? Math.max(...below) - 1 : current - 1;
        break;
      }
    }

    entry.wrapper.style.zIndex = entry.config.zIndex;
  }

  // ── Panel transform (rotate 90° steps + flips) ──

  _applyTransform(id, op, value) {
    const entry = this.board.elements.get(id);
    if (!entry) return;
    if (!entry.config.style) entry.config.style = {};
    const s = entry.config.style;

    if (op === 'rotate') {
      const current = s.rotation || 0;
      s.rotation = ((current + value) % 360 + 360) % 360;
    } else if (op === 'flipX') {
      s.flipX = !s.flipX;
    } else if (op === 'flipY') {
      s.flipY = !s.flipY;
    } else if (op === 'reset') {
      s.rotation = 0;
      s.flipX = false;
      s.flipY = false;
    }

    this.board.applyDesign(id);
    if (this._selectedId === id) this._syncBoundsOverlay();
  }

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
