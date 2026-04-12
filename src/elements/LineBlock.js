/**
 * LineBlock — a multi-anchor polyline rendered as SVG.
 *
 * Anchors are stored as absolute grid-cell coordinates. The line's
 * wrapper spans the entire grid (gridColumn 1, colSpan = board.columns)
 * so anchor coords map directly to wrapper-local percentages.
 *
 * PegBoard._applyLine rebuilds the <path> on every applyDesign.
 */
export function createLineBlock() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.classList.add('line-svg');
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', '100%');
  svg.setAttribute('preserveAspectRatio', 'none');
  return svg;
}
