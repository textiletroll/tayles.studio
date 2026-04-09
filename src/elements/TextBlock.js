export function createTextBlock(content) {
  const el = document.createElement('div');
  el.classList.add('block-text');

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
