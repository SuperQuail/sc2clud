// 头像入口（AvatarPicker）的出图脚本 —— 2026-10-14 用户要求「点击头像换图 + 悬停显示替换图像」。
//
// 与 scripts/shoot-k2b.ts 同一条规矩：CDP 直连 headless Chrome，**只关自己起的那个浏览器**。
// 一处不同：悬停态**必须真悬停** —— 用 Input.dispatchMouseEvent(type=mouseMoved) 把鼠标真移进去，
// 而不是给覆盖层强加一个 opacity:1（那样拍到的不是悬停，是我自己改的样式）。
//
// 用法：node scripts/shoot-avatar.ts <baseUrl> <outDir>
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BROWSERS = [
  process.env.SHOT_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean) as string[];

type Clip = { x: number; y: number; width: number; height: number };
type Page = {
  eval: <T>(expression: string) => Promise<T>;
  hover: (selector: string) => Promise<boolean>;
  click: (selector: string) => Promise<boolean>;
  wait: (ms: number) => Promise<void>;
  shot: (path: string, full: boolean) => Promise<void>;
  clipOf: (selector: string) => Promise<Clip | null>;
};

const [base = 'http://localhost:5271/product.html',
  outDir = join(process.cwd(), '..', 'shots', 'avatar')] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const ENTRY = '[data-testid=avatar-upload-entry]';
const shots = [
  // ① 产品页个人主页：鼠标停在头像上 → 暗色滤镜 + 「替换图像」（近景：看清覆盖层文字）
  { name: 'avatar-hover-1440', url: '?stub=1&asAdmin=1&route=/u/demo-admin', width: 1440, height: 900, hover: true },
  // ①b 同一态的全页图（要看清它在 hero 里的位置与周围元素的关系）
  { name: 'avatar-hover-wide-1440', url: '?stub=1&asAdmin=1&route=/u/demo-admin', width: 1440, height: 900, hover: true, wide: true },
  // ② 窄屏同一态（覆盖层文字必须还装得下、不溢出）
  { name: 'avatar-hover-390', url: '?stub=1&asAdmin=1&route=/u/demo-admin', width: 390, height: 844, hover: true },
  // ③ DevRoom 11-profile（与真站同一份 hero）：悬停同样出覆盖层
  { name: 'avatar-hover-devroom-1440', url: 'http://localhost:5271/devroom.html?page=11-profile', width: 1440, height: 900, hover: true },
  // ④ 点头像之后：房间里是「切到设置标签并打开文件框」——拍到的是设置标签里的真上传器
  { name: 'avatar-click-opens-picker-devroom-1440', url: 'http://localhost:5271/devroom.html?page=11-profile', width: 1440, height: 900, click: true },
];

async function main() {
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) throw new Error('找不到 Chrome/Edge');
  const port = 9451;
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore' });
  let ws: WebSocket | null = null;
  let nextId = 0;
  type CdpReply = { result?: { data?: string; result?: { value?: unknown } } };
  const pending = new Map<number, (v: CdpReply) => void>();
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  try {
    for (let i = 0; i < 80; i++) {
      try { await fetch('http://127.0.0.1:' + port + '/json/version'); break; } catch { await sleep(250); }
    }
    const send = (method: string, params: Record<string, unknown> = {}) =>
      new Promise<CdpReply>((res) => { const id = ++nextId; pending.set(id, res); ws!.send(JSON.stringify({ id, method, params })); });
    let failed = 0;
    for (const s of shots) {
      const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
      ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res) => ws!.addEventListener('open', res));
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data)) as CdpReply & { id?: number };
        if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
      });
      await send('Page.enable');
      await send('Runtime.enable');
      const problems: string[] = [];
      ws!.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data)) as { method?: string; params?: { type?: string; exceptionDetails?: { exception?: { description?: string } }; args?: Array<{ value?: unknown; description?: string }> } };
        if (m.method === 'Runtime.exceptionThrown') problems.push('异常: ' + (m.params?.exceptionDetails?.exception?.description ?? '').slice(0, 300));
        if (m.method === 'Runtime.consoleAPICalled' && m.params?.args?.length) {
          problems.push('console.' + (m.params.type ?? '?') + ': ' + m.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' ').slice(0, 300));
        }
      });
      await send('Emulation.setDeviceMetricsOverride', { width: s.width, height: s.height, deviceScaleFactor: 1, mobile: false });
      const evalIn = async <T>(expression: string): Promise<T> => {
        const r = await send('Runtime.evaluate', { returnByValue: true, expression });
        return r.result?.result?.value as T;
      };
      const centerOf = (selector: string) =>
        evalIn<{ x: number; y: number } | null>(
          `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
        );
      const page: Page = {
        eval: evalIn,
        async hover(selector) {
          const b = await centerOf(selector);
          if (!b) return false;
          // 先落到别处再移进来：一次 mouseMoved 有可能被当成「本来就在那儿」，移进来才产生 hover 状态变化
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
          return true;
        },
        async click(selector) {
          const b = await centerOf(selector);
          if (!b) return false;
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: b.x, y: b.y });
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
          return true;
        },
        wait: sleep,
        async clipOf(selector) {
          return evalIn<Clip | null>(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.max(0, r.left - 40), y: Math.max(0, r.top - 40 + window.scrollY), width: r.width + 80, height: r.height + 80 }; })()`,
          );
        },
        async shot(path, full) {
          const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full });
          writeFileSync(path, Buffer.from(String(r.result?.data ?? ''), 'base64'));
        },
      };
      await send('Page.navigate', { url: s.url.startsWith('http') ? s.url : base + s.url });
      await page.wait(1800);
      try {
        if (s.hover) {
          if (!(await page.hover(ENTRY))) throw new Error('找不到头像入口 ' + ENTRY);
          await page.wait(500);
          // 拍近景（头像 + 周围一圈）：1440 整页里那颗头像太小，看不清覆盖层文字
          // wide=true 时拍整页（看它在 hero 里的位置）；否则拍头像近景（看清覆盖层文字）
          const clip = s.wide ? null : await page.clipOf(ENTRY);
          const file = join(outDir, s.name + '.png');
          const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
          writeFileSync(file, Buffer.from(String(r.result?.data ?? ''), 'base64'));
        } else {
          if (!(await page.click(ENTRY))) throw new Error('找不到头像入口 ' + ENTRY);
          await page.wait(700);
          await page.shot(join(outDir, s.name + '.png'), false);
        }
        console.log('OK   ' + s.name + '  ' + s.width + 'x' + s.height);
        for (const p of problems) console.log('     ! ' + p);
      } catch (e) {
        failed++;
        console.log('FAIL ' + s.name + '  ' + (e as Error).message);
      } finally {
        ws.close();
        ws = null;
      }
    }
    console.log('输出目录 ' + outDir + '，失败 ' + failed + ' 张');
    process.exitCode = failed > 0 ? 1 : 0;
  } finally {
    proc.kill();
  }
}

void main();
