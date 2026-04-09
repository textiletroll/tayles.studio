export function createImageBlock(content) {
  const el = document.createElement('div');
  el.classList.add('block-image');

  const img = document.createElement('img');
  img.src = content.src;
  img.alt = content.alt || '';
  img.loading = 'lazy';
  el.appendChild(img);

  if (content.caption) {
    const caption = document.createElement('span');
    caption.classList.add('caption');
    caption.textContent = content.caption;
    el.appendChild(caption);
  }

  return el;
}
