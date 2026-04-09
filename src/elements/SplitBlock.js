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

/**
 * Computes clip-path polygons for the two sides of a split block.
 * ratio: 0–1, where the split center sits horizontally
 * angle: degrees of tilt (positive = top leans right, bottom leans left)
 */
function computeClipPaths(ratio, angle) {
  const angleRad = (angle * Math.PI) / 180;
  // Offset from center at top/bottom edges (as percentage of width).
  // Scaled by 50 so moderate angles (5–15°) produce visible but not extreme tilts.
  const offset = Math.tan(angleRad) * 50;

  const topPct = Math.max(0, Math.min(100, ratio * 100 + offset));
  const bottomPct = Math.max(0, Math.min(100, ratio * 100 - offset));

  const left = `polygon(0% 0%, ${topPct}% 0%, ${bottomPct}% 100%, 0% 100%)`;
  const right = `polygon(${topPct}% 0%, 100% 0%, 100% 100%, ${bottomPct}% 100%)`;

  return { left, right };
}

export function createSplitBlock(content) {
  const container = document.createElement('div');
  container.classList.add('block-split');

  const ratio = content.ratio ?? 0.5;
  const angle = content.angle ?? 0;

  const left = document.createElement('div');
  left.classList.add('split-side', 'split-left');
  left.appendChild(buildSide(content.left));

  const right = document.createElement('div');
  right.classList.add('split-side', 'split-right');
  right.appendChild(buildSide(content.right));

  // Apply the angled clip paths
  const clips = computeClipPaths(ratio, angle);
  left.style.clipPath = clips.left;
  right.style.clipPath = clips.right;

  container.append(left, right);
  return container;
}
