import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };
const roots = [
  [8101, '../musical-leptos/dist'],
  [8102, '../musical-dioxus/target/dx/musical-dioxus/release/web/public'],
  [8103, '../musical-wasm'],
];
const servers = roots.map(([port, directory]) => {
  const root = resolve(directory);
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let file = resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
      try { if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html'); }
      catch { if (!extname(file)) file = resolve(root, 'index.html'); }
      const body = await readFile(file);
      response.writeHead(200, {
        'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      });
      response.end(body);
    } catch { response.writeHead(404).end('Not found'); }
  });
  server.listen(port, '127.0.0.1');
  return server;
});
process.on('SIGTERM', () => { for (const server of servers) server.close(); });
