import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { handleAPI } from './src/api.js';
import { createLocalStorage } from './src/local-storage.mjs';
import { loadLocalProviderKey } from './src/local-provider-key.mjs';

const root = path.resolve(fileURLToPath(new URL('./dist/', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const storage = await createLocalStorage();
const providerEncryptionKey = await loadLocalProviderKey();
let port = Number(process.env.PORT || 4173);
const server = http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.startsWith('/api/')) {
      const method = req.method || 'GET';
      const request = new Request('http://' + (req.headers.host || '127.0.0.1') + req.url, {
        method,
        headers: req.headers,
        ...(!['GET', 'HEAD'].includes(method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}),
      });
      const response = await handleAPI(request, { DB: storage.DB, BUCKET: storage.BUCKET, DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY, DEEPSEEK_MODEL: process.env.DEEPSEEK_MODEL, AI_CONFIG_ENCRYPTION_KEY: providerEncryptionKey }, { localOwnerId: 'local-preview-user' });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
    if (!['/', '/index.html', '/styles.css', '/app.js', '/overview.js', '/provider.js', '/engine.js', '/sources.js', '/favicon.svg'].includes(pathname)) { res.writeHead(404); res.end(); return; }
    const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filename.startsWith(root + path.sep) && filename !== path.join(root, 'index.html')) { res.writeHead(403); res.end(); return; }
    const data = await readFile(filename);
    res.writeHead(200, { 'Content-Type': types[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end('Not found'); }
});
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && port < 4183) { port += 1; server.listen(port, '127.0.0.1'); }
  else { console.error(error.message); process.exitCode = 1; }
});
server.listen(port, '127.0.0.1', () => console.log(`Local: http://127.0.0.1:${port}`));
