// 浮层验收脚本：点徽标 → 断言 Ring 的浮层打开且**渲染出我们的内容**。
// 诊断输出分三档，能直接分辨失败在哪一环：
//   ① aria-expanded：点击是否传到了锚点（Ring 会往锚点写这个属性）
//   ② popup 元素数：浮层容器是否被渲染出来
//   ③ DOM 里是否有内容文字：内容是否进了浮层
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
const URL_ARG = process.argv[2]!;
const OUT = process.argv[3] ?? '..\\shots\\devroom';
const PORT = 9340;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const browser = spawn(['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p))!, ['--headless=new', '--disable-gpu', '--window-size=1440,900', '--remote-debugging-port=' + PORT, 'about:blank'], { stdio: 'ignore' });
try {
  for (let i = 0; i < 60; i++) { try { await fetch('http://127.0.0.1:' + PORT + '/json/version'); break; } catch { await sleep(250); } }
  const t = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(URL_ARG), { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res));
  let id = 0; const pending = new Map<number, (v: any) => void>();
  ws.addEventListener('message', (ev) => { const m = JSON.parse(String(ev.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } });
  const send = (method: string, params: Record<string, unknown> = {}) => new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable'); await send('Runtime.enable');
  await sleep(1800);

  const box = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('管理员')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, attrs: b.getAttributeNames().join(',') }; })()`,
  });
  const pt = box.result.result.value;
  console.log('徽标坐标：' + JSON.stringify(pt ? { x: Math.round(pt.x), y: Math.round(pt.y) } : null));
  console.log('点击前锚点属性：' + (pt ? pt.attrs : '(没找到)'));

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await sleep(800);

  const probe = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const anchor = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('管理员'));
      return {
        expanded: anchor ? anchor.getAttribute('aria-expanded') : null,
        haspopup: anchor ? anchor.getAttribute('aria-haspopup') : null,
        popups: document.querySelectorAll('*[class*=popup]').length,
        hasText: document.body.innerText.includes('基线角色'),
      };
    })()`,
  });
  const v = probe.result.result.value;
  console.log('① 点击后 aria-expanded=' + v.expanded + '  aria-haspopup=' + v.haspopup);
  console.log('② class 含 popup 的元素数=' + v.popups);
  console.log('③ DOM 里出现「基线角色」=' + v.hasText);
  console.log((v.hasText ? '✓' : '✗') + ' 浮层内容渲染出来了');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT + '\\dropdown-ring.png', Buffer.from(shot.result.data, 'base64'));
  console.log('截图：' + OUT + '\\dropdown-ring.png');
  ws.close();
} finally { browser.kill(); }
