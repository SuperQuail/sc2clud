// CDP 断言：点徽标后 Ring 的浮层出现，且**有我们的内容**（不是空壳）。
//
// ⚠️ 现状：**跑不通（✗）**。用 Ring 的 DropdownMenu + children 渲染函数 + PopupMenu 重构
// DropdownPanel 时，浮层打不开（合成 click 与 CDP 真实鼠标事件都试过）。
// 代码已退回原实现，这个脚本留作复现与下一步的验收标准：改对了它就该输出 ✓。
// 下一步方向（来自类型定义，不是猜）：anchor 支持渲染函数形式
//   anchor={(props, ariaProps) => <button {...props} {...ariaProps}>…</button>}
// 我那次用的是 <span>{trigger}</span>——Ring 注入的开合属性多半没有真正落到触发元素上。
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
  // 点「管理员」徽标（07 页第一个可点徽标）
  const box = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('管理员')); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
  });
  const pt = box.result.result.value;
  console.log('徽标坐标：' + JSON.stringify(pt));
  // 真实鼠标事件：Ring 的 Dropdown 靠 mousedown，合成的 .click() 打不开
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
  await sleep(600);
  const r = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => { const popup = document.querySelector('[class*=popup] [class*=popup], [role=dialog]'); const panel = [...document.querySelectorAll('div')].find((d) => d.textContent === '基线角色'); return { popup: !!popup, hasContent: !!panel, text: panel ? panel.parentElement.textContent.slice(0, 60) : null }; })()`,
  });
  const v = r.result.result.value;
  console.log('浮层出现=' + v.popup + '  含我们的内容=' + v.hasContent);
  console.log('内容片段=' + JSON.stringify(v.text));
  console.log((v.popup && v.hasContent ? '✓' : '✗') + ' Ring 浮层里渲染出我们的内容');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT + '\\dropdown-ring.png', Buffer.from(shot.result.data, 'base64'));
  console.log('截图：' + OUT + '\\dropdown-ring.png');
  ws.close();
} finally { browser.kill(); }
