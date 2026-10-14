// FIX-IMG 的出图脚本（D1 / D3 的渲染验收）。与 scripts/shoot-k3fix.ts 同一条规矩：
// CDP 直连 headless Chrome，只关自己起的那个浏览器（绝不按进程名群杀）；端口与出图目录都是自己的号。
//
// 用法：node scripts/shoot-img.ts <baseUrl> <outDir>
//
// 图上要能证明拍的是**当前源码**：DevRoom 页自己带「第 N 页」的标题，产品页带左下角
// MARKER-PRODUCT-…（由 preview/product.tsx 插入），图里读得到才算数（交接单 §5.4）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BROWSERS = [
  process.env.SHOT_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean) as string[];

// 测试用的两张真图：1.3MB（应当**压缩后收下**）与 12MB（超过可压缩上限，应当**当场拒并只报一句**）。
const BIG_QR = join(process.cwd(), '..', 'shots', 'fix-img-fixtures', 'qr-1.3mb.png');
const HUGE = join(process.cwd(), '..', 'shots', 'fix-img-fixtures', 'enormous.png');

type Clip = { x: number; y: number; width: number; height: number };
type Page = {
  eval: <T>(expression: string) => Promise<T>;
  click: (selector: string) => Promise<boolean>;
  clickByText: (text: string) => Promise<boolean>;
  wait: (ms: number) => Promise<void>;
  shot: (path: string, full: boolean, clip?: Clip) => Promise<void>;
  clipOf: (selector: string) => Promise<Clip | null>;
  pickFile: (selector: string, file: string) => Promise<void>;
};
type Shot = { name: string; url: string; width: number; height: number; full: boolean; before?: (page: Page) => Promise<void>; main?: string };

const [base = 'http://127.0.0.1:5205', outDir = join(process.cwd(), '..', 'shots', 'fix-img')] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const devroom = (page: string): string => '/devroom.html?page=' + page;
// 产品页入口：route 里的 ? 与 & 必须转义成 %3F / %26，否则变成 product.html 自己的参数
const product = (route: string, extra = ''): string => '/product.html?stub=1' + extra + '&route=' + encodeURIComponent(route);

const RAIL = "[aria-label='分区']";
const CHANNEL_PANEL = "#payment-channels";

const shots: Shot[] = [
  // ① DevRoom 03-navigation：分区侧栏三态（有封面 / 无封面占位 / 空数据）
  { name: 'devroom-03-rail-1440', url: devroom('03-navigation'), width: 1440, height: 1100, full: false, main: RAIL },
  // ② 产品页首页（真壳 + 桩）：左栏分区列表 + 信息流
  { name: 'product-home-1440', url: product('/'), width: 1440, height: 1100, full: false },
  // ③ 产品页分区页：左栏与首页同一份 BoardRail（拆 View 之后不能坏）
  { name: 'product-board-1440', url: product('/b/custom-campaign'), width: 1440, height: 1100, full: false },
  // ④ 产品页窄屏：左栏在 xl 以下是收起的（hidden xl:flex），确认没被我的改动破掉
  { name: 'product-home-390', url: product('/'), width: 390, height: 1000, full: true },
  // ⑤ D1 现场（产品页 /settings#payment-channels）：上传之前
  { name: 'product-settings-channels-1440', url: product('/settings#payment-channels'), width: 1440, height: 1200, full: false, before: openChannels },
  // ⑥ D1 主证据：选一张 **1.3MB** 的图 —— 必须被收下（不再直接拒），且没有任何提示行
  { name: 'product-settings-channels-1.3mb-1440', url: product('/settings#payment-channels'), width: 1440, height: 1200, full: false, before: pickBigQr, main: CHANNEL_PANEL },
  // ⑦ D1 的另一半：超过可压缩上限的图**当场拒**，提示**只有一行**（旧行为是控件内部一行 + 宿主一行 = 两行）
  { name: 'product-settings-channels-toobig-1440', url: product('/settings#payment-channels'), width: 1440, height: 1200, full: false, before: pickHuge, main: CHANNEL_PANEL },
];

/** 滚到「赞赏与收款码」那一格（它在设置页最下面）。 */
async function openChannels(page: Page) {
  await page.wait(1800);
  const ok = await page.eval<boolean>(
    "(() => { const el = document.querySelector('#payment-channels'); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true; })()",
  );
  if (!ok) throw new Error('设置页里找不到 #payment-channels（这一段没渲染出来）');
  await page.wait(500);
}

