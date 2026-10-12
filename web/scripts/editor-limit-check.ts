// CDP 断言：正文字数上限真的生效（敲超过上限的字，应被截到上限且计数满格）。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const URL_ARG = process.argv[2] ?? 'http://127.0.0.1:5248/devroom.html?page=09-rich';
const LIMIT = Number(process.argv[3] ?? 20000);
const PORT = 9337;
const BROWSERS = [process.env.SHOT_BROWSER, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean) as string[];
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
  await send('Page.enable'); await send('Runtime.enable');
  await sleep(1800);

  await send('Runtime.evaluate', { expression: "document.querySelector('[contenteditable=true]').focus()" });
  // 敲超过上限的字符（分块灌，避免一次性太大）
  const chunk = 'a'.repeat(5000);
  for (let i = 0; i < Math.ceil((LIMIT + 5) / 5000); i++) await send('Input.insertText', { text: chunk });
  await sleep(1500);

  const r = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const editor = document.querySelector('[contenteditable=true]');
      const el = [...document.querySelectorAll('span')].find((s) => /\\/ ${LIMIT}/.test(s.textContent ?? ''));
      return { counter: el ? el.textContent.trim() : null, len: (editor.textContent ?? '').length };
    })()`,
  });
  const v = r.result.result.value;
  console.log('打入 ' + (LIMIT + 5) + ' 字后：正文长度=' + v.len + '  计数=' + JSON.stringify(v.counter));
  console.log((v.len === LIMIT ? '✓' : '✗') + ' 正文被截到上限 ' + LIMIT);
  ws.close();
} finally {
  browser.kill();
}
