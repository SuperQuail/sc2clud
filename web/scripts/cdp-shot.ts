// CDP 出图：点开浮层、**真的键入**、再截图 —— 用 Chrome 自己的 DevTools 协议，
// 不引 Playwright（仓库既有做法见 scripts/e2e.ts：CDP + Node 自带 WebSocket）。
//
// 为什么需要它：D11 的验收是「点搜索 → 就地展开搜索栏并聚焦 → 结果就地出现」，
// 而 --screenshot 那种一次性截图拍不到「键入之后」的状态（没有注入脚本的开关）。
//
// 用法:
//   node scripts/cdp-shot.ts <url> <out.png> [动作...]
//   动作: click:<css> | type:<css>:<文本> | wait:<ms> | shot:<path> | key:<Enter|Escape>
//         | size:<宽>x<高>（换视口，窄屏图用）| scroll:<css>（把某一块滚进视口）| mark:<文本>（往 DOM 插一个可见标记 —— 出图必须能自证
//           拍的是当前源码，见交接单 §5.4；产品页的标记由 product.html 自己插）
//
// 2026-10-14：本文件一开始漏了类型（22 条 tsc 错），**连带把 pnpm build 也卡住了**
// （build = tsc --noEmit && vite build，于是 pack-dev.ts 与 deploy.ps1 一起跑不动）。
// 它是 scripts/ 下的工具，不在产品构建里，但**在同一份 tsconfig 下** —— 工具也要能过 tsc。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
    // 视口可用 CDP_SIZE=390x844 覆盖 —— 版面缺陷只在窄屏出现，能拍窄屏是刚需
    '--window-size=' + (process.env.CDP_SIZE ?? '1440,900'),
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + profile,
    url,
  ],
  { stdio: 'ignore' },
);

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 一条 CDP **回包的 result 部分**（send() 已经把最外层剥掉了）。
 *
 * 层级说明（2026-10-14 踩过，FIX-JSON 实测报回）：`Runtime.evaluate` 的原始回包是
 * `{id, result: { result: {type,value}, exceptionDetails }}`；`Page.captureScreenshot` 是 `{id, result: {data}}`。
 * 这里把外面那层 result 当作 CdpResult 返回，所以取值是 `r.result.value` 与 `r.data` ——
 * **不要再包一层**（包了的表现就是 click/type 永远「点不到」、截图拍出 0 字节）。
 */
type CdpResult = {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string } };
  data?: string;
};

/** 等到 DevTools 端口起来并给出 webSocketDebuggerUrl */
async function targetWs(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const list = (await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()) as Array<{
        type?: string;
        webSocketDebuggerUrl?: string;
      }>;
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // 还没起来
    }
    await sleep(250);
  }
  throw new Error('DevTools 端口没起来');
}

class Cdp {
  ws: WebSocket;
  id = 0;
  pending = new Map<number, { resolve: (v: CdpResult) => void; reject: (e: Error) => void }>();

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener('message', (e: MessageEvent) => {
      const msg = JSON.parse(String(e.data)) as { id?: number; error?: unknown; result?: CdpResult };
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result ?? {});
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<CdpResult> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  /** 在页面里跑一段表达式，返回它的值（出错就抛出，别静默） */
  async eval<T = unknown>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('页面里报错: ' + String(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails)));
    }
    return r.result?.value as T;
  }

  async shot(path: string): Promise<void> {
    // CDP 的 Page.captureScreenshot 把 PNG 放在 result.data（base64），**不是** Runtime.evaluate 那种
    // result.value —— 这里曾经按 .value 读，于是每一张图都是 0 字节而脚本照样打印 OK
    // （2026-10-14 MIG-ART 实测：0 字节的「成功」出图比没有出图更糟）。
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    const b64 = typeof r.data === 'string' ? r.data : '';
    if (!b64) throw new Error('截图没拿到数据（result.data 为空）：' + path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(b64, 'base64'));
    console.log('OK   ' + path + ' (' + Buffer.from(b64, 'base64').length + ' 字节)');
  }
}

const wsUrl = await targetWs();
const ws = new WebSocket(wsUrl);
await new Promise<void>((resolve, reject) => {
  ws.addEventListener('open', () => resolve());
  ws.addEventListener('error', () => reject(new Error('WebSocket 连不上')));
});
const cdp = new Cdp(ws);
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await sleep(1500); // 让首屏渲染完（懒加载的 chunk 也要落地）

await cdp.shot(firstShot);

/** 按键表：索引前先落成具名类型，否则 `map[string]` 在 noImplicitAny 下报 TS7053 */
const KEYS: Record<string, Record<string, unknown>> = {
  Enter: { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r' },
  Escape: { windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27, key: 'Escape', code: 'Escape' },
};

for (const action of actions) {
  const [kind, ...rest] = action.split(':');
  if (kind === 'wait') {
    await sleep(Number(rest[0]));
  } else if (kind === 'click') {
    const sel = rest.join(':');
    const ok = await cdp.eval<boolean>(`(() => { const el = document.querySelector(\`${sel}\`); if (!el) return false; el.click(); return true; })()`);
    if (!ok) throw new Error('点不到: ' + sel);
  } else if (kind === 'scroll') {
    // 首屏之下的元素拍不到（截图是视口大小，不是整页）：先把目标滚到中间
    const sel = rest.join(':');
    const ok = await cdp.eval<boolean>(
      `(() => { const el = document.querySelector(\`${sel}\`); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()`,
    );
    if (!ok) throw new Error('滚不到: ' + sel);
    await sleep(250);
  } else if (kind === 'type') {
    const sel = rest[0];
    const text = rest.slice(1).join(':');
    // 走原生 setter + input 事件：React 的受控输入要靠这个才认（直接改 .value 不会触发 onChange）
    const ok = await cdp.eval<boolean>(`(() => {
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
    const d = KEYS[rest[0] ?? 'Enter'];
    if (!d) throw new Error('不认识的键: ' + rest[0]);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...d });
    if (d.text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...d });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...d });
  } else if (kind === 'shot') {
    await cdp.shot(rest.join(':'));
  } else if (kind === 'size') {
    const [w, h] = (rest[0] ?? '').split('x').map(Number);
    if (!w || !h) throw new Error('size 要写成 宽x高: ' + action);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
  } else if (kind === 'mark') {
    const text = rest.join(':');
    await cdp.eval(
      `(() => { const p = document.createElement('p'); p.id = 'shot-marker'; p.textContent = ${JSON.stringify(text)}; p.setAttribute('style', 'position:fixed;left:8px;bottom:8px;z-index:99999;background:#000;color:#fff;font:12px monospace;padding:2px 6px;border-radius:4px'); document.body.appendChild(p); return true; })()`,
    );
  } else {
    throw new Error('不认识的动作: ' + action);
  }
}

ws.close();
chrome.kill();
process.exit(0);
