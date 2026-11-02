import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const prefix = '/walk-advisor/';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4319);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
try { await stat(resolve(root, 'index.html')); } catch { console.error('Run npm run build before npm start.'); process.exit(1); }
createServer(async (request, response) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, `http://${host}`).pathname); } catch { response.writeHead(400).end(); return; }
  if (pathname === '/' || pathname === '/walk-advisor') { response.writeHead(302, { Location: prefix }).end(); return; }
  if (!pathname.startsWith(prefix)) { response.writeHead(404).end('Not found'); return; }
  const path = resolve(root, pathname.slice(prefix.length) || 'index.html');
  if (!path.startsWith(root + '/')) { response.writeHead(403).end(); return; }
  try {
    const content = await readFile(path);
    response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(404).end('Not found'); }
}).listen(port, host, () => console.log(`Walk Window: http://${host}:${port}${prefix}`));
