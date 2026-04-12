export function createTextBlock(content) {
  const el = document.createElement('div');
  el.classList.add('block-text');

  // Alignment
  if (content.align) el.style.textAlign = content.align;
  if (content.vAlign) el.style.justifyContent = content.vAlign;

  // Frame — position/size/rotate the text within its panel
  const f = content.frame;
  if (f && (f.x || f.y || f.width !== 100 || f.height !== 100 || f.rotation)) {
    el.style.position = 'absolute';
    el.style.left = `${f.x}%`;
    el.style.top = `${f.y}%`;
    el.style.width = `${f.width}%`;
    el.style.height = `${f.height}%`;
    if (f.rotation) el.style.transform = `rotate(${f.rotation}deg)`;
  }

  // Main text — fontSize in cqi units, migrated from legacy tag sizes
  const main = document.createElement('p');
  main.classList.add('text-main');
  const fontSize = content.fontSize ?? { h1: 13, h2: 9, h3: 6.5 }[content.tag] ?? 4;
  main.style.fontSize = `clamp(0.5rem, ${fontSize}cqi, 6rem)`;
  main.innerHTML = content.text;
  el.appendChild(main);

  if (content.subtext) {
    const sub = document.createElement('p');
    sub.classList.add('subtext');
    if (content.subtextColor) sub.style.color = content.subtextColor;
    sub.innerHTML = content.subtext;
    el.appendChild(sub);
  }

  return el;
}
