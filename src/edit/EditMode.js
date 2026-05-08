/**
 * EditMode — toggles editing on a PegBoard instance.
 * Only available when the page is loaded with ?edit in the URL.
 * Saves layout back to src/data/layouts/<slug>.json via dev server on exit.
 */

import { ShapeEditor } from './ShapeEditor.js';
import { applySplitBoundary } from '../elements/SplitBlock.js';
import { computeShapeBBox } from '../grid/PegBoard.js';
import { STITCH_PALETTES } from '../effects/StitchEffect.js';
import { applyContentFrame, ensureFontLoaded } from '../elements/Viewport.js';
import pagesIndex from '../data/pages.json';

/** Curated Google Fonts list shown in the per-content-block font picker. */
const FONT_LIST = [
  'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins',
  'Playfair Display', 'Merriweather', 'Lora', 'EB Garamond', 'Cormorant Garamond',
  'Bebas Neue', 'Oswald', 'Anton', 'Raleway',
  'Caveat', 'Pacifico', 'Dancing Script', 'Permanent Marker',
  'Source Code Pro', 'JetBrains Mono', 'Fira Code',
];

let _idCounter = 0;
function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${++_idCounter}`;
}

export class EditMode {
  constructor(board, options = {}) {
    this.board = board;
    /* Slug of the page this editor instance is bound to. Used as the
       target file when saving (POST /api/save-layout?slug=<slug>) and
       to highlight the active entry in the Pages dropdown. */
    this.pageSlug = options.slug || 'home';
    this.active = false;
    this.dragging = null;
    this.resizing = null;
    this._contextMenu = null;
    this._selectedId = null;
    this._selectedContentIdx = null;
    /* Sidebar pin state — when true, sidebar stays visible with empty
       prompt even when nothing is selected (toggled via View → Panel Editor).
       When false (default), sidebar auto-shows on selection and auto-hides
       on deselection. */
    this._panelEditorPinned = false;
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
      // Auto-enable so HMR reloads (triggered by writing to layout.json from
      // any save flow — Save button, Exit Edit, bg modal close) don't kick the
      // user out of edit mode and force them to re-click Edit.
      this.enable();
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
    this.board._applyAllLockedStates(); // unpin locked panels back into the grid
    this.board.setupScrollAnimations(); // disables animations, makes all visible
    this.board.container.classList.add('edit-mode');
    document.body.classList.add('is-editing');
    this.toggleBtn.textContent = 'Exit edit';
    this.toggleBtn.classList.add('is-active');
    this._syncSidebar();
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
    requestAnimationFrame(() => this.board._applyAllLockedStates()); // re-pin after grid settles
    this.board.container.classList.remove('edit-mode', 'alt-active');
    document.body.classList.remove('is-editing');
    this.toggleBtn.textContent = 'Edit';
    this.toggleBtn.classList.remove('is-active');
    this._syncSidebar();
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
    // Lazy-load chrome fonts — only editing users pay for them. Public site
    // visitors never see editor chrome, so they never trigger this.
    if (!document.getElementById('ed-chrome-fonts')) {
      const link = document.createElement('link');
      link.id = 'ed-chrome-fonts';
      link.rel = 'stylesheet';
      link.href = 'https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap';
      document.head.appendChild(link);
    }

    const bar = document.createElement('div');
    bar.classList.add('edit-bar');

    // Wordmark — sets the "atelier console" tone; no pointer events.
    const wordmark = document.createElement('div');
    wordmark.classList.add('edit-wordmark');
    wordmark.innerHTML = '<span class="edit-wordmark-dot"></span>tayles<span class="edit-wordmark-sep">·</span><em>editor</em>';
    bar.appendChild(wordmark);

    this.toggleBtn = document.createElement('button');
    this.toggleBtn.textContent = 'Edit';
    this.toggleBtn.classList.add('edit-btn', 'edit-btn--primary');
    this.toggleBtn.addEventListener('click', () => this.toggle());

    this.saveBtn = document.createElement('button');
    this.saveBtn.textContent = 'Save';
    this.saveBtn.classList.add('edit-btn');
    this.saveBtn.addEventListener('click', () => this._saveLayout());

    const pagesWrap = this._buildPagesMenu();

    // Spacer pushes the View dropdown to the right edge of the bar.
    const spacer = document.createElement('div');
    spacer.classList.add('edit-bar-spacer');

    // View dropdown
    const viewWrap = document.createElement('div');
    viewWrap.classList.add('edit-dropdown');

    const viewBtn = document.createElement('button');
    viewBtn.innerHTML = 'View<span class="edit-btn-caret">▾</span>';
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
      this._panelEditorPinned = this._peCheckbox.checked;
      this._syncSidebar();
    });
    panelEditorItem.append(this._peCheckbox, ' Panel Editor');
    viewMenu.appendChild(panelEditorItem);

    viewWrap.appendChild(viewMenu);

    bar.append(this.toggleBtn, this.saveBtn, pagesWrap, spacer, viewWrap);
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

  /** Compute sidebar visibility from current state and apply it. Open iff
   *  edit mode is active AND (something is selected OR the user pinned it
   *  open via the View → Panel Editor checkbox). */
  _syncSidebar() {
    if (!this._panelEditorEl) return;
    const open = this.active
      && (this._panelEditorPinned || this._selectedId != null);
    this._panelEditorEl.classList.toggle('panel-editor-open', open);
    if (this._peCheckbox) this._peCheckbox.checked = this._panelEditorPinned;
  }

  _selectElement(id, contentIdx = null) {
    // Clear previous content-selected class on any node
    if (this._selectedId != null) {
      const prev = this.board.elements.get(this._selectedId);
      if (prev) {
        prev.wrapper.classList.remove('is-selected');
        prev.wrapper.classList.remove('has-shape-bounds');
        prev.wrapper.querySelectorAll('.viewport-content.is-content-selected')
          .forEach(n => n.classList.remove('is-content-selected'));
      }
    }
    this._removeBoundsOverlay();
    this._removeLineAnchors();
    // Always tear down frame overlay on selection change; re-show below if needed
    this._exitFrameEdit();

    this._selectedId = id;
    this._selectedContentIdx = (id && contentIdx != null) ? contentIdx : null;

    if (id) {
      const entry = this.board.elements.get(id);
      if (entry) {
        entry.wrapper.classList.add('is-selected');
        if (entry.config.type === 'line') {
          this._renderLineAnchors(id);
        } else if (entry.config.style?.shape && this._selectedContentIdx == null) {
          // For shaped elements, create a bounds overlay outside the clip-path.
          // Skip when a content block is selected — its frame overlay owns the UI.
          this._createBoundsOverlay(id);
        }

        // Content-block selection: highlight the chosen content node and show
        // its frame handles for direct drag/resize/rotate.
        if (this._selectedContentIdx != null) {
          const node = this._findContentNode(id, this._selectedContentIdx);
          if (node) node.classList.add('is-content-selected');
          this._showFrameHandles(id, this._selectedContentIdx);
        }
      }
    }

    this._shapeEditor.onSelectionChange(id);
    this._populatePanelEditor();
  }

  /** Find the .viewport-content child for a given panel id + content index. */
  _findContentNode(id, idx) {
    const entry = this.board.elements.get(id);
    if (!entry || !entry.element) return null;
    return entry.element.querySelector(`.viewport-content[data-content-idx="${idx}"]`);
  }

  /** Rebuild a panel and re-apply the content-selected class on the new node
   *  so live edits don't visually drop the selection on every keystroke. */
  _rebuildKeepContent(id) {
    this.board.rebuildElement(id);
    if (this._selectedId === id && this._selectedContentIdx != null) {
      const node = this._findContentNode(id, this._selectedContentIdx);
      if (node) node.classList.add('is-content-selected');
    }
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
      this._syncSidebar();
      return;
    }

    const entry = this.board.elements.get(this._selectedId);
    if (!entry) {
      body.innerHTML = '<div class="panel-editor-empty">Panel not found</div>';
      this._syncSidebar();
      return;
    }

    const { config } = entry;

    // ── Content-block selection: render only the selected block's settings ──
    if (this._selectedContentIdx != null && config.type === 'viewport') {
      this._renderContentEditor(body, config, this._selectedContentIdx);
      this._syncSidebar();
      return;
    }

    // Header — type dropdown + id
    const header = document.createElement('div');
    header.classList.add('pe-header');

    if (config.type === 'line' || config.type === 'viewport' || config.type === 'picture' || config.type === 'iframe') {
      const typeLabel = document.createElement('div');
      typeLabel.classList.add('pe-type-readonly');
      typeLabel.textContent = config.type === 'line'
        ? 'Line'
        : config.type === 'picture'
          ? 'Image'
          : config.type === 'iframe'
            ? 'Iframe'
            : 'Viewport';
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
    } else if (config.type === 'picture') {
      // Pictures: image-specific controls only (no border / shape / bg).
      body.appendChild(this._buildPictureEditor(config));
    } else if (config.type === 'iframe') {
      // Iframes: src + minimal style controls (no border-stitch / shape / texture).
      body.appendChild(this._buildIframeEditor(config));
    } else {
      // Type-specific controls first (the important stuff)
      if (config.type === 'text') {
        body.appendChild(this._buildTextEditor(config));
      } else if (config.type === 'image') {
        body.appendChild(this._buildImageEditor(config));
      } else if (config.type === 'split') {
        body.appendChild(this._buildSplitEditor(config));
      } else if (config.type === 'viewport') {
        body.appendChild(this._buildViewportContentList(config));
      }

      // Design section
      body.appendChild(this._buildDesignEditor(config));

      // Shape section
      body.appendChild(this._shapeEditor.buildShapeSection(config));
    }

    // Border effect section — skip for pictures and iframes (no peg-border)
    if (config.type !== 'picture' && config.type !== 'iframe') {
      body.appendChild(this._buildBorderStitchSection(config));
    }

    // Spawn section — controls when the element first appears. Decoupled from
    // Animation so it works for elements with no entrance animation (lines,
    // plain panels). Applies to all types.
    body.appendChild(this._buildSpawnSection(config));

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

    // Locked — element stays glued to the viewport regardless of scroll
    const lockedCheck = document.createElement('input');
    lockedCheck.type = 'checkbox';
    lockedCheck.checked = !!config.locked;
    lockedCheck.addEventListener('change', () => {
      config.locked = lockedCheck.checked;
      this.board._applyParallaxScroll();
      this.board._applyAllLockedStates();
    });
    posSection.appendChild(this._peField('Locked', lockedCheck));

    body.appendChild(posSection);

    this._syncSidebar();
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

  /* Picture editor — free-floating image element. No border / shape / bg.
     Source replace via file picker (uploads + content-hashes), alt, fit,
     opacity, and rotation. Hover-lift toggle as well since drop-shadow
     follows the PNG alpha. */
  _buildPictureEditor(config) {
    const section = this._peSection('Image', true);
    const content = config.content || (config.content = {});
    const style = config.style || (config.style = {});

    // Preview thumbnail
    const preview = document.createElement('div');
    preview.style.cssText = 'width:100%;height:80px;background:#0008;border:1px solid var(--ed-border, #2a2a2a);display:flex;align-items:center;justify-content:center;margin-bottom:0.5rem;border-radius:4px;overflow:hidden;';
    const previewImg = document.createElement('img');
    previewImg.src = content.src || '/placeholder.svg';
    previewImg.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain;';
    preview.appendChild(previewImg);
    section.appendChild(preview);

    // Replace button — pops file picker, uploads, swaps src in place
    const replaceBtn = document.createElement('button');
    replaceBtn.classList.add('pe-input');
    replaceBtn.textContent = 'Replace image…';
    replaceBtn.style.cursor = 'pointer';
    replaceBtn.style.marginBottom = '0.35rem';
    replaceBtn.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) return;
        try {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
          });
          const res = await fetch('/api/upload-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dataUrl, mime: file.type }),
          });
          const data = await res.json();
          if (!data.ok) {
            this._flash(`Upload failed: ${data.error || 'unknown'}`);
            return;
          }
          content.src = data.path;
          previewImg.src = data.path;
          this._rebuildSelected();
        } catch (err) {
          this._flash(`Upload failed: ${err.message || err}`);
        }
      });
      input.click();
    });
    section.appendChild(replaceBtn);

    // Alt text
    const altInput = document.createElement('input');
    altInput.type = 'text';
    altInput.classList.add('pe-input');
    altInput.value = content.alt || '';
    altInput.addEventListener('input', () => {
      content.alt = altInput.value;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('Alt', altInput));

    // Fit mode
    const fitSel = document.createElement('select');
    fitSel.classList.add('pe-input');
    [['contain', 'Contain (fit inside)'], ['cover', 'Cover (fill, crop)'], ['fill', 'Fill (stretch)']].forEach(([v, l]) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = l;
      if ((content.fit || 'contain') === v) o.selected = true;
      fitSel.appendChild(o);
    });
    fitSel.addEventListener('change', () => {
      content.fit = fitSel.value;
      this.board.applyDesign(config.id);
    });
    section.appendChild(this._peField('Fit', fitSel));

    // Opacity (0..1)
    const opacityInput = this._peNumberInput(style.opacity ?? 1, 0, 1, 0.05, (v) => {
      style.opacity = v;
      this.board.applyDesign(config.id);
    });
    section.appendChild(this._peField('Opacity', opacityInput));

    // Rotation (-180..180 deg)
    const rotInput = this._peNumberInput(style.rotation ?? 0, -180, 180, 1, (v) => {
      style.rotation = v;
      this.board.applyDesign(config.id);
    });
    section.appendChild(this._peField('Rotation°', rotInput));

    // Hover lift (drop-shadow on hover, follows PNG alpha)
    const liftCheck = document.createElement('input');
    liftCheck.type = 'checkbox';
    liftCheck.checked = style.hoverLift !== false ? !!style.hoverLift : false;
    // Default off for pictures (decorative); the !== false default applies to panels.
    if (style.hoverLift === undefined) {
      style.hoverLift = false;
      liftCheck.checked = false;
    }
    liftCheck.addEventListener('change', () => {
      style.hoverLift = liftCheck.checked;
      this.board.applyDesign(config.id);
    });
    section.appendChild(this._peField('Hover lift', liftCheck));

    return section;
  }

  /* Iframe editor — embed an external URL. Live src text input rebuilds the
     iframe (changing the src on the existing iframe element would also work,
     but rebuild keeps the path uniform with every other element type). */
  _buildIframeEditor(config) {
    const section = this._peSection('Embed', true);
    const content = config.content || (config.content = {});
    const style = config.style || (config.style = {});

    const srcInput = document.createElement('input');
    srcInput.type = 'text';
    srcInput.classList.add('pe-input');
    srcInput.value = content.src || '';
    srcInput.placeholder = '/games/stitch-arcade/';
    srcInput.addEventListener('input', () => {
      content.src = srcInput.value;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('URL', srcInput));

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.classList.add('pe-input');
    titleInput.value = content.title || '';
    titleInput.placeholder = 'Embedded content';
    titleInput.addEventListener('input', () => {
      content.title = titleInput.value || undefined;
      this._rebuildSelected();
    });
    section.appendChild(this._peField('Title', titleInput));

    const radiusInput = this._peNumberInput(style.borderRadius ?? 0, 0, 200, 1, (v) => {
      style.borderRadius = v;
      this.board.applyDesign(config.id);
    });
    section.appendChild(this._peField('Radius', radiusInput));

    const opacityInput = this._peNumberInput(style.opacity ?? 1, 0, 1, 0.05, (v) => {
      style.opacity = v;
      this.board.applyDesign(config.id);
    });
    section.appendChild(this._peField('Opacity', opacityInput));

    const rotInput = this._peNumberInput(style.rotation ?? 0, -180, 180, 1, (v) => {
      style.rotation = v;
      this.board.applyDesign(config.id);
    });
    section.appendChild(this._peField('Rotation°', rotInput));

    const hint = document.createElement('div');
    hint.classList.add('pe-hint');
    hint.textContent = 'Click into the iframe in live mode to focus it (keys flow through). In edit mode the iframe is click-through so the panel stays draggable.';
    section.appendChild(hint);

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

  // ── Viewport content list (panel-level) ──

  _buildViewportContentList(config) {
    if (!Array.isArray(config.contents)) config.contents = [];
    const section = this._peSection('Contents', true);

    const hint = document.createElement('div');
    hint.classList.add('pe-hint');
    hint.textContent = 'Right-click viewport to add text or image. Click a content block to edit it.';
    section.appendChild(hint);

    if (!config.contents.length) {
      const empty = document.createElement('div');
      empty.classList.add('pe-hint');
      empty.style.cssText = 'margin-top:0.5rem;color:#888;';
      empty.textContent = 'No content yet.';
      section.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.classList.add('pe-content-list');
      config.contents.forEach((c, i) => {
        const row = document.createElement('div');
        row.classList.add('pe-content-row');
        const label = document.createElement('span');
        label.textContent = `${i + 1}. ${c.kind === 'text' ? 'Text' : 'Image'}`;
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.classList.add('edit-btn');
        editBtn.textContent = 'Edit';
        editBtn.addEventListener('click', () => this._selectElement(config.id, i));
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.classList.add('edit-btn');
        rm.textContent = '✕';
        rm.addEventListener('click', () => this._deleteContent(config.id, i));
        row.append(label, editBtn, rm);
        list.appendChild(row);
      });
      section.appendChild(list);
    }

    const addText = document.createElement('button');
    addText.type = 'button';
    addText.classList.add('edit-btn');
    addText.textContent = '+ Text';
    addText.addEventListener('click', () => this._addContent(config.id, 'text'));
    const addImg = document.createElement('button');
    addImg.type = 'button';
    addImg.classList.add('edit-btn');
    addImg.textContent = '+ Image';
    addImg.addEventListener('click', () => this._addContent(config.id, 'image'));
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:0.25rem;margin-top:0.5rem;';
    btnRow.append(addText, addImg);
    section.appendChild(btnRow);

    return section;
  }

  /** Add a new content block (text or image) to a viewport, then select it. */
  _addContent(id, kind) {
    const entry = this.board.elements.get(id);
    if (!entry || entry.config.type !== 'viewport') return;
    if (!Array.isArray(entry.config.contents)) entry.config.contents = [];

    const baseFrame = { x: 20, y: 35, width: 60, height: 30, rotation: 0 };
    let block;
    if (kind === 'text') {
      block = {
        kind: 'text',
        frame: baseFrame,
        html: 'New text',
        fontSize: 8,
        fontFamily: 'Inter',
        color: '#e8e8e8',
        hAlign: 'left',
        vAlign: 'flex-start',
      };
    } else {
      block = {
        kind: 'image',
        frame: { x: 20, y: 20, width: 60, height: 60, rotation: 0 },
        src: '/placeholder.svg',
        alt: '',
        fit: 'cover',
        opacity: 1,
      };
    }
    entry.config.contents.push(block);
    this.board.rebuildElement(id);
    this._selectElement(id, entry.config.contents.length - 1);
  }

  _deleteContent(id, idx) {
    const entry = this.board.elements.get(id);
    if (!entry || !Array.isArray(entry.config.contents)) return;
    entry.config.contents.splice(idx, 1);
    this.board.rebuildElement(id);
    // If the deleted (or a later) content was selected, drop selection back to panel
    if (this._selectedId === id && this._selectedContentIdx != null) {
      if (this._selectedContentIdx >= entry.config.contents.length) {
        this._selectElement(id, null);
      } else {
        this._selectElement(id, this._selectedContentIdx);
      }
    } else {
      this._populatePanelEditor();
    }
  }

  // ── Content-block editor (sidebar shows this when a content block is selected) ──

  _renderContentEditor(body, config, idx) {
    const c = config.contents[idx];
    if (!c) {
      body.innerHTML = '<div class="panel-editor-empty">Content not found</div>';
      return;
    }

    // Header — kind label + Back-to-panel + Delete
    const header = document.createElement('div');
    header.classList.add('pe-header');
    const kindLabel = document.createElement('div');
    kindLabel.classList.add('pe-type-readonly');
    kindLabel.textContent = c.kind === 'text' ? 'Text content' : 'Image content';
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.classList.add('edit-btn');
    backBtn.textContent = '← Panel';
    backBtn.addEventListener('click', () => this._selectElement(config.id, null));
    header.append(kindLabel, backBtn);
    body.appendChild(header);

    if (c.kind === 'text') {
      body.appendChild(this._buildContentTextEditor(config, idx, c));
    } else {
      body.appendChild(this._buildContentImageEditor(config, idx, c));
    }

    body.appendChild(this._buildContentFrameSection(config, idx, c));

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.classList.add('edit-btn');
    delBtn.style.cssText = 'margin-top:0.75rem;color:#ff8888;border-color:#552222;';
    delBtn.textContent = 'Delete content';
    delBtn.addEventListener('click', () => this._deleteContent(config.id, idx));
    body.appendChild(delBtn);
  }

  _buildContentTextEditor(config, idx, c) {
    const section = this._peSection('Text', true);
    const apply = () => this._rebuildKeepContent(config.id);

    // Rich text
    const rt = this._buildRichTextArea(c.html || '', (html) => {
      c.html = html;
      apply();
    });
    section.appendChild(this._peField('Text', rt));

    // Font family
    const fontSel = document.createElement('select');
    fontSel.classList.add('pe-input');
    ['Inter', ...FONT_LIST.filter(f => f !== 'Inter')].forEach(f => {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f;
      if ((c.fontFamily || 'Inter') === f) opt.selected = true;
      fontSel.appendChild(opt);
    });
    fontSel.addEventListener('change', () => {
      c.fontFamily = fontSel.value;
      ensureFontLoaded(fontSel.value);
      apply();
    });
    section.appendChild(this._peField('Font', fontSel));

    const fsInput = this._peNumberInput(c.fontSize ?? 8, 1, 30, 0.5, (v) => {
      c.fontSize = v; apply();
    });
    section.appendChild(this._peField('Size (cqi)', fsInput));

    const colorInput = this._peColorInput(c.color || '#e8e8e8', (v) => {
      c.color = v; apply();
    });
    section.appendChild(this._peField('Color', colorInput));

    // H align
    const hSel = document.createElement('select');
    hSel.classList.add('pe-input');
    ['left', 'center', 'right'].forEach(v => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v[0].toUpperCase() + v.slice(1);
      if ((c.hAlign || 'left') === v) opt.selected = true;
      hSel.appendChild(opt);
    });
    hSel.addEventListener('change', () => { c.hAlign = hSel.value; apply(); });
    section.appendChild(this._peField('H align', hSel));

    // V align
    const vSel = document.createElement('select');
    vSel.classList.add('pe-input');
    [['top', 'flex-start'], ['center', 'center'], ['bottom', 'flex-end']].forEach(([lbl, val]) => {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = lbl[0].toUpperCase() + lbl.slice(1);
      if ((c.vAlign || 'flex-start') === val) opt.selected = true;
      vSel.appendChild(opt);
    });
    vSel.addEventListener('change', () => { c.vAlign = vSel.value; apply(); });
    section.appendChild(this._peField('V align', vSel));

    return section;
  }

  _buildContentImageEditor(config, idx, c) {
    const section = this._peSection('Image', true);
    const apply = () => this._rebuildKeepContent(config.id);

    const srcInput = document.createElement('input');
    srcInput.type = 'text';
    srcInput.classList.add('pe-input');
    srcInput.value = c.src || '';
    srcInput.addEventListener('input', () => { c.src = srcInput.value; apply(); });
    section.appendChild(this._peField('URL', srcInput));

    const altInput = document.createElement('input');
    altInput.type = 'text';
    altInput.classList.add('pe-input');
    altInput.value = c.alt || '';
    altInput.addEventListener('input', () => { c.alt = altInput.value; apply(); });
    section.appendChild(this._peField('Alt text', altInput));

    const fitSel = document.createElement('select');
    fitSel.classList.add('pe-input');
    ['cover', 'contain', 'fill', 'none', 'scale-down'].forEach(v => {
      const opt = document.createElement('option');
      opt.value = v; opt.textContent = v;
      if ((c.fit || 'cover') === v) opt.selected = true;
      fitSel.appendChild(opt);
    });
    fitSel.addEventListener('change', () => { c.fit = fitSel.value; apply(); });
    section.appendChild(this._peField('Fit', fitSel));

    const opInput = document.createElement('input');
    opInput.type = 'range';
    opInput.classList.add('pe-input', 'pe-range');
    opInput.min = '0'; opInput.max = '1'; opInput.step = '0.05';
    opInput.value = c.opacity ?? 1;
    opInput.addEventListener('input', () => { c.opacity = parseFloat(opInput.value); apply(); });
    section.appendChild(this._peField('Opacity', opInput));

    const capInput = document.createElement('input');
    capInput.type = 'text';
    capInput.classList.add('pe-input');
    capInput.value = c.caption || '';
    capInput.placeholder = 'Optional caption';
    capInput.addEventListener('input', () => { c.caption = capInput.value || undefined; apply(); });
    section.appendChild(this._peField('Caption', capInput));

    return section;
  }

  _buildContentFrameSection(config, idx, c) {
    if (!c.frame) c.frame = { x: 0, y: 0, width: 100, height: 100, rotation: 0 };
    const f = c.frame;
    const section = this._peSection('Frame', true);

    const live = () => {
      const node = this._findContentNode(config.id, idx);
      if (node) applyContentFrame(node, f);
      // Also keep the green frame overlay in sync
      if (this._frameOverlay) {
        const ov = this._frameOverlay.querySelector('.text-frame-overlay');
        if (ov) {
          ov.style.left = `${f.x}%`;
          ov.style.top = `${f.y}%`;
          ov.style.width = `${f.width}%`;
          ov.style.height = `${f.height}%`;
          ov.style.transform = f.rotation ? `rotate(${f.rotation}deg)` : '';
        }
      }
    };

    section.appendChild(this._peField('X %', this._peNumberInput(f.x, -50, 150, 1, (v) => { f.x = v; live(); })));
    section.appendChild(this._peField('Y %', this._peNumberInput(f.y, -50, 150, 1, (v) => { f.y = v; live(); })));
    section.appendChild(this._peField('W %', this._peNumberInput(f.width, 1, 200, 1, (v) => { f.width = v; live(); })));
    section.appendChild(this._peField('H %', this._peNumberInput(f.height, 1, 200, 1, (v) => { f.height = v; live(); })));
    section.appendChild(this._peField('Rotation', this._peNumberInput(f.rotation, -180, 180, 1, (v) => { f.rotation = v; live(); })));
    return section;
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

    // Hover lift — drop shadow on hover in live preview
    const hoverLiftCheck = document.createElement('input');
    hoverLiftCheck.type = 'checkbox';
    hoverLiftCheck.checked = s.hoverLift !== false;
    hoverLiftCheck.addEventListener('change', () => {
      s.hoverLift = hoverLiftCheck.checked;
      applyDesign();
    });
    section.appendChild(this._peField('Hover lift', hoverLiftCheck));

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

    // Texture — material overlay tinted by bg color. Panel-only (doesn't
    // affect the stitched border or split halves).
    if (config.type !== 'split') {
      if (!s.texture) s.texture = { type: 'none' };
      const texSel = document.createElement('select');
      texSel.classList.add('pe-input');
      [
        ['none', 'Flat'],
        ['felt', 'Felt'],
        ['wool', 'Wool'],
        ['denim', 'Denim'],
        ['canvas', 'Canvas'],
      ].forEach(([val, lbl]) => {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = lbl;
        if (s.texture.type === val) opt.selected = true;
        texSel.appendChild(opt);
      });
      texSel.addEventListener('change', () => {
        s.texture.type = texSel.value;
        applyDesign();
      });
      section.appendChild(this._peField('Texture', texSel));
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

    // Edge mode — three modes, parallel to polygon shapes:
    //   sharp:   straight anchor-to-anchor segments
    //   rounded: straight segments + corners rounded by borderRadius
    //   curve:   Chaikin curve through every anchor (legacy `smooth: true`)
    const edgeMode = s.edge || (s.smooth ? 'curve' : 'sharp');
    const edgeSel = document.createElement('select');
    edgeSel.classList.add('pe-input');
    [['sharp', 'Sharp'], ['rounded', 'Rounded corners'], ['curve', 'Curve']].forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      if (val === edgeMode) opt.selected = true;
      edgeSel.appendChild(opt);
    });
    edgeSel.addEventListener('change', () => {
      s.edge = edgeSel.value;
      delete s.smooth; // edge supersedes the legacy boolean
      this._populatePanelEditor(); // re-render so the radius field shows/hides
      applyDesign();
    });
    section.appendChild(this._peField('Edge', edgeSel));

    // Corner radius — only meaningful in rounded mode
    if (edgeMode === 'rounded') {
      const crInput = this._peNumberInput(s.borderRadius ?? 8, 0, 200, 1, (v) => {
        s.borderRadius = v;
        applyDesign();
      });
      section.appendChild(this._peField('Corner r', crInput));
    }

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

    // Hover lift — drop shadow on hover in live preview
    const hoverLiftCheck = document.createElement('input');
    hoverLiftCheck.type = 'checkbox';
    hoverLiftCheck.checked = s.hoverLift !== false;
    hoverLiftCheck.addEventListener('change', () => {
      s.hoverLift = hoverLiftCheck.checked;
      applyDesign();
    });
    section.appendChild(this._peField('Hover lift', hoverLiftCheck));

    // Anchor count
    const anchors = config.content?.anchors || [];
    section.appendChild(this._peReadonly('Anchors', `${anchors.length}`));

    const hint = document.createElement('div');
    hint.classList.add('pe-hint');
    hint.textContent = 'Drag anchor to move · Right-click anchor to remove';
    section.appendChild(hint);

    return section;
  }

  // ── Border effect (stitched border) ──

  _buildBorderStitchSection(config) {
    if (!config.style) config.style = {};
    const s = config.style;
    if (!s.borderStitch) s.borderStitch = { enabled: false, style: 'running', animated: true };
    const bs = s.borderStitch;
    bs.style = bs.style || 'running';
    bs.stitchLen = bs.stitchLen ?? 8;
    bs.duration = bs.duration ?? 1.0;
    bs.palette = bs.palette || 'border';
    bs.flow = !!bs.flow;
    bs.flowDir = bs.flowDir || 'cw';
    bs.flowSpeed = bs.flowSpeed ?? 60;
    bs.colorBlend = !!bs.colorBlend;

    const section = this._peSection('Border effect');
    const apply = () => {
      this.board.applyDesign(config.id);
      // Replay the entrance draw so the user sees the change immediately
      const entry = this.board.elements.get(config.id);
      if (entry?.borderStitch && bs.enabled) {
        entry.borderStitch.play();
      }
    };

    // Style dropdown — first option "Off" = disabled
    const styleSelect = document.createElement('select');
    styleSelect.classList.add('pe-input');
    const STYLES = [
      ['none', 'Off'],
      ['running', 'Running'],
      ['backstitch', 'Backstitch'],
      ['zigzag', 'Zigzag'],
      ['chain', 'Chain'],
      ['satin', 'Satin'],
      ['mixed', 'Mixed'],
      ['cross', 'Cross'],
      ['blanket', 'Blanket'],
      ['whip', 'Whip'],
      ['herringbone', 'Herringbone'],
      ['stem', 'Stem'],
      ['feather', 'Feather'],
      ['fishbone', 'Fishbone'],
      ['couching', 'Couching'],
      ['frenchKnot', 'French knot'],
    ];
    STYLES.forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      if ((bs.enabled ? bs.style : 'none') === val) opt.selected = true;
      styleSelect.appendChild(opt);
    });
    styleSelect.addEventListener('change', () => {
      if (styleSelect.value === 'none') {
        bs.enabled = false;
      } else {
        bs.enabled = true;
        bs.style = styleSelect.value;
      }
      this._populatePanelEditor(); // re-render so subfields show/hide
      apply();
    });
    section.appendChild(this._peField('Style', styleSelect));

    if (!bs.enabled) return section;

    // Animated checkbox
    const animCheck = document.createElement('input');
    animCheck.type = 'checkbox';
    animCheck.checked = bs.animated !== false;
    animCheck.addEventListener('change', () => {
      bs.animated = animCheck.checked;
      this._populatePanelEditor();
      apply();
    });
    section.appendChild(this._peField('Animated', animCheck));

    // Entrance duration (only meaningful if animated)
    if (bs.animated !== false) {
      const durInput = this._peNumberInput(bs.duration, 0.1, 10, 0.1, (v) => {
        bs.duration = v; apply();
      });
      section.appendChild(this._peField('Draw time (s)', durInput));
    }

    // Stitch size
    const sizeInput = this._peNumberInput(bs.stitchLen, 3, 30, 1, (v) => {
      bs.stitchLen = v; apply();
    });
    section.appendChild(this._peField('Stitch size', sizeInput));

    // Palette
    const palSelect = document.createElement('select');
    palSelect.classList.add('pe-input');
    [['border', 'Border color'], ['warm', 'Warm'], ['cool', 'Cool'], ['pastel', 'Pastel'], ['mono', 'Mono'], ['custom', 'Custom']].forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      if (bs.palette === val) opt.selected = true;
      palSelect.appendChild(opt);
    });
    palSelect.addEventListener('change', () => {
      bs.palette = palSelect.value;
      // Seed customColors when entering custom
      if (bs.palette === 'custom' && (!Array.isArray(bs.customColors) || !bs.customColors.length)) {
        const seed = STITCH_PALETTES.warm;
        bs.customColors = seed.slice(0, 3);
      }
      this._populatePanelEditor();
      apply();
    });
    section.appendChild(this._peField('Palette', palSelect));

    // Custom colors editor
    if (bs.palette === 'custom') {
      const listWrap = document.createElement('div');
      listWrap.classList.add('pe-color-list');
      const renderList = () => {
        listWrap.innerHTML = '';
        (bs.customColors || []).forEach((c, i) => {
          const row = document.createElement('div');
          row.classList.add('pe-color-list-item');
          const inp = document.createElement('input');
          inp.type = 'color';
          inp.value = c;
          inp.addEventListener('input', () => {
            bs.customColors[i] = inp.value; apply();
          });
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.classList.add('pe-color-list-rm');
          rm.textContent = '✕';
          rm.disabled = bs.customColors.length <= 1;
          rm.addEventListener('click', () => {
            if (bs.customColors.length > 1) {
              bs.customColors.splice(i, 1);
              renderList(); apply();
            }
          });
          row.append(inp, rm);
          listWrap.appendChild(row);
        });
        const add = document.createElement('button');
        add.type = 'button';
        add.classList.add('pe-color-list-add');
        add.textContent = '+ Add color';
        add.addEventListener('click', () => {
          const last = bs.customColors[bs.customColors.length - 1] || '#cccccc';
          bs.customColors.push(last);
          renderList(); apply();
        });
        listWrap.appendChild(add);
      };
      renderList();
      section.appendChild(this._peField('Colors', listWrap));
    }

    // Color blend — smooth interpolation between adjacent palette colors,
    // only meaningful when the palette resolves to more than one color.
    const usingMultiColors = (bs.palette !== 'border')
      && (bs.palette === 'custom'
        ? Array.isArray(bs.customColors) && bs.customColors.length > 1
        : (STITCH_PALETTES[bs.palette]?.length || 0) > 1);
    if (usingMultiColors) {
      const blendCheck = document.createElement('input');
      blendCheck.type = 'checkbox';
      blendCheck.checked = !!bs.colorBlend;
      blendCheck.title = 'Smooth fade between palette colors instead of hard color bands';
      blendCheck.addEventListener('change', () => {
        bs.colorBlend = blendCheck.checked;
        apply();
      });
      section.appendChild(this._peField('Blend colors', blendCheck));
    }

    // Flow (continuous palette drift around the perimeter)
    const flowCheck = document.createElement('input');
    flowCheck.type = 'checkbox';
    flowCheck.checked = !!bs.flow;
    flowCheck.addEventListener('change', () => {
      bs.flow = flowCheck.checked;
      this._populatePanelEditor();
      apply();
    });
    section.appendChild(this._peField('Color flow', flowCheck));

    if (bs.flow) {
      const dirSelect = document.createElement('select');
      dirSelect.classList.add('pe-input');
      [['cw', 'Clockwise'], ['ccw', 'Counter-clockwise']].forEach(([val, lbl]) => {
        const opt = document.createElement('option');
        opt.value = val; opt.textContent = lbl;
        if (bs.flowDir === val) opt.selected = true;
        dirSelect.appendChild(opt);
      });
      dirSelect.addEventListener('change', () => { bs.flowDir = dirSelect.value; apply(); });
      section.appendChild(this._peField('Direction', dirSelect));

      const speedInput = this._peNumberInput(bs.flowSpeed, 5, 400, 5, (v) => {
        bs.flowSpeed = v; apply();
      });
      section.appendChild(this._peField('Flow speed', speedInput));
    }

    return section;
  }

  // ── Animation editor ──

  /** Spawn section — when does this element first appear? Lives outside the
   *  Animation section so it applies even when no entrance animation is
   *  configured (lines, plain panels). Defaults make the section a no-op:
   *  spawn row = element's gridRow, delay = 0. */
  _buildSpawnSection(config) {
    const section = this._peSection('Spawn');

    // One-time migration: older layouts kept the entrance trigger row inside
    // animation.triggerRow and a brief experiment kept entranceDelay there
    // too. Lift them onto config.* on first edit so the new fields become
    // authoritative; future saves don't have to read both.
    const a = config.animation;
    if (config.spawnRow == null && a?.triggerRow != null) config.spawnRow = a.triggerRow;
    if (config.spawnDelay == null && a?.entranceDelay != null) config.spawnDelay = a.entranceDelay;

    const rowInput = this._peNumberInput(
      config.spawnRow ?? config.gridRow, 1, 999, 1,
      (v) => { config.spawnRow = v; },
    );
    section.appendChild(this._peField('Spawn row', rowInput));

    const delayInput = this._peNumberInput(
      config.spawnDelay ?? 0, 0, 10, 0.05,
      (v) => { config.spawnDelay = v; },
    );
    section.appendChild(this._peField('Delay (s)', delayInput));

    const hint = document.createElement('div');
    hint.classList.add('pe-hint');
    hint.textContent = 'Element appears when scroll reaches the spawn row, then waits this long before showing. Works without animation.';
    section.appendChild(hint);

    return section;
  }

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

    // Entrance duration only — the trigger row + delay live in the Spawn
    // section now (they apply with or without animation).
    const entranceDurInput = this._peNumberInput(
      a.entranceDuration ?? defaultDur, 0.1, 3, 0.1,
      (v) => { a.entranceDuration = v; },
    );
    fields.appendChild(this._peField('Entrance duration (s)', entranceDurInput));

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

    // Exit row + duration. Fallback chain: explicit exitTriggerRow → spawnRow
    // (the new home for what used to be triggerRow) → legacy triggerRow →
    // gridRow.
    fields.appendChild(buildRowDurPair(
      'Exit row',
      a.exitTriggerRow ?? config.spawnRow ?? a.triggerRow ?? defaultRow,
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

    // Scroll row + duration. Same fallback chain as exit row.
    fields.appendChild(buildRowDurPair(
      'Scroll row',
      a.scrollTriggerRow ?? config.spawnRow ?? a.triggerRow ?? defaultRow,
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
    this._frameTarget = null;
  }

  _showFrameHandles(id, contentIdx = null) {
    // Remove old overlay
    if (this._frameOverlay) {
      this._frameOverlay.remove();
      this._frameOverlay = null;
    }

    const entry = this.board.elements.get(id);
    if (!entry) return;
    const { config, wrapper } = entry;

    // Resolve the frame source: a viewport content block when contentIdx is
    // given, otherwise a legacy text panel's content.frame.
    let target;
    if (contentIdx != null && Array.isArray(config.contents) && config.contents[contentIdx]) {
      target = config.contents[contentIdx];
    } else {
      target = config.content;
    }
    if (!target.frame) {
      target.frame = { x: 0, y: 0, width: 100, height: 100, rotation: 0 };
    }
    const f = target.frame;
    this._frameTarget = { id, contentIdx };

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

  /** Resolve the active frame target — either a viewport content block or a
   *  legacy text panel's content.frame — without a full rebuild. */
  _resolveFrameTarget(id) {
    const entry = this.board.elements.get(id);
    if (!entry) return null;
    const tgt = this._frameTarget;
    if (tgt && tgt.id === id && tgt.contentIdx != null) {
      const c = entry.config.contents?.[tgt.contentIdx];
      if (c) return { entry, frame: c.frame, contentIdx: tgt.contentIdx };
    }
    return { entry, frame: entry.config.content?.frame, contentIdx: null };
  }

  /** Update the live element's frame styles without a full rebuild. */
  _applyFrameStyle(id) {
    const t = this._resolveFrameTarget(id);
    if (!t || !t.frame) return;
    const f = t.frame;
    if (t.contentIdx != null) {
      const node = this._findContentNode(id, t.contentIdx);
      if (node) applyContentFrame(node, f);
      return;
    }
    const el = t.entry.element;
    if (!el) return;
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
    const t = this._resolveFrameTarget(id);
    if (!t) return;
    if (!t.frame) {
      // Initialize frame on the resolved owner
      const entry = this.board.elements.get(id);
      if (!entry) return;
      const owner = (t.contentIdx != null)
        ? entry.config.contents[t.contentIdx]
        : entry.config.content;
      owner.frame = { x: 0, y: 0, width: 100, height: 100, rotation: 0 };
      t.frame = owner.frame;
    }
    const f = t.frame;
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
      this._syncFrameOverlayPos(f);
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

  /** Update the live frame overlay's left/top/width/height/transform from a
   *  frame object. No-op when no overlay is currently shown. */
  _syncFrameOverlayPos(f) {
    if (!this._frameOverlay) return;
    const ov = this._frameOverlay.querySelector('.text-frame-overlay');
    if (!ov) return;
    ov.style.left = `${f.x}%`;
    ov.style.top = `${f.y}%`;
    ov.style.width = `${f.width}%`;
    ov.style.height = `${f.height}%`;
    ov.style.transform = f.rotation ? `rotate(${f.rotation}deg)` : '';
  }

  _startFrameDrag(id, overlay, e) {
    const t = this._resolveFrameTarget(id);
    if (!t || !t.frame) return;
    const wrapper = t.entry.wrapper;
    const f = t.frame;
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
    const t = this._resolveFrameTarget(id);
    if (!t || !t.frame) return;
    const wrapper = t.entry.wrapper;
    const f = t.frame;
    const rect = wrapper.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const startFx = f.x;
    const startFy = f.y;
    const startFw = f.width;
    const startFh = f.height;

    overlay.setPointerCapture(e.pointerId);

    // Frames are allowed to extend beyond the panel — the panel's .shape-clip
    // layer clips visually, but the data can hold any positive size and any
    // x/y (including negative or > 100% for offscreen content).
    const onMove = (me) => {
      const dx = ((me.clientX - startX) / rect.width) * 100;
      const dy = ((me.clientY - startY) / rect.height) * 100;

      if (corner.includes('right')) {
        f.width = Math.round(Math.max(5, startFw + dx));
      }
      if (corner.includes('left')) {
        const newX = startFx + dx;
        const newW = startFw - (newX - startFx);
        if (newW >= 5) { f.x = Math.round(newX); f.width = Math.round(newW); }
      }
      if (corner.includes('bottom')) {
        f.height = Math.round(Math.max(5, startFh + dy));
      }
      if (corner.includes('top')) {
        const newY = startFy + dy;
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
    const t = this._resolveFrameTarget(id);
    if (!t || !t.frame) return;
    const wrapper = t.entry.wrapper;
    const f = t.frame;
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

    // Use clientWidth/clientHeight (unzoomed) since the overlay is inside the container
    const cw = this.board.container.clientWidth;
    const ch = this.board.container.clientHeight;
    const cols = this.board.columns;
    const gap = this.board.gap;
    const totalGap = (cols - 1) * gap;
    const colWidth = (cw - totalGap) / cols;

    for (let i = 0; i <= cols; i++) {
      const line = document.createElement('div');
      line.classList.add('edit-grid-line', 'edit-grid-line-v');
      line.style.left = `${i * (colWidth + gap) - gap / 2}px`;
      overlay.appendChild(line);
    }

    const cellH = this.board.rowHeight + gap;
    const rowCount = Math.ceil(ch / cellH) + 4;
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

      // Viewport: clicking a content node selects/drags that content block.
      // Empty area falls through to panel select+drag.
      if (config.type === 'viewport') {
        const node = e.target.closest('.viewport-content');
        const liveEntry = this.board.elements.get(config.id);
        if (node && liveEntry && node.parentElement === liveEntry.element) {
          const idx = parseInt(node.dataset.contentIdx, 10);
          e.preventDefault();
          if (this._selectedId !== config.id || this._selectedContentIdx !== idx) {
            this._selectElement(config.id, idx);
          }
          // Drag the content frame
          this._frameTarget = { id: config.id, contentIdx: idx };
          this._startInlineFrameDrag(config.id, wrapper, e);
          return;
        }
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
    const zoom = this.board._zoomFactor || 1;
    // cellW used here represents grid PITCH (cell + gap), matching how cellH
    // is computed below. The previous `containerWidth / columns` formula
    // ignored the gap entirely, which underestimated pitch by `gap/columns`
    // px per column — a small per-cell error that compounded with column
    // index. Symptom was a duplicated panel acting like its spawn position
    // was its top-left clamp: offsetCols/Rows captured at click time were
    // slightly off, so cell.col - offsetCols pinned at the spawn cell when
    // the cursor moved leftward over the gap regions.
    const cellW = (containerRect.width + this.board.gap * zoom) / this.board.columns;
    const cellH = (this.board.rowHeight + this.board.gap) * zoom;

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
    const zoom = this.board._zoomFactor || 1;
    // Grid pitch — see _startDrag for why this is gap-aware.
    const cellW = (containerRect.width + this.board.gap * zoom) / this.board.columns;
    const cellH = (this.board.rowHeight + this.board.gap) * zoom;

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
    let clickedElement = e.target.closest('.peg-element');
    // Right-clicking the frame overlay (grid sibling — not a panel child) acts
    // as a right-click on the content block it represents.
    let overlayContentTarget = null;
    if (!clickedElement && e.target.closest('.text-frame-container')
        && this._frameTarget && this._frameTarget.contentIdx != null) {
      const fEntry = this.board.elements.get(this._frameTarget.id);
      if (fEntry) {
        clickedElement = fEntry.wrapper;
        overlayContentTarget = this._frameTarget.contentIdx;
      }
    }

    const menu = document.createElement('div');
    menu.classList.add('edit-context-menu');
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;

    if (clickedElement) {
      const id = clickedElement.dataset.id;
      const entry = this.board.elements.get(id);

      // Viewport-aware: detect right-click on a content node vs. empty area
      const contentNode = e.target.closest('.viewport-content');
      const onContent = (overlayContentTarget != null)
        || (contentNode
          && entry?.config?.type === 'viewport'
          && contentNode.parentElement === entry.element);

      if (onContent) {
        const idx = (overlayContentTarget != null)
          ? overlayContentTarget
          : parseInt(contentNode.dataset.contentIdx, 10);
        this._addMenuItem(menu, 'Edit content', () => {
          this._selectElement(id, idx);
          this._dismissMenu();
        });
        this._addMenuItem(menu, 'Delete content', () => {
          this._deleteContent(id, idx);
          this._dismissMenu();
        });
        const sep = document.createElement('div');
        sep.style.cssText = 'border-top:1px solid #2a2a2a;margin:0.25rem 0;';
        menu.appendChild(sep);
      } else if (entry?.config?.type === 'viewport') {
        this._addMenuItem(menu, 'Add text', () => {
          this._addContent(id, 'text');
          this._dismissMenu();
        });
        this._addMenuItem(menu, 'Add image', () => {
          this._addContent(id, 'image');
          this._dismissMenu();
        });
        const sep = document.createElement('div');
        sep.style.cssText = 'border-top:1px solid #2a2a2a;margin:0.25rem 0;';
        menu.appendChild(sep);
      }

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
      // New panels default to viewport type — empty container that hosts
      // text/image content blocks added via right-click.
      this._addSubmenu(menu, 'New panel', shapes.map(shape => ({
        label: shape,
        action: () => {
          this._enterDrawMode('viewport', shape.toLowerCase());
          this._dismissMenu();
        },
      })));
      this._addSubmenu(menu, 'Split panel', shapes.map(shape => ({
        label: shape,
        action: () => {
          this._enterDrawMode('split', shape.toLowerCase());
          this._dismissMenu();
        },
      })));

      this._addMenuItem(menu, 'Add line', () => {
        this._enterLineMode();
        this._dismissMenu();
      });

      this._addMenuItem(menu, 'Add image', () => {
        this._dismissMenu();
        this._addPictureAtCell(cell);
      });

      this._addMenuItem(menu, 'Add iframe', () => {
        this._dismissMenu();
        this._addIframeAtCell(cell);
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
      viewport: null, // viewport stores contents in config.contents, not config.content
    };

    const config = {
      id: uniqueId(type),
      type,
      gridColumn: col,
      gridRow: row,
      colSpan,
      rowSpan,
      style: {},
    };
    if (type === 'viewport') {
      config.contents = [];
      // Soft red default border so freshly-created viewports are easy to spot
      config.style.borderColor = '#cc4444';
      config.style.borderWidth = 2;
      config.style.bgColor = '#141414';
    } else {
      config.content = defaults[type];
    }

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
        edge: 'sharp',
      };
    }

    this.board.addElement(config);
    const entry = this.board.elements.get(config.id);
    if (entry) {
      this._makeEditable(entry.wrapper, entry.config);
      this._selectElement(config.id);
    }
  }

  /* Add a picture (free-floating image) at the given grid cell. Pops a hidden
     file input, reads the file as a data URL, posts to /api/upload-image to
     persist it under public/uploads/, then creates a picture element sized to
     the image's natural aspect ratio (capped at 12 cols / 8 rows). */
  _addPictureAtCell(cell) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif,image/svg+xml';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const naturalSize = await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => resolve({ w: 1, h: 1 });
          img.src = dataUrl;
        });

        const res = await fetch('/api/upload-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl, mime: file.type }),
        });
        const data = await res.json();
        if (!data.ok) {
          this._flash(`Upload failed: ${data.error || 'unknown'}`);
          return;
        }

        // Size to natural aspect ratio, max 12x8 grid cells.
        const maxCols = 12, maxRows = 8;
        const aspect = naturalSize.w / naturalSize.h;
        let colSpan, rowSpan;
        if (aspect >= 1) {
          colSpan = maxCols;
          rowSpan = Math.max(1, Math.round(maxCols / aspect));
          if (rowSpan > maxRows) {
            rowSpan = maxRows;
            colSpan = Math.max(1, Math.round(maxRows * aspect));
          }
        } else {
          rowSpan = maxRows;
          colSpan = Math.max(1, Math.round(maxRows * aspect));
        }

        const col = Math.max(1, Math.min(this.board.columns - colSpan + 1, cell.col));
        const row = Math.max(1, cell.row);

        const config = {
          id: uniqueId('picture'),
          type: 'picture',
          gridColumn: col,
          gridRow: row,
          colSpan,
          rowSpan,
          layer: 1,
          content: { src: data.path, alt: file.name, fit: 'contain' },
          style: { rotation: 0, opacity: 1, hoverLift: false },
        };
        this.board.addElement(config);
        const entry = this.board.elements.get(config.id);
        if (entry) {
          this._makeEditable(entry.wrapper, entry.config);
          this._selectElement(config.id);
        }
      } catch (err) {
        this._flash(`Upload failed: ${err.message || err}`);
      }
    });
    input.click();
  }

  /* Add a blank iframe panel at the given grid cell. Defaults to the stitch
     arcade game URL since that's the first embed; users can edit the URL in
     the sidebar afterward. Default size (8×10 cells) accommodates the game's
     ~560×640 cabinet at typical zoom; resize as desired. */
  _addIframeAtCell(cell) {
    const colSpan = 8;
    const rowSpan = 10;
    const col = Math.max(1, Math.min(this.board.columns - colSpan + 1, cell.col));
    const row = Math.max(1, cell.row);

    const config = {
      id: uniqueId('iframe'),
      type: 'iframe',
      gridColumn: col,
      gridRow: row,
      colSpan,
      rowSpan,
      layer: 1,
      content: { src: '/games/stitch-arcade/', title: 'Stitch Arcade' },
      style: { borderRadius: 0, opacity: 1, rotation: 0, hoverLift: false },
    };
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
    const zoom = this.board._zoomFactor || 1;
    const px = (clientX - containerRect.left) / zoom;
    const py = (clientY - containerRect.top) / zoom;
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
    const zoom = this.board._zoomFactor || 1;
    // Grid pitch — see _startDrag for why this is gap-aware.
    const cellW = (containerRect.width + this.board.gap * zoom) / this.board.columns;
    const cellH = (this.board.rowHeight + this.board.gap) * zoom;
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
    // Ensure defaults exist for fields that may be missing. Migrate older
    // two-stop layouts (color1/color2) into the canonical `colors` array; the
    // legacy fields are dropped so the UI doesn't have to re-sync them.
    if (!Array.isArray(state.colors) || state.colors.length === 0) {
      state.colors = [state.color1 || '#0a0a0a', state.color2 || '#1a1a3a'];
    }
    delete state.color1;
    delete state.color2;
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

    // Colors — single dynamic list. Solid uses colors[0]; gradient/animated
    // use the full array (min 2). Add/remove rows as needed.
    const colorsRow = mkField('Colors');
    const colorsList = document.createElement('div');
    colorsList.classList.add('bg-modal-color-list');
    colorsRow.appendChild(colorsList);
    const renderColors = () => {
      colorsList.innerHTML = '';
      const isSolid = state.type === 'solid';
      const min = isSolid ? 1 : 2;
      // Solid only ever renders one swatch — extras are kept in state but hidden.
      const visibleCount = isSolid ? 1 : state.colors.length;
      for (let i = 0; i < visibleCount; i++) {
        const item = document.createElement('div');
        item.classList.add('bg-modal-color-item');
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = state.colors[i];
        inp.addEventListener('input', () => {
          state.colors[i] = inp.value;
          apply();
        });
        item.appendChild(inp);
        if (!isSolid) {
          const rm = document.createElement('button');
          rm.type = 'button';
          rm.classList.add('bg-modal-color-rm');
          rm.textContent = '✕';
          rm.title = 'Remove color';
          rm.disabled = state.colors.length <= min;
          rm.addEventListener('click', () => {
            if (state.colors.length > min) {
              state.colors.splice(i, 1);
              renderColors();
              apply();
            }
          });
          item.appendChild(rm);
        }
        colorsList.appendChild(item);
      }
      if (!isSolid) {
        const add = document.createElement('button');
        add.type = 'button';
        add.classList.add('bg-modal-color-add');
        add.textContent = '+ Add color';
        add.addEventListener('click', () => {
          // New stop defaults to a copy of the last color so the gradient
          // doesn't jump to a random hue when extended.
          state.colors.push(state.colors[state.colors.length - 1] || '#cccccc');
          renderColors();
          apply();
        });
        colorsList.appendChild(add);
      }
    };

    // Angle
    const angleRow = mkField('Angle');
    const angleInput = document.createElement('input');
    angleInput.type = 'number';
    angleInput.min = '0';
    angleInput.max = '360';
    angleInput.step = '1';
    angleInput.value = state.angle;
    angleRow.appendChild(angleInput);

    // Faded toggle — smooth blends vs hard color stops
    state.faded = state.faded !== false;
    const fadedRow = mkField('Faded');
    const fadedCheck = document.createElement('input');
    fadedCheck.type = 'checkbox';
    fadedCheck.checked = state.faded;
    fadedCheck.title = 'Smooth blends between colors. Off = hard color bands.';
    fadedRow.appendChild(fadedCheck);
    fadedCheck.addEventListener('change', () => { state.faded = fadedCheck.checked; apply(); });

    // Rotate — cyclic shift of the color positions along the gradient
    state.colorRotate = state.colorRotate ?? 0;
    const rotateRow = mkField('Rotate');
    const rotateSlider = document.createElement('input');
    rotateSlider.type = 'range';
    rotateSlider.min = '0';
    rotateSlider.max = '1';
    rotateSlider.step = '0.01';
    rotateSlider.value = state.colorRotate;
    rotateSlider.classList.add('bg-modal-range');
    const rotateVal = document.createElement('span');
    rotateVal.classList.add('bg-modal-range-val');
    rotateVal.textContent = (state.colorRotate * 100).toFixed(0) + '%';
    rotateRow.append(rotateSlider, rotateVal);
    rotateSlider.addEventListener('input', () => {
      state.colorRotate = parseFloat(rotateSlider.value);
      rotateVal.textContent = (state.colorRotate * 100).toFixed(0) + '%';
      apply();
    });

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
    state.parallaxBg = state.parallaxBg !== false;
    state.parallaxElements = state.parallaxElements !== false;
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

    const mkParallaxToggle = (labelText, key) => {
      const row = mkField(labelText);
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state[key];
      row.appendChild(cb);
      cb.addEventListener('change', () => {
        state[key] = cb.checked;
        apply();
      });
      return row;
    };
    const parallaxBgRow = mkParallaxToggle('Parallax background', 'parallaxBg');
    const parallaxElRow = mkParallaxToggle('Parallax elements', 'parallaxElements');

    // Page length — fixed scroll length in viewport heights (vh-based so it
    // adapts across displays). Empty = auto (content-driven).
    const scrollLenRow = mkField('Page length');
    const scrollLenInput = document.createElement('input');
    scrollLenInput.type = 'number';
    scrollLenInput.min = '1';
    scrollLenInput.step = '0.5';
    scrollLenInput.placeholder = 'auto';
    scrollLenInput.value = state.scrollLength || '';
    scrollLenInput.title = 'Number of viewport-heights of scroll. Leave empty for auto (fits content).';
    const scrollLenSuffix = document.createElement('span');
    scrollLenSuffix.classList.add('bg-modal-range-val');
    scrollLenSuffix.textContent = 'screens';
    scrollLenRow.append(scrollLenInput, scrollLenSuffix);
    scrollLenInput.addEventListener('input', () => {
      const v = parseFloat(scrollLenInput.value);
      if (Number.isFinite(v) && v >= 1) state.scrollLength = v;
      else delete state.scrollLength;
      apply();
    });

    // ── Overlay effect: Stitch ──
    state.effect = state.effect || 'none';
    if (!state.stitch) state.stitch = { speed: 120, stitchLen: 10, palette: 'warm', style: 'running', curliness: 3 };

    const effectRow = mkField('Effect');
    const effectSel = document.createElement('select');
    [
      ['none', 'None'],
      ['stitch', 'Stitch'],
      ['stitch-wander', 'Stitch (wander)'],
      ['stitch-pathed', 'Stitch (pathed)'],
    ].forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      if (state.effect === val) opt.selected = true;
      effectSel.appendChild(opt);
    });
    effectRow.appendChild(effectSel);

    // Edit-points button — only visible when effect is stitch-pathed
    if (!state.stitchPath) state.stitchPath = { points: [], closed: true };
    const editPointsBtn = document.createElement('button');
    editPointsBtn.classList.add('bg-modal-btn');
    editPointsBtn.textContent = 'Edit points';
    effectRow.appendChild(editPointsBtn);

    // Stitch sub-controls container
    const stitchGroup = document.createElement('div');
    stitchGroup.classList.add('bg-modal-stitch-group');
    modal.appendChild(stitchGroup);

    // Stitch palette
    const stitchPaletteRow = mkField('Palette');
    stitchGroup.appendChild(stitchPaletteRow);
    const stitchPaletteSel = document.createElement('select');
    [['warm', 'Warm'], ['cool', 'Cool'], ['pastel', 'Pastel'], ['mono', 'Mono'], ['custom', 'Custom']].forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      if (state.stitch.palette === val) opt.selected = true;
      stitchPaletteSel.appendChild(opt);
    });
    stitchPaletteRow.appendChild(stitchPaletteSel);

    // Custom palette colors (only shown when palette === 'custom'). The
    // stitch effect already reads `state.stitch.customColors` via pickColor()
    // when palette is 'custom' — this UI just lets the user edit that list.
    const customPaletteRow = mkField('Custom colors');
    stitchGroup.appendChild(customPaletteRow);
    const customPaletteList = document.createElement('div');
    customPaletteList.classList.add('bg-modal-color-list');
    customPaletteRow.appendChild(customPaletteList);
    if (!Array.isArray(state.stitch.customColors) || state.stitch.customColors.length === 0) {
      // Seed from the current preset so switching to Custom isn't a blank slate
      const preset = STITCH_PALETTES[state.stitch.palette];
      state.stitch.customColors = (preset || STITCH_PALETTES.warm).slice();
    }
    const renderCustomPalette = () => {
      customPaletteList.innerHTML = '';
      state.stitch.customColors.forEach((c, i) => {
        const item = document.createElement('div');
        item.classList.add('bg-modal-color-item');
        const inp = document.createElement('input');
        inp.type = 'color';
        inp.value = c;
        inp.addEventListener('input', () => {
          state.stitch.customColors[i] = inp.value;
          apply();
        });
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.classList.add('bg-modal-color-rm');
        rm.textContent = '✕';
        rm.title = 'Remove color';
        rm.disabled = state.stitch.customColors.length <= 1;
        rm.addEventListener('click', () => {
          if (state.stitch.customColors.length > 1) {
            state.stitch.customColors.splice(i, 1);
            renderCustomPalette();
            apply();
          }
        });
        item.append(inp, rm);
        customPaletteList.appendChild(item);
      });
      const add = document.createElement('button');
      add.type = 'button';
      add.classList.add('bg-modal-color-add');
      add.textContent = '+ Add color';
      add.addEventListener('click', () => {
        const last = state.stitch.customColors[state.stitch.customColors.length - 1];
        state.stitch.customColors.push(last || '#cccccc');
        renderCustomPalette();
        apply();
      });
      customPaletteList.appendChild(add);
    };
    renderCustomPalette();

    // Stitch style
    const stitchStyleRow = mkField('Stitch style');
    stitchGroup.appendChild(stitchStyleRow);
    const stitchStyleSel = document.createElement('select');
    [['running', 'Running'], ['backstitch', 'Backstitch'], ['zigzag', 'Zigzag'], ['chain', 'Chain'], ['satin', 'Satin'], ['mixed', 'Mixed']].forEach(([val, lbl]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = lbl;
      if (state.stitch.style === val) opt.selected = true;
      stitchStyleSel.appendChild(opt);
    });
    stitchStyleRow.appendChild(stitchStyleSel);

    // Stitch speed
    const stitchSpeedRow = mkField('Speed');
    stitchGroup.appendChild(stitchSpeedRow);
    const stitchSpeedSlider = document.createElement('input');
    stitchSpeedSlider.type = 'range';
    stitchSpeedSlider.min = '20';
    stitchSpeedSlider.max = '400';
    stitchSpeedSlider.step = '10';
    stitchSpeedSlider.value = state.stitch.speed;
    stitchSpeedSlider.classList.add('bg-modal-range');
    const stitchSpeedVal = document.createElement('span');
    stitchSpeedVal.classList.add('bg-modal-range-val');
    stitchSpeedVal.textContent = state.stitch.speed;
    stitchSpeedRow.append(stitchSpeedSlider, stitchSpeedVal);

    // Stitch length
    const stitchLenRow = mkField('Stitch size');
    stitchGroup.appendChild(stitchLenRow);
    const stitchLenSlider = document.createElement('input');
    stitchLenSlider.type = 'range';
    stitchLenSlider.min = '3';
    stitchLenSlider.max = '30';
    stitchLenSlider.step = '1';
    stitchLenSlider.value = state.stitch.stitchLen;
    stitchLenSlider.classList.add('bg-modal-range');
    const stitchLenVal = document.createElement('span');
    stitchLenVal.classList.add('bg-modal-range-val');
    stitchLenVal.textContent = state.stitch.stitchLen;
    stitchLenRow.append(stitchLenSlider, stitchLenVal);

    // Curliness
    const curlinessRow = mkField('Curliness');
    stitchGroup.appendChild(curlinessRow);
    const curlinessSlider = document.createElement('input');
    curlinessSlider.type = 'range';
    curlinessSlider.min = '1';
    curlinessSlider.max = '20';
    curlinessSlider.step = '1';
    curlinessSlider.value = state.stitch.curliness;
    curlinessSlider.classList.add('bg-modal-range');
    const curlinessVal = document.createElement('span');
    curlinessVal.classList.add('bg-modal-range-val');
    curlinessVal.textContent = state.stitch.curliness;
    curlinessRow.append(curlinessSlider, curlinessVal);

    // Continuous (pathed only) — when checked, the trail never fades, so
    // successive passes layer onto the design like real embroidery.
    const continuousRow = mkField('Continuous');
    continuousRow.classList.add('bg-modal-continuous-row');
    stitchGroup.appendChild(continuousRow);
    const continuousCheck = document.createElement('input');
    continuousCheck.type = 'checkbox';
    continuousCheck.checked = !!state.stitchPath?.continuous;
    continuousRow.appendChild(continuousCheck);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const syncVisibility = () => {
      const t = state.type;
      // Re-render the colors list so add/remove + count match the current type
      // (solid → one swatch; gradient/animated → all swatches with controls).
      renderColors();
      colorsRow.querySelector('label').textContent = t === 'solid' ? 'Color' : 'Colors';
      angleRow.classList.toggle('is-hidden', t === 'solid');
      // Faded only matters when there's a gradient/animated bg
      fadedRow.classList.toggle('is-hidden', t === 'solid');
      // Rotate slider only when there's more than one color (and not solid)
      const hasMultiColors = Array.isArray(state.colors) && state.colors.length > 1;
      rotateRow.classList.toggle('is-hidden', t === 'solid' || !hasMultiColors);
      presetRow.classList.toggle('is-hidden', t !== 'animated');
      // Parallax only makes sense for non-solid types
      parallaxRow.classList.toggle('is-hidden', t === 'solid');
      parallaxBgRow.classList.toggle('is-hidden', t === 'solid');
      parallaxElRow.classList.toggle('is-hidden', t === 'solid');
      // Stitch sub-controls only visible when effect is 'stitch'
      stitchGroup.classList.toggle('is-hidden', !state.effect.startsWith('stitch'));
      // Custom palette editor only when palette === 'custom'
      customPaletteRow.classList.toggle('is-hidden', state.stitch.palette !== 'custom');
      // Edit-points button + continuous toggle only for pathed stitch
      editPointsBtn.classList.toggle('is-hidden', state.effect !== 'stitch-pathed');
      continuousRow.classList.toggle('is-hidden', state.effect !== 'stitch-pathed');
    };

    const apply = () => {
      this.board.background = { ...state, stitch: { ...state.stitch } };
      this.board.applyBackground();
      // Color count may have changed (add/remove) — re-sync rotate row visibility
      const hasMulti = Array.isArray(state.colors) && state.colors.length > 1;
      rotateRow.classList.toggle('is-hidden', state.type === 'solid' || !hasMulti);
    };

    syncVisibility();
    apply();

    typeSel.addEventListener('change', () => {
      state.type = typeSel.value;
      syncVisibility();
      apply();
    });
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
    effectSel.addEventListener('change', () => {
      state.effect = effectSel.value;
      syncVisibility();
      apply();
    });
    stitchPaletteSel.addEventListener('change', () => {
      const prev = state.stitch.palette;
      state.stitch.palette = stitchPaletteSel.value;
      // When entering Custom for the first time, seed from the previous preset
      // so the user has a starting point instead of an empty list.
      if (state.stitch.palette === 'custom'
          && (!Array.isArray(state.stitch.customColors) || state.stitch.customColors.length === 0)) {
        const seed = STITCH_PALETTES[prev] || STITCH_PALETTES.warm;
        state.stitch.customColors = seed.slice();
        renderCustomPalette();
      }
      syncVisibility();
      apply();
    });
    stitchStyleSel.addEventListener('change', () => { state.stitch.style = stitchStyleSel.value; apply(); });
    stitchSpeedSlider.addEventListener('input', () => {
      state.stitch.speed = parseInt(stitchSpeedSlider.value, 10);
      stitchSpeedVal.textContent = state.stitch.speed;
      apply();
    });
    stitchLenSlider.addEventListener('input', () => {
      state.stitch.stitchLen = parseInt(stitchLenSlider.value, 10);
      stitchLenVal.textContent = state.stitch.stitchLen;
      apply();
    });
    curlinessSlider.addEventListener('input', () => {
      state.stitch.curliness = parseInt(curlinessSlider.value, 10);
      curlinessVal.textContent = state.stitch.curliness;
      apply();
    });
    continuousCheck.addEventListener('change', () => {
      if (!state.stitchPath) state.stitchPath = { points: [], closed: true };
      state.stitchPath.continuous = continuousCheck.checked;
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

    editPointsBtn.addEventListener('click', () => {
      this._enterStitchPathEdit(state, apply, backdrop);
    });
  }

  /**
   * Stitch-path point editor. Hides the bg modal, dims site panels, lets user
   * click/drag to place points, right-click to remove. Esc/Enter exits and
   * restores the modal. State is mutated in place; the modal's existing close
   * flow handles persistence.
   */
  _enterStitchPathEdit(state, applyFn, modalBackdrop) {
    if (this._stitchPathEdit) return;
    if (!state.stitchPath) state.stitchPath = { points: [], closed: true };

    // Hide modal but keep its DOM/state intact
    modalBackdrop.style.display = 'none';
    document.body.classList.add('is-bg-path-edit');

    const overlay = document.createElement('div');
    overlay.classList.add('bg-path-edit-overlay');

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('bg-path-edit-svg');
    overlay.appendChild(svg);

    const hint = document.createElement('div');
    hint.classList.add('bg-path-edit-hint');
    hint.innerHTML = 'Click empty space to add &nbsp;·&nbsp; Click a point to toggle <b>sharp</b> corner &nbsp;·&nbsp; Drag to move &nbsp;·&nbsp; Right-click to delete &nbsp;·&nbsp; <b>Enter</b> or <b>Esc</b> to finish';
    overlay.appendChild(hint);

    document.body.appendChild(overlay);

    const norm = (clientX, clientY) => ({
      x: Math.max(0, Math.min(1, clientX / window.innerWidth)),
      y: Math.max(0, Math.min(1, clientY / window.innerHeight)),
    });
    const denorm = (p) => ({
      x: p.x * window.innerWidth,
      y: p.y * window.innerHeight,
    });

    const render = () => {
      // Wipe SVG
      while (svg.firstChild) svg.firstChild.remove();
      const points = state.stitchPath.points;

      // Connecting polyline (faint preview of path order)
      if (points.length >= 2) {
        const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
        const pts = points.map(p => {
          const px = denorm(p);
          return `${px.x},${px.y}`;
        });
        if (state.stitchPath.closed && points.length >= 3) {
          const px = denorm(points[0]);
          pts.push(`${px.x},${px.y}`);
        }
        poly.setAttribute('points', pts.join(' '));
        poly.setAttribute('fill', 'none');
        poly.setAttribute('stroke', 'rgba(120, 200, 255, 0.5)');
        poly.setAttribute('stroke-width', '1.5');
        poly.setAttribute('stroke-dasharray', '4 4');
        svg.appendChild(poly);
      }

      // Numbered dots — circles for smooth points, squares for sharp-corner
      // points (where the needle pivots hard instead of curving).
      points.forEach((p, i) => {
        const px = denorm(p);
        const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        g.classList.add('bg-path-dot');
        if (p.sharp) g.classList.add('is-sharp');
        g.setAttribute('data-index', i);
        g.setAttribute('transform', `translate(${px.x}, ${px.y})`);

        const shape = p.sharp
          ? document.createElementNS('http://www.w3.org/2000/svg', 'rect')
          : document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        if (p.sharp) {
          shape.setAttribute('x', '-12');
          shape.setAttribute('y', '-12');
          shape.setAttribute('width', '24');
          shape.setAttribute('height', '24');
        } else {
          shape.setAttribute('r', '12');
        }
        shape.setAttribute('fill', 'rgba(20, 30, 50, 0.85)');
        shape.setAttribute('stroke', p.sharp ? '#ffb86b' : '#7ac4ff');
        shape.setAttribute('stroke-width', '2');
        g.appendChild(shape);

        const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        label.setAttribute('text-anchor', 'middle');
        label.setAttribute('dominant-baseline', 'central');
        label.setAttribute('fill', '#fff');
        label.setAttribute('font-size', '11');
        label.setAttribute('font-family', 'Inter, sans-serif');
        label.textContent = String(i + 1);
        g.appendChild(label);

        svg.appendChild(g);
      });
    };

    let dragIdx = -1;
    let didDrag = false;

    const onPointerDown = (e) => {
      // Right-click handled by contextmenu listener
      if (e.button !== 0) return;
      const dot = e.target.closest('.bg-path-dot');
      if (dot) {
        dragIdx = parseInt(dot.getAttribute('data-index'), 10);
        didDrag = false;
        overlay.setPointerCapture(e.pointerId);
        e.preventDefault();
        return;
      }
      // Click on empty space → append point
      const p = norm(e.clientX, e.clientY);
      state.stitchPath.points.push(p);
      render();
      applyFn();
    };

    const onPointerMove = (e) => {
      if (dragIdx < 0) return;
      didDrag = true;
      const p = norm(e.clientX, e.clientY);
      state.stitchPath.points[dragIdx] = p;
      render();
      // Don't re-apply during drag — setPoints resets the trail. Apply on release.
    };

    const onPointerUp = (e) => {
      if (dragIdx >= 0) {
        try { overlay.releasePointerCapture(e.pointerId); } catch {}
        const idx = dragIdx;
        const dragged = didDrag;
        dragIdx = -1;
        if (dragged) {
          applyFn();
        } else {
          // No drag — treat as a click on the dot, toggle its sharp flag.
          // Sharp = needle pivots hard at this point; smooth = curves through.
          const p = state.stitchPath.points[idx];
          if (p) p.sharp = !p.sharp;
          render();
          applyFn();
        }
      }
    };

    const onContextMenu = (e) => {
      const dot = e.target.closest('.bg-path-dot');
      if (!dot) return;
      e.preventDefault();
      const idx = parseInt(dot.getAttribute('data-index'), 10);
      state.stitchPath.points.splice(idx, 1);
      render();
      applyFn();
    };

    const onKey = (e) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        e.preventDefault();
        exit();
      }
    };

    const exit = () => {
      overlay.removeEventListener('pointerdown', onPointerDown);
      overlay.removeEventListener('pointermove', onPointerMove);
      overlay.removeEventListener('pointerup', onPointerUp);
      overlay.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('keydown', onKey, true);
      overlay.remove();
      document.body.classList.remove('is-bg-path-edit');
      modalBackdrop.style.display = '';
      this._stitchPathEdit = null;
    };

    overlay.addEventListener('pointerdown', onPointerDown);
    overlay.addEventListener('pointermove', onPointerMove);
    overlay.addEventListener('pointerup', onPointerUp);
    overlay.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('keydown', onKey, true);

    this._stitchPathEdit = { exit };
    render();
    applyFn();
  }

  // ── Pages dropdown (multi-page management) ──

  _buildPagesMenu() {
    const wrap = document.createElement('div');
    wrap.classList.add('edit-dropdown');

    const btn = document.createElement('button');
    const current = pagesIndex.pages.find(p => p.slug === this.pageSlug);
    const label = current ? current.name : this.pageSlug;
    btn.innerHTML = `Page: <strong style="margin:0 .25rem;color:var(--ed-text)">${label}</strong><span class="edit-btn-caret">▾</span>`;
    btn.classList.add('edit-btn');
    wrap.appendChild(btn);

    const menu = document.createElement('div');
    menu.classList.add('edit-dropdown-menu');
    menu.style.minWidth = '220px';

    for (const p of pagesIndex.pages) {
      const row = document.createElement('div');
      row.classList.add('edit-dropdown-item');
      row.style.justifyContent = 'space-between';

      const left = document.createElement('span');
      left.textContent = p.name;
      if (p.slug === this.pageSlug) {
        left.style.color = 'var(--ed-text)';
        left.style.fontWeight = '600';
        left.textContent = '• ' + p.name;
      }
      left.style.flex = '1';
      left.style.cursor = 'pointer';
      left.addEventListener('click', () => {
        if (p.slug !== this.pageSlug) this._gotoPage(p.slug);
      });
      row.appendChild(left);

      if (p.slug !== 'home') {
        const del = document.createElement('span');
        del.textContent = '✕';
        del.title = `Delete ${p.name}`;
        del.style.cssText = 'opacity:.55;padding:0 .35rem;cursor:pointer;font-size:.7rem;';
        del.addEventListener('mouseenter', () => { del.style.opacity = '1'; del.style.color = 'var(--ed-danger, #ff6464)'; });
        del.addEventListener('mouseleave', () => { del.style.opacity = '.55'; del.style.color = ''; });
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          this._deletePage(p.slug, p.name);
        });
        row.appendChild(del);
      }
      menu.appendChild(row);
    }

    const sep = document.createElement('div');
    sep.style.cssText = 'height:1px;background:var(--ed-line-2);margin:4px 0;';
    menu.appendChild(sep);

    const addRow = document.createElement('div');
    addRow.classList.add('edit-dropdown-item');
    addRow.textContent = '+ New page…';
    addRow.style.color = 'var(--ed-accent, #6cf)';
    addRow.addEventListener('click', () => this._createPagePrompt());
    menu.appendChild(addRow);

    wrap.appendChild(menu);
    return wrap;
  }

  async _gotoPage(slug) {
    if (this.active) {
      try { await this._saveLayout({ silent: true }); } catch {}
    }
    const url = new URL(window.location.href);
    url.pathname = slug === 'home' ? '/' : `/${slug}`;
    window.location.href = url.toString();
  }

  async _createPagePrompt() {
    const raw = window.prompt(
      'New page slug (lowercase, hyphens, e.g. "store" or "art-portfolio"):',
    );
    if (raw == null) return;
    const slug = raw.trim().toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(slug) || slug === 'home') {
      this._flash('Invalid slug', true);
      return;
    }
    if (pagesIndex.pages.some(p => p.slug === slug)) {
      this._flash('Page already exists', true);
      return;
    }
    const name = window.prompt('Display name (optional):', slug) || slug;
    try {
      const res = await fetch('/api/create-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug, name: name.trim() }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.ok) {
        this._flash(result.error || 'Could not create page', true);
        return;
      }
      // Navigate to the new page (with ?edit so they land in the editor).
      const url = new URL(window.location.href);
      url.pathname = `/${slug}`;
      url.searchParams.set('edit', '');
      window.location.href = url.toString();
    } catch {
      this._flash('Save failed — are you on the dev server?', true);
    }
  }

  async _deletePage(slug, name) {
    if (!window.confirm(`Delete page "${name}"? This removes its layout file.`)) return;
    try {
      const res = await fetch('/api/delete-page', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      });
      const result = await res.json().catch(() => ({}));
      if (!res.ok || !result.ok) {
        this._flash(result.error || 'Could not delete page', true);
        return;
      }
      // If we just deleted the page we're currently on, bounce to home.
      if (slug === this.pageSlug) {
        const url = new URL(window.location.href);
        url.pathname = '/';
        window.location.href = url.toString();
      }
      // Otherwise rely on the Vite reload triggered by writing pages.json.
    } catch {
      this._flash('Save failed — are you on the dev server?', true);
    }
  }

  // ── Save layout to disk (dev server only) ──

  async _saveLayout(opts = {}) {
    const data = this.board.getLayoutData();
    const json = JSON.stringify(data, null, 2);
    const url = `/api/save-layout?slug=${encodeURIComponent(this.pageSlug)}`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: json,
      });
      if (res.ok) {
        if (!opts.silent) this._flash('Layout saved');
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