/** D1：往收款码的 file input 里塞一张 1.3MB 的真 PNG，然后等管线跑完。 */
async function pickBigQr(page: Page) {
  await openChannels(page);
  if (!existsSync(BIG_QR)) throw new Error('测试大图不存在: ' + BIG_QR);
  await page.pickFile('#payment-channels input[type=file]', BIG_QR);
  await page.wait(3000);
  // 证据读回：这一格里的 alert 行数（必须 ≤1）与按钮文案（收下了才会回到「更换」）
  const seen = await page.eval<{ alerts: number; alert: string | null; buttons: string[] }>(
    "(() => { const p = document.querySelector('#payment-channels'); const al = p.querySelectorAll('[role=alert]'); return { alerts: al.length, alert: al[0] ? al[0].textContent : null, buttons: [...p.querySelectorAll('button')].map((b) => b.textContent).slice(0, 6) }; })()",
  );
  console.log('     D1 读回: ' + JSON.stringify(seen));
}

/** D1 的另一半：塞一张 12MB 的图（> AVATAR_MAX_BYTES），提示必须只有一行。 */
async function pickHuge(page: Page) {
  await openChannels(page);
  if (!existsSync(HUGE)) throw new Error('测试大图不存在: ' + HUGE);
  await page.pickFile('#payment-channels input[type=file]', HUGE);
  await page.wait(2000);
  const seen = await page.eval<{ alerts: number; alert: string | null }>(
    "(() => { const p = document.querySelector('#payment-channels'); const al = p.querySelectorAll('[role=alert]'); return { alerts: al.length, alert: al[0] ? al[0].textContent : null }; })()",
  );
  console.log('     D1 太大提示读回: ' + JSON.stringify(seen));
  if (seen.alerts !== 1) throw new Error('体积提示必须是**一行**，实际 ' + seen.alerts + ' 行');
}

async function main() {
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) throw new Error('找不到 Chrome/Edge');
  const port = 9451;
  const proc = spawn(exe, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars', '--remote-debugging-port=' + port, 'about:blank'], { stdio: 'ignore' });
  let ws: WebSocket | null = null;
  let nextId = 0;
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
      const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?about:blank', { method: 'PUT' })).json();
      ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res) => ws!.addEventListener('open', res));
      ws.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data)) as CdpReply & { id?: number };
        if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
      });
      await send('Page.enable');
      await send('Runtime.enable');
      await send('DOM.enable');
      const problems: string[] = [];
      ws!.addEventListener('message', (ev) => {
        const m = JSON.parse(String(ev.data)) as { method?: string; params?: { exceptionDetails?: { exception?: { description?: string } }; args?: Array<{ value?: unknown }> } };
        if (m.method === 'Runtime.exceptionThrown') problems.push('异常: ' + (m.params?.exceptionDetails?.exception?.description ?? '').slice(0, 400));
        if (m.method === 'Runtime.consoleAPICalled' && m.params?.args?.length) {
          const line = m.params.args.map((a) => String(a.value ?? (a as { description?: string }).description ?? '')).join(' ').slice(0, 400);
          if (line.includes('Error') || line.includes('error')) problems.push('console: ' + line);
        }
      });
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
        // 给 input[type=file] 塞本地文件（CDP 的 DOM.setFileInputFiles）：headless 里没法点系统文件框，
        // 但**这条正是管线真正吃到的输入**（change 事件带 files），比在控制台伪造 File 更接近真实。
        async pickFile(selector, file) {
          const doc = await send('DOM.getDocument', { depth: -1, pierce: true });
          const root = (doc.result as { root?: { nodeId?: number } } | undefined)?.root;
          const q = await send('DOM.querySelector', { nodeId: root?.nodeId ?? 0, selector });
          const nodeId = (q.result as { nodeId?: number } | undefined)?.nodeId ?? 0;
          if (!nodeId) throw new Error('找不到 file input: ' + selector);
          await send('DOM.setFileInputFiles', { files: [file], nodeId });
        },
        wait: sleep,
        async shot(path, full, clip) {
          const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
          writeFileSync(path, Buffer.from(String(r.result?.data ?? ''), 'base64'));
        },
      };
      await send('Page.navigate', { url: s.url.startsWith('http') ? s.url : base + s.url });
      await page.wait(1800);
      try {
        await s.before?.(page);
        const file = join(outDir, s.name + '.png');
        const clip = s.main ? await page.clipOf(s.main) : null;
        await page.shot(file, s.full, clip ?? undefined);
        console.log('OK   ' + s.name + '  ' + s.width + 'x' + s.height + (s.full ? ' (整页)' : '') + (clip ? ' (裁 ' + s.main + ')' : ''));
        for (const p of problems) console.log('     ! ' + p);
      } catch (e) {
        failed++;
        console.log('FAIL ' + s.name + '  ' + (e as Error).message);
        for (const p of problems) console.log('     ! ' + p);
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
