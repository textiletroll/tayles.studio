import { defineConfig } from 'vite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PAGES_PATH = path.resolve('src/data/pages.json');
const LAYOUTS_DIR = path.resolve('src/data/layouts');
const UPLOADS_DIR = path.resolve('public/uploads');

const UPLOAD_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

function readPages() {
  try {
    return JSON.parse(fs.readFileSync(PAGES_PATH, 'utf-8'));
  } catch {
    return { pages: [{ slug: 'home', name: 'Home' }] };
  }
}

function writePages(data) {
  fs.writeFileSync(PAGES_PATH, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

/* Slug grammar: lowercase alphanumerics and hyphens, no leading/trailing
   hyphen, max 32 chars. 'home' is reserved (it's the implicit `/` route). */
function isValidSlug(s) {
  return typeof s === 'string'
    && s !== 'home'
    && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(s);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function blankLayout() {
  return {
    grid: { columns: 96, rowHeight: 38, gap: 0 },
    elements: [],
    background: {
      type: 'solid',
      colors: ['#1a1a1a'],
      parallax: 0,
      effect: 'none',
    },
  };
}

function pagesPlugin() {
  return {
    name: 'tayles-pages',

    configureServer(server) {
      // POST /api/save-layout?slug=<slug>  (defaults to home for back-compat)
      server.middlewares.use('/api/save-layout', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405; res.end('Method not allowed'); return;
        }
        const url = new URL(req.url, 'http://x');
        const slug = (url.searchParams.get('slug') || 'home').toLowerCase();
        if (slug !== 'home' && !isValidSlug(slug)) {
          res.statusCode = 400; res.end('Bad slug'); return;
        }
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
          fs.mkdirSync(LAYOUTS_DIR, { recursive: true });
          fs.writeFileSync(
            path.join(LAYOUTS_DIR, `${slug}.json`),
            body,
            'utf-8',
          );
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        });
      });

      /* POST /api/upload-image  body={dataUrl, mime?}
         Writes the decoded bytes to public/uploads/<sha256>.<ext> and returns
         the public path. Filename is content-hashed so re-uploading the same
         image is a no-op (and references in layouts dedupe automatically). */
      server.middlewares.use('/api/upload-image', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405; res.end(); return;
        }
        try {
          const { dataUrl, mime: explicitMime } = await readJsonBody(req);
          res.setHeader('Content-Type', 'application/json');
          if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: 'Expected data URL' }));
            return;
          }
          const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
          if (!m) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: 'Bad data URL' }));
            return;
          }
          const mime = explicitMime || m[1];
          const ext = UPLOAD_EXT[mime];
          if (!ext) {
            res.statusCode = 415;
            res.end(JSON.stringify({ ok: false, error: 'Unsupported type' }));
            return;
          }
          const buf = Buffer.from(m[2], 'base64');
          if (buf.length > 10 * 1024 * 1024) {
            res.statusCode = 413;
            res.end(JSON.stringify({ ok: false, error: 'Too large (10MB max)' }));
            return;
          }
          const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
          fs.mkdirSync(UPLOADS_DIR, { recursive: true });
          const filename = `${hash}.${ext}`;
          const dest = path.join(UPLOADS_DIR, filename);
          if (!fs.existsSync(dest)) fs.writeFileSync(dest, buf);
          res.end(JSON.stringify({ ok: true, path: `/uploads/${filename}` }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });

      // POST /api/create-page  body={slug, name}
      server.middlewares.use('/api/create-page', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405; res.end(); return;
        }
        try {
          const { slug, name } = await readJsonBody(req);
          res.setHeader('Content-Type', 'application/json');
          if (!isValidSlug(slug)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: 'Invalid slug' }));
            return;
          }
          const data = readPages();
          if (data.pages.some(p => p.slug === slug)) {
            res.statusCode = 409;
            res.end(JSON.stringify({ ok: false, error: 'Slug already exists' }));
            return;
          }
          data.pages.push({ slug, name: (name && name.trim()) || slug });
          writePages(data);

          fs.mkdirSync(LAYOUTS_DIR, { recursive: true });
          const layoutFile = path.join(LAYOUTS_DIR, `${slug}.json`);
          if (!fs.existsSync(layoutFile)) {
            fs.writeFileSync(
              layoutFile,
              JSON.stringify(blankLayout(), null, 2) + '\n',
              'utf-8',
            );
          }
          res.end(JSON.stringify({ ok: true, slug }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });

      // POST /api/delete-page  body={slug}  (home is protected)
      server.middlewares.use('/api/delete-page', async (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405; res.end(); return;
        }
        try {
          const { slug } = await readJsonBody(req);
          res.setHeader('Content-Type', 'application/json');
          if (slug === 'home' || !isValidSlug(slug)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: 'Cannot delete this page' }));
            return;
          }
          const data = readPages();
          if (!data.pages.some(p => p.slug === slug)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ ok: false, error: 'Not found' }));
            return;
          }
          data.pages = data.pages.filter(p => p.slug !== slug);
          writePages(data);
          const layoutFile = path.join(LAYOUTS_DIR, `${slug}.json`);
          if (fs.existsSync(layoutFile)) fs.unlinkSync(layoutFile);
          res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: String(e) }));
        }
      });

      /* Pretty-URL fallback for dev. When a request comes in for a known
         slug (`/store`, `/store/anything`), rewrite to /index.html so Vite
         serves the SPA shell. main.js reads window.location to pick the
         layout — the rewrite only changes which file the server returns,
         not what the browser displays in the URL bar. */
      return () => server.middlewares.use((req, res, next) => {
        const url = req.url || '/';
        if (url === '/'
          || url.startsWith('/api/')
          || url.startsWith('/@')
          || url.startsWith('/src/')
          || url.startsWith('/node_modules/')
          || url.startsWith('/__')
          || url.includes('.')) {
          return next();
        }
        const slug = url.replace(/^\/+/, '').split(/[/?#]/)[0];
        const data = readPages();
        if (data.pages.some(p => p.slug === slug)) {
          req.url = '/index.html';
        }
        next();
      });
    },

    /* Build step: emit /<slug>/index.html for each non-home page so the
       static host serves the SPA shell at every route. The HTML is
       byte-identical across pages — main.js handles the per-page divergence
       at runtime via window.location. */
    closeBundle() {
      const distDir = path.resolve('dist');
      const indexPath = path.join(distDir, 'index.html');
      if (!fs.existsSync(indexPath)) return;
      const html = fs.readFileSync(indexPath, 'utf-8');
      const data = readPages();
      for (const p of data.pages) {
        if (p.slug === 'home') continue;
        const dir = path.join(distDir, p.slug);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'index.html'), html, 'utf-8');
      }
    },
  };
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
  },
  server: {
    port: 3000,
    open: true,
  },
  plugins: [pagesPlugin()],
});
