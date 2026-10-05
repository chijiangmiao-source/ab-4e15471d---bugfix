// 零依赖静态文件服务器，行为与 docker/nginx.conf 对齐：
// GET /healthz -> 200 ok；其余路径映射到 dist（或 site）目录，找不到为 404。
// 仅供本地复核与 CI 兜底，生产由 Compose 中的 nginx 提供。
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const distArg = process.argv[2];
const base = join(root, '..', distArg ?? 'site');
const port = Number(process.env.PORT ?? 8090);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok\n');
    return;
  }
  let rel = url === '/' ? '/index.html' : url;
  const filePath = normalize(join(base, rel));
  if (!filePath.startsWith(base)) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': TYPES[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(port, () => console.log(`dev-server on http://localhost:${port} -> ${base}`));
