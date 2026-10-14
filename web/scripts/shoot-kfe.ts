// K-FE 的出图脚本（L1 打赏整块）。用 CDP 直连 headless Chrome：
// 需要**点开**才看得到的态（打赏面板是折叠的）截不了静态图，而 window-size 改了视口就改不了布局。
// 与 scripts/shoot-admin.ps1 同一条规矩：只关自己起的那个浏览器，绝不按进程名群杀。
//
// 用法：node scripts/shoot-kfe.ts <baseUrl> <outDir>
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BROWSERS = [
  process.env.SHOT_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean) as string[];

type Shot = { name: string; url: string; width: number; height: number; full: boolean; before?: (page: Page) => Promise<void>; main?: string };

// 默认主机名用 **localhost 不是 127.0.0.1**：vite dev 在这台机器上只绑了 ::1（IPv6），
// 走 127.0.0.1 会 ERR_CONNECTION_REFUSED —— 而 Chrome 会把错误页照样截成一张图，
// 2026-10-14 因此拍出过一批「两张字节数完全相同」的假图（交接单 §5.4 说的就是这个坑）。
const [base = 'http://localhost:5321/product.html', outDir = join(process.cwd(), '..', 'shots', 'kfe')] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const shots: Shot[] = [
  // 个人主页 · 打赏入口（SponsorCard）：登录 + 作者有收款码
  { name: 'profile-sponsor-1440', url: '?stub=1&route=/u/demo-admin', width: 1440, height: 900, full: false },
  { name: 'profile-sponsor-open-1440', url: '?stub=1&route=/u/demo-admin', width: 1440, height: 900, full: false, before: openSponsor },
  // 填了金额的态：按钮从「先填金额」变成「我已完成 ¥10.00 的打赏」——**非默认态**，光拍折叠/空态不算验过
  { name: 'profile-sponsor-filled-1440', url: '?stub=1&route=/u/demo-admin', width: 1440, height: 900, full: false, before: fillAmount, main: 'main' },
  // 未登录：点开也看得见收款码（扫码不需要账号），但登记那一段换成「去登录」
  { name: 'profile-sponsor-guest-1440', url: '?stub=1&me=0&route=/u/demo-admin', width: 1440, height: 900, full: false, before: openSponsor },
  // 窄屏：390 宽下右栏掉到最后、按钮不能被挤变形
  { name: 'profile-sponsor-open-390', url: '?stub=1&route=/u/demo-admin', width: 390, height: 844, full: true, before: openSponsor },
  // 帖子页 · 右栏赞助格（RewardPanel）：同一份 DonateBox
  { name: 'topic-reward-open-1440', url: '?stub=1&route=/t/tp-1', width: 1440, height: 900, full: false, before: openSponsor },
  // 个人设置 · 赞赏与收款码（上传 / 删除 / 两个开关 / 我的打赏记录）
  { name: 'settings-rewards-1440', url: '?stub=1&route=/settings', width: 1440, height: 1200, full: true },
  { name: 'settings-rewards-390', url: '?stub=1&route=/settings', width: 390, height: 1200, full: true },
];

/** 点开赏卡/赞助格那颗大按钮（两页的按钮文案不同，按文案找）。 */
async function openSponsor(page: Page) {
  await page.wait(700);
  await page.clickByText('赞助');
  await page.wait(400);
}

/** 展开 + 填 10 元：按钮文案要变成「我已完成 ¥10.00 的打赏」（金额校验真的在起作用）。 */
async function fillAmount(page: Page) {
  await openSponsor(page);
  await page.click('[data-testid=donate-amount]');
  await page.insertText('10');
  await page.wait(300);
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
  const port = 9433;
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
      const target = await (await fetch('http://127.0.0.1:' + port + '/json/new?' + encodeURIComponent(base + s.url), { method: 'PUT' })).json();
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
        if (m.method === 'Runtime.exceptionThrown') problems.push('异常: ' + (m.params?.exceptionDetails?.exception?.description ?? '').slice(0, 300));
        if (m.method === 'Runtime.consoleAPICalled' && m.params?.args?.length) {
          const line = m.params.args.map((a) => String(a.value ?? '')).join(' ').slice(0, 300);
          if (line.includes('Error') || line.includes('error')) problems.push('console: ' + line);
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
      await page.wait(1500);
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
