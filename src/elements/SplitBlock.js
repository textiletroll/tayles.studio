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
 * Apply the split boundary to the two side elements.
 * ratio: 0–1, horizontal position of the split center
 * angle: degrees of tilt (positive = top leans right, bottom leans left)
 * blend: 0–1, softness of the boundary (0 = hard clip, 1 = full gradient)
 */
export function applySplitBoundary(leftEl, rightEl, ratio, angle, blend) {
  const angleRad = (angle * Math.PI) / 180;
  const offset = Math.tan(angleRad) * 50;
  const topPct = Math.max(0, Math.min(100, ratio * 100 + offset));
  const bottomPct = Math.max(0, Math.min(100, ratio * 100 - offset));

  if (!blend || blend <= 0) {
    // Hard edge via clip-path
    leftEl.style.clipPath = `polygon(0% 0%, ${topPct}% 0%, ${bottomPct}% 100%, 0% 100%)`;
    rightEl.style.clipPath = `polygon(${topPct}% 0%, 100% 0%, 100% 100%, ${bottomPct}% 100%)`;
    leftEl.style.maskImage = '';
    leftEl.style.webkitMaskImage = '';
    rightEl.style.maskImage = '';
    rightEl.style.webkitMaskImage = '';
    return;
  }

  // Soft edge via mask-image linear-gradient
  const spread = blend * 50; // 0 → 50% each side of center at blend=1
  const center = ratio * 100;
  const start = Math.max(0, center - spread);
  const end = Math.min(100, center + spread);
  const gradAngle = 90 + angle;

  leftEl.style.clipPath = 'none';
  rightEl.style.clipPath = 'none';

  const leftMask = `linear-gradient(${gradAngle}deg, black ${start}%, transparent ${end}%)`;
  const rightMask = `linear-gradient(${gradAngle}deg, transparent ${start}%, black ${end}%)`;
  leftEl.style.maskImage = leftMask;
  leftEl.style.webkitMaskImage = leftMask;
  rightEl.style.maskImage = rightMask;
  rightEl.style.webkitMaskImage = rightMask;
}

export function createSplitBlock(content) {
  const container = document.createElement('div');
  container.classList.add('block-split');

  const ratio = content.ratio ?? 0.5;
  const angle = content.angle ?? 0;
  const blend = content.blend ?? 0;

  const left = document.createElement('div');
  left.classList.add('split-side', 'split-left');
  left.appendChild(buildSide(content.left));

  const right = document.createElement('div');
  right.classList.add('split-side', 'split-right');
  right.appendChild(buildSide(content.right));

  applySplitBoundary(left, right, ratio, angle, blend);

  container.append(left, right);
  return container;
}
