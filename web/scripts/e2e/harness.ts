// 浏览器端到端断言的共享骨架（零依赖：CDP + Node 内置 WebSocket）。
// 为什么要有它：之前 7 个检查脚本各自复制了 40 行 CDP 样板，而且断言靠**匹配 HTML 字符串**——
// 元素一带 class 就误报（已经因此误判过两次：一次以为重构失败还回滚了）。
// 这里的规矩：**断言只能查 DOM 结构**（exists / count / text / attr / 计算样式），不许匹配 innerHTML 源码。
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const BROWSERS = [
  process.env.SHOT_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean) as string[];

export type Page = {
  eval: <T>(expression: string) => Promise<T>;
  clickSelector: (selector: string) => Promise<boolean>;
  clickByText: (text: string) => Promise<boolean>;
  type: (text: string) => Promise<void>;
  selectAll: () => Promise<void>;
  press: (key: string, code: string, vk: number, modifiers?: number) => Promise<void>;
  count: (selector: string) => Promise<number>;
  text: (selector: string) => Promise<string | null>;
  attr: (selector: string, name: string) => Promise<string | null>;
  style: (selector: string, prop: string) => Promise<string | null>;
  box: (selector: string) => Promise<{ x: number; y: number; right: number; bottom: number } | null>;
  shot: (path: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
};

export type Assertion = { name: string; ok: boolean; detail?: string };
export type Check = { name: string; url: string; run: (page: Page) => Promise<Assertion[]>; before?: (page: Page) => Promise<void> };

let browserProc: ReturnType<typeof spawn> | null = null;
let ws: WebSocket | null = null;
let nextId = 0;
const pending = new Map<number, (v: any) => void>();
const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

async function startBrowser(port: number) {
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) throw new Error('找不到 Chrome/Edge');
  browserProc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--window-size=1440,900', '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { await fetch('http://127.0.0.1:' + port + '/json/version'); return; } catch { await sleep(250); }
  }
  throw new Error('调试端口没起来');
}

async function connect(port: number, url: string) {
  const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(url), { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res) => ws!.addEventListener('open', res));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
  });
}

const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((res) => { const id = ++nextId; pending.set(id, res); ws!.send(JSON.stringify({ id, method, params })); });

function makePage(): Page {
  const evalIn = async <T>(expression: string): Promise<T> => {
    const r = await send('Runtime.evaluate', { returnByValue: true, expression });
    if (r.result?.exceptionDetails) throw new Error('页面里执行失败：' + JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return r.result.result.value as T;
  };
  const clickAt = async (x: number, y: number) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  return {
    eval: evalIn,
    async clickSelector(selector) {
      const b = await evalIn<{ x: number; y: number } | null>(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      if (!b) return false;
      await clickAt(b.x, b.y);
      return true;
    },
    async clickByText(text) {
      const b = await evalIn<{ x: number; y: number } | null>(
        `(() => { const el = [...document.querySelectorAll('button,a,[role=button]')].find((x) => (x.textContent ?? '').includes(${JSON.stringify(text)})); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
      );
      if (!b) return false;
      await clickAt(b.x, b.y);
      return true;
    },
    async type(text) {
      await send('Input.insertText', { text });
    },
    async selectAll() {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
    },
    async press(key, code, vk, modifiers = 0) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
    },
    count: (selector) => evalIn<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`),
    text: (selector) => evalIn<string | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.textContent : null; })()`),
    attr: (selector, name) => evalIn<string | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? el.getAttribute(${JSON.stringify(name)}) : null; })()`),
    style: (selector, prop) => evalIn<string | null>(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? getComputedStyle(el).getPropertyValue(${JSON.stringify(prop)}) : null; })()`),
    box: (selector) => evalIn<{ x: number; y: number; right: number; bottom: number } | null>(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, right: r.right, bottom: r.bottom }; })()`,
    ),
    async shot(path) {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path, Buffer.from(r.result.data, 'base64'));
    },
    wait: sleep,
  };
}

/** 一次启动浏览器，按顺序跑所有检查；每个检查各自开一个页面，互不干扰。 */
export async function runChecks(checks: Check[], opts: { base: string; port?: number; shotDir: string }) {
  const port = opts.port ?? 9342;
  await startBrowser(port);
  let failed = 0;
  try {
    for (const check of checks) {
      await connect(port, opts.base + check.url);
      await send('Page.enable');
      await send('Runtime.enable');
      const page = makePage();
      await page.wait(1800);
      console.log('\n▶ ' + check.name);
      try {
        await check.before?.(page);
        const results = await check.run(page);
        for (const a of results) {
          if (!a.ok) failed++;
          console.log('  ' + (a.ok ? '✓' : '✗') + ' ' + a.name + (a.detail ? '　' + a.detail : ''));
        }
        await page.shot(opts.shotDir + '\\e2e-' + check.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.png');
      } catch (e) {
        failed++;
        console.log('  ✗ 检查抛异常：' + (e as Error).message);
      } finally {
        ws?.close();
        ws = null;
      }
    }
  } finally {
    browserProc?.kill();
  }
  console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 条断言失败'));
  return failed;
}
