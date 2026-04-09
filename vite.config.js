import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

function saveLayoutPlugin() {
  return {
    name: 'save-layout',
    configureServer(server) {
      server.middlewares.use('/api/save-layout', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const filePath = path.resolve('src/data/layout.json');
          fs.writeFileSync(filePath, body, 'utf-8');
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ ok: true }));
        });
      });
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
  plugins: [saveLayoutPlugin()],
});
