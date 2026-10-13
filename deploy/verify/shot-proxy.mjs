// 只为截图用的本地反向代理：浏览器要 http://127.0.0.1（Chrome 拦公网 IP 的明文 HTTP），
// 而 dev 实例把 SPA 挂在 /dev/、把构建产物挂在 /（nginx 在前面对外把两者拼起来）。
// 所以这里原样照抄 nginx 的规则：/dev/assets/* -> /assets/*，其余 -> 原样。
// shortcut: 只处理 GET，且不重写 HTML；截图够用，要交互就得反过来做成真反代。
import http from 'node:http';

const TARGET = 'http://127.0.0.1:18082';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  let path = url.pathname;
  if (path.startsWith('/dev/assets/')) path = path.slice(4);   // /dev/assets/x -> /assets/x
  else if (path === '/dev/favicon.ico') path = '/favicon.ico';
  const upstream = TARGET + path + url.search;
  try {
    const r = await fetch(upstream, { headers: { accept: req.headers.accept ?? '*/*' } });
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
