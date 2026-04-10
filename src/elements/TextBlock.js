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

  if (content.tag === 'h1' || content.tag === 'h2' || content.tag === 'h3') {
    const heading = document.createElement(content.tag);
    heading.innerHTML = content.text;
    el.appendChild(heading);
  } else {
    const p = document.createElement('p');
    p.innerHTML = content.text;
    el.appendChild(p);
  }

  if (content.subtext) {
    const sub = document.createElement('p');
    sub.classList.add('subtext');
    sub.innerHTML = content.subtext;
    el.appendChild(sub);
  }

  return el;
}
