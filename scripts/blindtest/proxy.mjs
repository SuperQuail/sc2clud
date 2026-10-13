// 盲测用的本地反向代理：把 /dev/ 前缀剥掉，转发到 SSH 隧道（127.0.0.1:18082 -> dev 实例）。
// 为什么需要它：Chrome 拦「公网 IP + 明文 HTTP」(ERR_BLOCKED_BY_CLIENT)，而 127.0.0.1 不算公网。
// 与 nginx 的 /dev/ location 行为对齐：/dev/ -> /，/dev/api/... -> /api/...，Host 保持 191.40.41.97。
import http from 'node:http';

const TARGET = 'http://127.0.0.1:18082';
const PORT = Number(process.env.BT_PROXY_PORT || 19999);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  let p = u.pathname;
  if (p === '/dev') { res.writeHead(301, { location: '/dev/' }); return res.end(); }
  if (p.startsWith('/dev/')) p = p.slice(4); else if (p === '/dev') p = '/';
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  try {
    const r = await fetch(TARGET + p + u.search, {
      method: req.method,
      headers: {
        host: '191.40.41.97',
        accept: req.headers.accept ?? '*/*',
        'accept-language': req.headers['accept-language'] ?? 'zh-CN',
        ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
        ...(req.headers.cookie ? { cookie: req.headers.cookie } : {}),
        'x-forwarded-proto': 'http',
      },
      body,
      redirect: 'manual',
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const h = {};
    for (const [k, v] of r.headers) {
      if (['content-encoding', 'transfer-encoding', 'content-length'].includes(k)) continue;
      if (k === 'location') { h[k] = v.replace(/^\/(?!dev\/)/, '/dev/'); continue; }
      h[k] = v;
    }
    res.writeHead(r.status, h);
    res.end(buf);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain' }).end('proxy: ' + e.message);
  }
});
server.listen(PORT, '127.0.0.1', () => console.log('blindtest proxy http://127.0.0.1:' + PORT + '/dev/'));
