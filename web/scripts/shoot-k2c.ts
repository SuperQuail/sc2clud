// K2-C 的出图脚本（拍板 08 第二轮 · 6.2 / L6 后台侧）。与 scripts/shoot-k2b.ts / shoot-kfe.ts 同一条规矩：
// CDP 直连 headless Chrome，只关自己起的那个浏览器（绝不按进程名群杀）；端口与出图目录都是自己的号。
// 用法：node scripts/shoot-k2c.ts <baseUrl> <outDir>
// 入口是 admin.html（后台 12 屏的出图入口），route=/admin/review。
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
// base 是**站点根**（不是 admin.html 本身）：每张图的 url 前面会拼它 ——
// 第一次跑时 base 传成了 http://127.0.0.1:5299/admin.html，拼出来是
// /admin.html/admin.html?… → 落进 SPA fallback → 拍到一张产品的 404 页（图上看着像"没这屏"）。
const [base = 'http://127.0.0.1:5299', outDir = join(process.cwd(), '..', 'shots', 'k2c')] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

// 每张图先往 DOM 里插一个**可见标记**：图上读得到它，才证明拍的是当前源码而不是旧产物（交接单 §5.4）。
const STAMP = 'K2C-review';

// route 用**不转义**的斜杠：K2-B 那份脚本写的 %2F 在这一屏上没被 URLSearchParams 解回来
// （图上读到的 marker 就是 "MARKER-ADMIN %2Fadmin%2Freview"），于是路由不匹配、拍成 404。
const ADMIN = '/admin.html?stub=1&asAdmin=1&route=/admin/review';

const shots: Shot[] = [
  // ① 待审档：五个档位都在（多出来的「打回修改」「待替换改动」就是这一轮加的）
  { name: 'review-pending-1440', url: ADMIN, width: 1440, height: 1100, full: false, before: stamp },
  // ② 待替换改动档（06.2 的闭环）：行是**已发布**的帖，按钮说「放行改动」
  { name: 'review-draft-1440', url: ADMIN, width: 1440, height: 1100, full: false, before: tapTab('待替换改动') },
  // ③ 打回修改档（第四态）：状态列显示「打回修改」，三个动作都在
  { name: 'review-revision-1440', url: ADMIN, width: 1440, height: 1100, full: false, before: tapTab('打回修改') },
  // ④ 点「打回修改」→ 二次确认弹层：文案与「拒绝」分开，理由必填
  { name: 'review-request-revision-dialog-1440', url: ADMIN, width: 1440, height: 1100, full: false, before: openRevisionDialog },
  // ⑤ 窄屏：表格横向滚动 + 档位不挤爆
  { name: 'review-draft-390', url: ADMIN, width: 390, height: 900, full: true, before: tapTab('待替换改动') },
];

/** 从 URL 的 route 参数里取档位不方便（档位是屏上的本地 state），所以直接点那颗 tab。 */
function tapTab(title: string) {
  return async (page: Page) => {
    await page.wait(1200);
    await stamp(page);
    const tabs = '[data-test="ring-dumb-tabs"]';
    const ok = await page.eval<boolean>(
      `(() => { const box = document.querySelector('${tabs}'); if (!box) return false;
        const b = [...box.querySelectorAll('button')].find((x) => (x.textContent ?? '').trim().startsWith('${title}'));
        if (!b) return false; b.click(); return true; })()`,
    );
    if (!ok) throw new Error('没有这个档位：' + title);
    await page.wait(800);
  };
}

/** 点第一行的「打回修改」，等二次确认弹层。 */
async function openRevisionDialog(page: Page) {
  await page.wait(1200);
  await stamp(page);
  const ok = await page.eval<boolean>(
    "(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.textContent ?? '').trim() === '打回修改'); if (!b) return false; b.click(); return true; })()",
  );
  if (!ok) throw new Error('找不到「打回修改」');
  await page.wait(600);
}

/** 可见标记：图上读得到 STAMP，才证明这张图拍的是当前源码（不是旧产物）。 */
async function stamp(page: Page) {
  await page.eval(
    "(() => { const p = document.createElement('p'); p.textContent = '" + STAMP + "';" +
      " p.setAttribute('style', 'position:fixed;right:8px;bottom:8px;z-index:99999;background:#111;color:#fff;font:12px monospace;padding:2px 6px;border-radius:4px');" +
      " document.body.appendChild(p); return true; })()",
  );
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
        const m = JSON.parse(String(ev.data)) as { method?: string; params?: { exceptionDetails?: { exception?: { description?: string } }; args?: Array<{ value?: unknown }> } };
        if (m.method === 'Runtime.exceptionThrown') problems.push('异常: ' + (m.params?.exceptionDetails?.exception?.description ?? '').slice(0, 400));

        if (m.method === 'Runtime.consoleAPICalled' && m.params?.args?.length) {
          const line = m.params.args
            .map((a) => String(a.value ?? (a as { description?: string }).description ?? ''))
            .join(' ')
            .slice(0, 400);
          problems.push('console: ' + line); // K2-B 那份脚本这一行的 m.params.type 有类型错（未修）；这里不抄它
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