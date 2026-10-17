import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

// 预览用的极简静态服务器：node scripts/serve-preview.ts <目录> [端口]
// 为什么不用 vite preview / dev：它们的后台进程在这台机器上会被莫名杀掉，而截图只需要一个静态服务。
const root = process.argv[2] ?? 'preview-dist';
const port = Number(process.argv[3] ?? 5202);
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname === '/' ? '/preview.html' : url.pathname;
  const file = join(root, normalize(path));
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found: ' + path);
  }
}).listen(port, '127.0.0.1', () => console.log('preview server on http://127.0.0.1:' + port));
