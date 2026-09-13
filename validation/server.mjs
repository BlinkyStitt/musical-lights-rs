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
      const url = new URL(request.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      let file = resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
      let status = 200;
      let body;
      try {
        if ((await stat(file)).isDirectory()) {
          if (!url.pathname.endsWith('/')) {
            response.writeHead(301, { Location: `${url.pathname}/${url.search}` }).end();
            return;
          }
          file = resolve(file, 'index.html');
        }
        body = await readFile(file);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        // Match static hosting: only an emitted entry file can return 200.
        file = resolve(root, '404.html');
        body = await readFile(file);
        status = 404;
      }
      response.writeHead(status, {
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
