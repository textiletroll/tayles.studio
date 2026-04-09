export function createTextBlock(content) {
  const el = document.createElement('div');
  el.classList.add('block-text');

  if (content.tag === 'h1' || content.tag === 'h2' || content.tag === 'h3') {
    const heading = document.createElement(content.tag);
    heading.textContent = content.text;
    el.appendChild(heading);
  } else {
    const p = document.createElement('p');
    p.textContent = content.text;
    el.appendChild(p);
  }

  if (content.subtext) {
    const sub = document.createElement('p');
    sub.classList.add('subtext');
    sub.textContent = content.subtext;
    el.appendChild(sub);
  }

  return el;
}
