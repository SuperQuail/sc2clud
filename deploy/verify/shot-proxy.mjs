// 只为截图用的本地反向代理。浏览器要 http://127.0.0.1（Chrome 拦公网 IP 的明文 HTTP），
// 而 nginx 的对外 /dev/ 是靠 location 把前缀剥掉实现的：
//   /dev/            -> Go 的 /（SPA 壳）
//   /dev/assets/x    -> Go 的 /assets/x
//   /dev/api/v1/x    -> Go 的 /api/v1/x
//   /dev/img/<hash>  -> Go 的 /img/<hash>
// 不剥的话 SPA 兜底路由会拿 200 + HTML 应答 API 请求，前端解析不出数据（看起来就是「0 个帖子」）。
import http from 'node:http';

const TARGET = 'http://127.0.0.1:18082';
const STRIP = ['/assets/', '/api/', '/img/'];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  let path = p;
  if (p === '/dev' || p === '/dev/') {
    path = '/';
  } else if (p.startsWith('/dev/')) {
    const rest = p.slice(4);           // 去掉 '/dev'
    if (STRIP.some((s) => rest.startsWith(s))) path = rest;
  }
  try {
    const r = await fetch(TARGET + path + url.search, {
      headers: { accept: req.headers.accept ?? '*/*' },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, {
      'content-type': r.headers.get('content-type') ?? 'application/octet-stream',
      'content-length': buf.length,
    });
    res.end(buf);
  } catch (e) {
    res.writeHead(502).end('proxy: ' + e.message);
  }
});
server.listen(19999, '127.0.0.1', () => console.log('shot-proxy on http://127.0.0.1:19999'));
