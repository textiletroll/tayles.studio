/* Picture — free-floating image element. Distinct from the legacy `image`
   panel type: no border, no shape clipping, no bg color. The PNG's alpha
   channel IS the silhouette. Supports rotation, opacity, and object-fit. */
export function createPicture(content, config) {
  const el = document.createElement('div');
  el.classList.add('block-picture');

  const img = document.createElement('img');
  img.src = (content && content.src) || '/placeholder.svg';
  img.alt = (content && content.alt) || '';
  img.draggable = false;
  img.loading = 'lazy';
  el.appendChild(img);

  return el;
}
