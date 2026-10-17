// K2-B 的出图脚本（拍板 08 第二轮「壁纸替换」）。与 scripts/shoot-kfe.ts 同一条规矩：
// CDP 直连 headless Chrome，只关自己起的那个浏览器（绝不按进程名群杀）。
// 用法：node scripts/shoot-k2b.ts <baseUrl> <outDir>
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BROWSERS = [
  process.env.SHOT_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean) as string[];

type Shot = { name: string; url: string; width: number; height: number; full: boolean; before?: (page: Page) => Promise<void>; main?: string };

// **主机名必须是 localhost**（vite 只绑 ::1，走 127.0.0.1 会得到一张 ERR_CONNECTION_REFUSED 的漂亮截图）。
// route 里的 ? 与 & 必须转义成 %3F / %26（不转义会变成 product.html 自己的参数、永远到不了路由）。
const [base = 'http://localhost:5261/product.html', outDir = join(process.cwd(), '..', 'shots', 'k2b')] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

// 「图上拍的是当前源码」由页面自己的标记证明：后台左下角 MARKER-ADMIN <route>、
// 产品页左下角 MARKER-PRODUCT-LOGIN <route>（两者都是入口文件往 DOM 里插的可见标记，交接单 §5.4）。

const shots: Shot[] = [
  // ① 后台分区屏：这一分区已经有封面 → 「更换封面 + 清空封面」两颗都在
  { name: 'admin-board-cover-before-1440', url: 'http://localhost:5261/admin.html?stub=1&asAdmin=1&route=%2Fadmin%2Fboards', width: 1440, height: 1000, full: false },
  // ② 点了「清空封面」→ 草稿变了：预览回到占位块、「未保存 / 保存 1 项改动」出来（这就是"有效果"）
  { name: 'admin-board-cover-cleared-1440', url: 'http://localhost:5261/admin.html?stub=1&asAdmin=1&route=%2Fadmin%2Fboards', width: 1440, height: 1000, full: false, before: clearCover },
  // ③ 个人主页：hero 上是**换成的那张封面**（桩里 user.cover），右上「更换封面」可点
  { name: 'profile-cover-applied-1440', url: '?stub=1&asAdmin=1&route=/u/demo-admin', width: 1440, height: 900, full: false },
  // ④ 点了「更换封面」→ 弹层（16:9 预览 + 上传 + 清空封面）
  { name: 'profile-cover-dialog-1440', url: '?stub=1&asAdmin=1&route=/u/demo-admin', width: 1440, height: 900, full: false, before: openCoverDialog },
  // ⑤ 个人设置里的同一格子（同一个弹层组件，另一处入口）
  { name: 'settings-cover-1440', url: '?stub=1&asAdmin=1&route=/settings', width: 1440, height: 1200, full: true },
];

/** 点「清空封面」（后台那一屏）。 */
async function clearCover(page: Page) {
  await page.wait(900);
  if (!(await page.click('[data-testid=board-cover-clear]'))) throw new Error('找不到「清空封面」');
  await page.wait(400);
}

/** 点 hero 右上的「更换封面」，等弹层打开。 */
async function openCoverDialog(page: Page) {
  await page.wait(900);
  if (!(await page.click('[data-testid=change-cover]'))) throw new Error('找不到「更换封面」');
  await page.wait(600);
}

type Page = {
  eval: <T>(expression: string) => Promise<T>;
  click: (selector: string) => Promise<boolean>;
  clickByText: (text: string) => Promise<boolean>;
  insertText: (text: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
  shot: (path: string, full: boolean, clip?: Clip) => Promise<void>;
  clipOf: (selector: string) => Promise<Clip | null>;
};
type Clip = { x: number; y: number; width: number; height: number };

async function main() {
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) throw new Error('找不到 Chrome/Edge');
  const port = 9443;
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore' });
  let ws: WebSocket | null = null;
  let nextId = 0;
  // CDP 回包：这里只读 result/exceptionDetails 两个字段，别为它铺一套完整类型
  type CdpReply = { result?: { data?: string; result?: { value?: unknown }; exceptionDetails?: unknown } };
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
      // s.url 以 http 开头时当绝对地址用（DevRoom 走的是另一个 html 入口）
      // 先开一个 about:blank 的空标签、把监听器挂上，再 Page.navigate 过去 ——
      // 这样**页面加载期间的 console/异常**都被收得到（直接开目标 URL 会丢掉最早的几条，
      // 2026-10-14 后台分区屏拍成 404 时就是这么丢掉根因的）。
      const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
      ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res) => ws!.addEventListener('open', res));
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data)) as CdpReply & { id?: number };
        if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
      });
      await send('Page.enable');
      await send('Runtime.enable');
      // 控制台里的异常要打出来：出图时「页面是一张错误页」与「拍到了旧产物」长得一样，
      // 只有把页面的报错读回来才分得清（2026-10-14 个人主页就是这样被发现的）。
      const problems: string[] = [];
      ws!.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data)) as { method?: string; params?: { type?: string; exceptionDetails?: { exception?: { description?: string } }; args?: Array<{ value?: unknown; description?: string }> } };
        if (m.method === 'Runtime.exceptionThrown') problems.push('异常: ' + (m.params?.exceptionDetails?.exception?.description ?? '').slice(0, 400));

        if (m.method === 'Runtime.consoleAPICalled' && m.params?.args?.length) {
          const line = m.params.args
            .map((a) => String(a.value ?? a.description ?? ''))
            .join(' ')
            .slice(0, 400);
          problems.push('console.' + (m.params.type ?? '?') + ': ' + line);
        }
      });
      // 视口：headless 下必须显式覆盖，否则 window-size 决定布局、改不了
      await send('Emulation.setDeviceMetricsOverride', { width: s.width, height: s.height, deviceScaleFactor: 1, mobile: false });
      const evalIn = async <T>(expression: string): Promise<T> => {
        const r = await send('Runtime.evaluate', { returnByValue: true, expression });
        return r.result?.result?.value as T;
      };
      const page: Page = {
        eval: evalIn,
        async click(selector) {
          const b = await evalIn<{ x: number; y: number } | null>(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
          );
          if (!b) return false;
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
          return true;
        },
        async insertText(text) {
          await send('Input.insertText', { text });
        },
        async clipOf(selector) {
          return evalIn<Clip | null>(
            `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8 + window.scrollY), width: r.width + 16, height: r.height + 16 }; })()`,
          );
        },
        async clickByText(text) {
          const b = await evalIn<{ x: number; y: number } | null>(
            `(() => { const el = [...document.querySelectorAll('button,a,[role=button]')].find((x) => (x.textContent ?? '').includes(${JSON.stringify(text)})); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`,
          );
          if (!b) return false;
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 });
          await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 });
          return true;
        },
        wait: sleep,
        async shot(path, full, clip) {
          const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
          writeFileSync(path, Buffer.from(String(r.result?.data ?? ''), 'base64'));
        },
      };
      await send('Page.navigate', { url: s.url.startsWith('http') ? s.url : base + s.url });
      await page.wait(1600);
      try {
        await s.before?.(page);
        const file = join(outDir, s.name + '.png');
        const clip = s.main ? await page.clipOf(s.main) : null;
        await page.shot(file, s.full, clip ?? undefined);
        console.log('OK   ' + s.name + '  ' + s.width + 'x' + s.height + (s.full ? ' (整页)' : ''));
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