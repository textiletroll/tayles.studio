/**
 * Viewport — a panel that hosts zero or more content blocks (text/image),
 * each with its own frame (x/y/width/height/rotation as panel %).
 *
 * Content nodes live inside .block-viewport, are absolutely positioned per
 * frame, and clip to the panel shape via the wrapper's .shape-clip layer
 * (same mechanism text/image panels use).
 *
 * Each content node is its own size-query container (container-type: inline-size)
 * so font-size cqi units scale with the content block, not the whole panel.
 */

const GOOGLE_FONT_LOADED = new Set();

/** Inject a Google Fonts <link> on demand, once per family. Common system
 *  fonts (Inter, sans-serif, serif, monospace, system-ui) are skipped. */
export function ensureFontLoaded(family) {
  if (!family) return;
  const f = String(family).trim();
  if (!f) return;
  const lc = f.toLowerCase();
  if (lc === 'inter' || lc === 'system-ui' || lc === 'sans-serif'
      || lc === 'serif' || lc === 'monospace' || lc === 'cursive') return;
  if (GOOGLE_FONT_LOADED.has(lc)) return;
  GOOGLE_FONT_LOADED.add(lc);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;700&display=swap`;
  document.head.appendChild(link);
}

// PegBoard calls factories as `factory(config.content, config)` — viewport
// stores its blocks on `config.contents` (a sibling of `content`, not nested),
// so we read from the second arg. The first arg is ignored.
export function createViewport(_content, config) {
  const el = document.createElement('div');
  el.classList.add('block-viewport');
  const contents = (config && Array.isArray(config.contents)) ? config.contents : [];
  contents.forEach((c, i) => {
    const node = createContentNode(c, i);
    el.appendChild(node);
  });
  return el;
}

/** Build a single content child (text or image) with frame applied. */
export function createContentNode(c, idx) {
  const node = document.createElement('div');
  node.classList.add('viewport-content', `vc-${c.kind}`);
  node.dataset.contentIdx = String(idx);
  applyContentFrame(node, c.frame);
  if (c.kind === 'text') applyTextContent(node, c);
  else if (c.kind === 'image') applyImageContent(node, c);
  return node;
}

/** Update only the inline frame styles on a content node — used by edit mode
 *  for live drag/resize/rotate without rebuilding the panel. */
export function applyContentFrame(node, frame) {
  const f = frame || { x: 0, y: 0, width: 100, height: 100, rotation: 0 };
  node.style.left = `${f.x}%`;
  node.style.top = `${f.y}%`;
  node.style.width = `${f.width}%`;
  node.style.height = `${f.height}%`;
  node.style.transform = f.rotation ? `rotate(${f.rotation}deg)` : '';
}

function applyTextContent(node, c) {
  if (c.color) node.style.color = c.color;
  if (c.fontFamily) {
    ensureFontLoaded(c.fontFamily);
    node.style.fontFamily = `'${c.fontFamily}', sans-serif`;
  }
  node.style.textAlign = c.hAlign || 'left';
  node.style.justifyContent = c.vAlign || 'flex-start';

  const inner = document.createElement('div');
  inner.classList.add('vc-text-inner');
  const fontSize = c.fontSize ?? 8;
  inner.style.fontSize = `clamp(0.5rem, ${fontSize}cqi, 6rem)`;
  if (c.bold) inner.style.fontWeight = '700';
  if (c.italic) inner.style.fontStyle = 'italic';
  inner.innerHTML = c.html || '';
  node.appendChild(inner);
}

function applyImageContent(node, c) {
  const img = document.createElement('img');
  img.src = c.src || '/placeholder.svg';
  img.alt = c.alt || '';
  img.loading = 'lazy';
  img.draggable = false;
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.objectFit = c.fit || 'cover';
  img.style.opacity = c.opacity ?? 1;
  node.appendChild(img);
  if (c.caption) {
    const cap = document.createElement('span');
    cap.classList.add('caption');
    cap.textContent = c.caption;
    node.appendChild(cap);
  }
}
