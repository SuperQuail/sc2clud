// 用 CDP 真敲键验证 @ 候选菜单：真 Chrome、真输入、坐标断言（不靠肉眼看图）。
// 跑法：node scripts/mention-check.ts <url>   例：node scripts/mention-check.ts 'http://127.0.0.1:5239/devroom.html?page=09-rich'
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const URL_ARG = process.argv[2] ?? 'http://127.0.0.1:5239/devroom.html?page=09-rich';
const OUT = process.env.SHOT_OUT ?? '..\\shots\\devroom';
const PORT = 9334;
const BROWSERS = [
  process.env.SHOT_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean) as string[];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function json(path: string, method = 'GET') {
  const r = await fetch('http://127.0.0.1:' + PORT + path, { method });
  return r.json();
}

const browser = spawn(
  BROWSERS.find((p) => { try { return require('node:fs').existsSync(p); } catch { return false; } }) ?? BROWSERS[1]!,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--window-size=1440,900',
    '--remote-debugging-port=' + PORT,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

try {
  // 等调试端口起来
  for (let i = 0; i < 60; i++) {
    try { await json('/json/version'); break; } catch { await sleep(250); }
  }
  const target = await json('/json/new?' + encodeURIComponent(URL_ARG), 'PUT');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res));

  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)!(msg); pending.delete(msg.id); }
  });
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

  await send('Page.enable');
  await send('Runtime.enable');
  await sleep(1500); // 等 React 挂载

  // 真输入：聚焦编辑区 → 敲 '111 @'
  await send('Runtime.evaluate', { expression: "document.querySelector('[contenteditable=true]').focus()" });
  await send('Input.insertText', { text: '111 @' });
  await sleep(800);

  const probe = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const editor = document.querySelector('[contenteditable=true]');
      const menu = document.querySelector('[data-mention-menu]');
      const sel = window.getSelection();
      const caret = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
      if (caret) caret.collapse(false);
      return {
        editor: editor ? editor.getBoundingClientRect().toJSON() : null,
        menu: menu ? menu.getBoundingClientRect().toJSON() : null,
        caret: caret ? caret.getBoundingClientRect().toJSON() : null,
        items: menu ? menu.querySelectorAll('button').length : 0,
        text: editor ? editor.textContent : null,
      };
    })()`,
  });
  const r = probe.result.result.value;
  const { editor, menu, caret, items, text } = r;

  console.log('编辑区文字：' + JSON.stringify(text));
  console.log('候选条数：' + items);
  if (!menu) {
    console.log('✗ 菜单没出现');
  } else {
    const inEditorX = menu.left >= editor.left - 8 && menu.left <= editor.right;
    const nearCaret = menu.top >= caret.top - 8 && menu.top <= caret.bottom + 40;
    console.log('菜单 rect：left=' + Math.round(menu.left) + ' bottom=' + Math.round(menu.bottom) + ' w=' + Math.round(menu.width));
    console.log('光标 rect：left=' + Math.round(caret.left) + ' top=' + Math.round(caret.top));
    console.log((nearCaret ? '✓' : '✗') + ' 贴在触发文字那一行（官方默认朝下）');
    console.log((inEditorX ? '✓' : '✗') + ' 水平位置在编辑区内（不是页面角落）');
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT + '\\mention-cdp.png', Buffer.from(shot.result.data, 'base64'));
  console.log('截图：' + OUT + '\\mention-cdp.png');
  ws.close();
} finally {
  browser.kill();
}
