/* Iframe — embeds an external page (e.g. a self-contained game under
   /public/games/...). Peer to picture/line: no shape clip, no border overlay,
   no panel-content blocks. The iframe is the panel.

   Click-to-activate: in live mode the iframe receives pointer events normally
   so a click into it grants focus and keys flow through. In edit mode CSS
   forces pointer-events: none on the iframe so the wrapper still owns
   selection/drag — handled in main.css under `.edit-mode .block-iframe > iframe`. */
export function createIframe(content, config) {
  const el = document.createElement('div');
  el.classList.add('block-iframe');

  const frame = document.createElement('iframe');
  frame.src = (content && content.src) || '';
  frame.title = (content && content.title) || 'Embedded content';
  frame.loading = 'lazy';
  if (content && content.allow) frame.setAttribute('allow', content.allow);
  // Sandbox is opt-in: many embeds (incl. our games) need scripts + same-origin
  // for localStorage. Only attach the attribute when explicitly configured so
  // the default is "no sandbox".
  if (content && typeof content.sandbox === 'string') {
    frame.setAttribute('sandbox', content.sandbox);
  }
  el.appendChild(frame);

  return el;
}
