// CDP 出图：点开浮层、**真的键入**、再截图 —— 用 Chrome 自己的 DevTools 协议，
// 不引 Playwright（仓库既有做法见 scripts/e2e.ts：CDP + Node 自带 WebSocket）。
//
// 为什么需要它：D11 的验收是「点搜索 → 就地展开搜索栏并聚焦 → 结果就地出现」，
// 而 --screenshot 那种一次性截图拍不到「键入之后」的状态（没有注入脚本的开关）。
//
// 用法:
//   node scripts/cdp-shot.ts <url> <out.png> [动作...]
//   动作: click:<css> | type:<css>:<文本> | wait:<ms> | shot:<path> | key:<Enter|Escape>
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const browser = process.env.SHOT_BROWSER ?? CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('找不到 Chrome/Edge');
  process.exit(2);
}

const [url, firstShot, ...actions] = process.argv.slice(2);
if (!url || !firstShot) {
  console.error('用法: node scripts/cdp-shot.ts <url> <out.png> [click:<css>] [type:<css>:<文本>] [wait:<ms>] [key:<Enter>] [shot:<path>]');
  process.exit(2);
}

const port = Number(process.env.CDP_PORT ?? 9333);
const profile = join(process.env.TEMP ?? '/tmp', 'sc2clud-cdp-shot');
rmSync(profile, { recursive: true, force: true });
const chrome = spawn(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1440,900',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    url,
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到 DevTools 端口起来并给出 webSocketDebuggerUrl */
async function targetWs() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error('DevTools 端口没起来');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  /** 在页面里跑一段表达式，返回它的值（出错就抛出，别静默） */
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('页面里报错: ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails));
    return r.result?.value;
  }
  async shot(path) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(dirname(path), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(path, Buffer.from(data, 'base64'));
    console.log('OK   ' + path);
  }
}

const wsUrl = await targetWs();
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
const cdp = new Cdp(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await sleep(1500); // 让首屏渲染完（懒加载的 chunk 也要落地）

await cdp.shot(firstShot);

for (const action of actions) {
  const [kind, ...rest] = action.split(':');
  if (kind === 'wait') {
    await sleep(Number(rest[0]));
  } else if (kind === 'click') {
    const sel = rest.join(':');
    const ok = await cdp.eval(`(() => { const el = document.querySelector(\`${sel}\`); if (!el) return false; el.click(); return true; })()`);
    if (!ok) throw new Error('点不到: ' + sel);
  } else if (kind === 'type') {
    const sel = rest[0];
    const text = rest.slice(1).join(':');
    // 走原生 setter + input 事件：React 的受控输入要靠这个才认（直接改 .value 不会触发 onChange）
    const ok = await cdp.eval(`(() => {
      const el = document.querySelector(\`${sel}\`);
      if (!el) return false;
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, \`${text}\`);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return document.activeElement === el;
    })()`);
    if (!ok) throw new Error('聚焦/赋值失败: ' + sel);
  } else if (kind === 'key') {
    // 回车要发三件事：rawKeyDown + char + keyUp —— 只发 keyDown 时浏览器不会走表单提交
    // （实测：输入框里字进去了、浮层停在 idle，什么都没发生）。
    const map = {
      Enter: { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r' },
      Escape: { windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, key: 'Escape', code: 'Escape' },
    };
    const d = map[rest[0] ?? 'Enter'];
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...d });
    if (d.text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...d });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...d });
  } else if (kind === 'shot') {
    await cdp.shot(rest.join(':'));
  } else {
    throw new Error('不认识的动作: ' + action);
  }
}

ws.close();
chrome.kill();
process.exit(0);
