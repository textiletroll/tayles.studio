import './styles/main.css';
import { PegBoard } from './grid/PegBoard.js';
import { EditMode } from './edit/EditMode.js';
import homeLayout from './data/layouts/home.json';
import pagesIndex from './data/pages.json';

/* Home stays a static import so `/` ships zero extra fetches.
   Other pages are lazy chunks via import.meta.glob — only paid for by
   visitors of those pages. Vite dedupes `home.json` between the static
   import and the glob entry, so home is bundled exactly once. */
const lazyLayouts = import.meta.glob('./data/layouts/*.json');

function currentPageSlug() {
  const path = (window.location.pathname || '/').replace(/^\/+|\/+$/g, '');
  if (!path) return 'home';
  const slug = path.split('/')[0];
  return pagesIndex.pages.some(p => p.slug === slug) ? slug : 'home';
}

async function loadLayout(slug) {
  if (slug === 'home') return homeLayout;
  const loader = lazyLayouts[`./data/layouts/${slug}.json`];
  if (!loader) return homeLayout;
  const mod = await loader();
  return mod.default;
}

const slug = currentPageSlug();
const container = document.getElementById('pegboard');
const board = new PegBoard(container);

loadLayout(slug).then((layout) => {
  board.loadLayout(layout);
  new EditMode(board, { slug });
});
