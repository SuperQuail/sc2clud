// CDP 断言：在正文插入图片后计数器 +1，在正文删掉图片后计数器 -1。
// 跑法：node scripts/image-counter-check.ts <url>
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const URL_ARG = process.argv[2] ?? 'http://127.0.0.1:5247/devroom.html?page=09-rich&demo=image';
const PORT = 9336;
const BROWSERS = [
  process.env.SHOT_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean) as string[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const browser = spawn(BROWSERS.find((p) => existsSync(p)) ?? BROWSERS[1]!, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1440,900',
  '--remote-debugging-port=' + PORT, 'about:blank',
], { stdio: 'ignore' });

try {
  for (let i = 0; i < 60; i++) {
    try { await fetch('http://127.0.0.1:' + PORT + '/json/version'); break; } catch { await sleep(250); }
  }
  const target = await (await fetch('http://127.0.0.1:' + PORT + '/json/new?' + encodeURIComponent(URL_ARG), { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res));
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(1800);

  const counter = async () => {
    const r = await send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const el = [...document.querySelectorAll('span')].find((s) => /^\\d+ \\/ 10/.test((s.textContent ?? '').trim()));
        const imgs = document.querySelectorAll('[contenteditable=true] img').length;
        return { text: el ? el.textContent.trim() : null, imgs };
      })()`,
    });
    return r.result.result.value as { text: string | null; imgs: number };
  };

  const a = await counter();
  console.log('插入后：计数器=' + JSON.stringify(a.text) + '  正文图片=' + a.imgs);
  console.log((a.text?.startsWith('1 /') && a.imgs === 1 ? '✓' : '✗') + ' 插入图片后计数器为 1');

  await send('Runtime.evaluate', { expression: "document.querySelector('[contenteditable=true]').focus()" });
  const key = (k: string, code: string, vk: number, mods = 0) =>
    send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods })
      .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }));
  await key('a', 'KeyA', 65, 2); // Ctrl+A
  await sleep(200);
  await key('Backspace', 'Backspace', 8);
  await sleep(400);

  const b = await counter();
  console.log('删除后：计数器=' + JSON.stringify(b.text) + '  正文图片=' + b.imgs);
  console.log((b.text?.startsWith('0 /') && b.imgs === 0 ? '✓' : '✗') + ' 删掉图片后计数器回到 0');

  ws.close();
} finally {
  browser.kill();
}
