import { createTextBlock } from './TextBlock.js';
import { createImageBlock } from './ImageBlock.js';

function buildSide(config) {
  if (config.type === 'text') {
    return createTextBlock(config);
  }
  if (config.type === 'image') {
    return createImageBlock(config);
  }
  const fallback = document.createElement('div');
  fallback.textContent = config.text || '';
  return fallback;
}

export function createSplitBlock(content) {
  const container = document.createElement('div');
  container.classList.add('block-split');
  container.style.setProperty('--split-ratio', content.ratio || 0.5);

  const left = document.createElement('div');
  left.classList.add('split-side', 'split-left');
  left.appendChild(buildSide(content.left));

  const divider = document.createElement('div');
  divider.classList.add('split-divider');
  const handle = document.createElement('div');
  handle.classList.add('split-handle');
  divider.appendChild(handle);

  const right = document.createElement('div');
  right.classList.add('split-side', 'split-right');
  right.appendChild(buildSide(content.right));

  // Draggable divider
  let dragging = false;

  divider.addEventListener('pointerdown', (e) => {
    dragging = true;
    divider.setPointerCapture(e.pointerId);
    container.classList.add('is-resizing');
  });

  divider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const clamped = Math.max(0.15, Math.min(0.85, ratio));
    container.style.setProperty('--split-ratio', clamped);
  });

  divider.addEventListener('pointerup', () => {
    dragging = false;
    container.classList.remove('is-resizing');
  });

  container.append(left, divider, right);
  return container;
}
