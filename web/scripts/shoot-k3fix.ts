// K3-FIX 的出图脚本（拍板 08 §第三轮 1/2/3/4/5 的渲染验收）。与 scripts/shoot-k2b.ts /
// shoot-k2c.ts 同一条规矩：CDP 直连 headless Chrome，只关自己起的那个浏览器（绝不按进程名群杀）；
// 端口与出图目录都是自己的号。**产品页入口**（product.html + src/preview/product-fixture.ts 的桩）。
//
// 用法：node scripts/shoot-k3fix.ts <baseUrl> <outDir>
//
// 图上的可见标记由 product.html 的入口自己插（左下角 MARKER-PRODUCT-…）：读得到它，
// 才证明拍的是**当前源码**而不是旧产物（交接单 §5.4）。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BROWSERS = [
  process.env.SHOT_BROWSER,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean) as string[];

type Shot = { name: string; url: string; width: number; height: number; full: boolean; before?: (page: Page) => Promise<void>; main?: string };

// 主机名必须 localhost（vite 只绑 ::1）。route 里的 ? 与 & 必须转义成 %3F / %26：
// 不转义就变成 product.html 自己的参数、永远到不了路由。
const [base = 'http://localhost:5199/product.html', outDir = join(process.cwd(), '..', 'shots', 'k3fix')] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const TOPIC = '?stub=1&me=author&route=%2Ft%2Ftp-1';

const shots: Shot[] = [
  // ① 帖子页默认态（1440）：左栏「成员」是真数（128，不再是恒 0）、右栏作者卡有角色徽标、
  //    关注按钮是「关注分区」
  { name: 'topic-default-1440', url: TOPIC, width: 1440, height: 1100, full: false },
  // ② 点了「关注分区」→ 按钮变「已关注」且成员数 +1（真请求、真回执）
  { name: 'topic-followed-1440', url: TOPIC, width: 1440, height: 1100, full: false, before: followBoard },
  // ③ 窄屏（390 整页）：那一格与徽标在窄屏下不挤爆
  { name: 'topic-default-390', url: TOPIC, width: 390, height: 1000, full: true },
  // ④ @ 提及候选（任务 4）：在回复框里敲 @ 拉出候选菜单（真端点 /search?type=users）
  { name: 'topic-mention-menu-1440', url: TOPIC, width: 1440, height: 1100, full: false, before: openMentionMenu },
  // ⑤ 编辑弹层（任务 5）：正文那格是 MarkdownEditor（工具栏 + 初始内容来自 content_md）
  { name: 'topic-edit-dialog-1440', url: TOPIC, width: 1440, height: 1100, full: false, before: openEditDialog },
  // ⑥ 编辑弹层的校验态（非默认态）：标题清空 → 「标题至少 4 个字」
  { name: 'topic-edit-invalid-1440', url: TOPIC, width: 1440, height: 1100, full: false, before: openEditInvalid },
  // ⑦ 编辑弹层窄屏（390）
  { name: 'topic-edit-dialog-390', url: TOPIC, width: 390, height: 1000, full: true, before: openEditDialog },
  // ⑧ 「已转人工」那一档（拍板 08 §第三轮 6）：pending 下面的第二种情形，
  //    文案必须与「正在自动检查」不同（否则作者分不出「等机器」还是「等人」）
  { name: 'topic-pending-human-1440', url: TOPIC + '&review=pending_human', width: 1440, height: 1100, full: false },
];

/** 点右栏那颗「关注分区」（等它把成员数换成真数之后再点）。 */
async function followBoard(page: Page) {
  await page.wait(1200);
  if (!(await page.clickByText('关注分区'))) throw new Error('找不到「关注分区」按钮');
  await page.wait(900);
}

/** 在评论区那个编辑器里敲一个 @，把候选菜单拉出来。 */
async function openMentionMenu(page: Page) {
  await page.wait(1600);
  const box = await page.clipOf('[contenteditable][data-placeholder]');
  if (!box) throw new Error('找不到正文编辑器');
  // **点进去**（Input.insertText 不产生按键事件，Lexical 的触发词插件因此不会跑）：
  // 先点一下拿到焦点，再用真正的 keyDown/char/keyUp 敲 '@'。
  await page.click('[contenteditable][data-placeholder]');
  await page.wait(400);
  await page.type('@', 50);
  await page.wait(900);
  // 敲一个字缩小候选（**必须是桩里真有的人**，否则候选列表是空的、图上看不出接线的效果）
  await page.typeText('示');
  await page.wait(1000);
  const menu = await page.eval<boolean>("(() => Boolean(document.querySelector('[data-mention-menu]')))()");
  if (!menu) throw new Error('@ 候选菜单没有出现（data-mention-menu）');
}

/** 打开编辑弹层（等 MarkdownEditor 挂上）。 */
async function openEditDialog(page: Page) {
  await page.wait(900);
  if (!(await page.click('[data-testid=topic-edit]'))) throw new Error('找不到「编辑」按钮');
  await page.wait(1200);
  const has = await page.eval<boolean>("(() => Boolean(document.querySelector('[role=dialog] [contenteditable][data-placeholder]')))()");
  if (!has) throw new Error('编辑弹层里没有富文本编辑器');
}

/** 编辑弹层的校验态：把标题清空再点保存。 */
async function openEditInvalid(page: Page) {
  await openEditDialog(page);
  await page.eval(
    "(() => { const el = document.querySelector('[role=dialog] input'); if (!el) return false; const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, ''); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()",
  );
  await page.wait(400);
  if (!(await page.click('[data-testid=edit-save]'))) throw new Error('找不到「保存」');
  await page.wait(500);
}

type Page = {
  eval: <T>(expression: string) => Promise<T>;
  click: (selector: string) => Promise<boolean>;
  clickByText: (text: string) => Promise<boolean>;
  insertText: (text: string) => Promise<void>;
  type: (text: string, vk: number) => Promise<void>;
  typeText: (text: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
  shot: (path: string, full: boolean, clip?: Clip) => Promise<void>;
  clipOf: (selector: string) => Promise<Clip | null>;
};
type Clip = { x: number; y: number; width: number; height: number };

async function main() {
  const exe = BROWSERS.find((p) => existsSync(p));
  if (!exe) throw new Error('找不到 Chrome/Edge');
  const port = 9444;
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
        async insertText(text) { await send('Input.insertText', { text }); },
        async type(text, vk) {
          await send('Input.dispatchKeyEvent', { type: 'keyDown', text, unmodifiedText: text, key: text, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: text, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
        },
        async typeText(text) {
          for (const ch of text) {
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch });
            await send('Input.dispatchKeyEvent', { type: 'char', text: ch, unmodifiedText: ch });
            await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
          }
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
      await page.wait(1800);
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
