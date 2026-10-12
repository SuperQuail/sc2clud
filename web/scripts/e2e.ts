// 浏览器断言总入口：`pnpm e2e`（先构建预览产物 → 起静态服务 → 跑全部检查）。
// 规矩（README 里也写着）：
//   ① 只查 DOM 结构，不匹配 HTML 源码；
//   ② 只认 data-testid，**不认中文文案**（改文案不该弄坏断言）；
//   ③ 颜色要归一化再比（令牌 #4cc2ff 与浏览器 rgb(...) 是同一个值）。
import { spawn } from 'node:child_process';
import { runChecks, type Check } from './e2e/harness.ts';

const PORT = 5271;
const BASE = 'http://127.0.0.1:' + PORT + '/devroom.html';
// Lexical 的 ContentEditable 不透传 data-*，所以用语义选择器（稳定、也不依赖文案）
const ED = '[contenteditable=true]';

/** 把令牌塞进临时元素读一次计算色：让两边都是浏览器认可的表示法 */
const NORMALIZE_TOKEN =
  "(() => { const t = getComputedStyle(document.documentElement).getPropertyValue('--mention-color').trim(); if (!t) return null; const probe = document.createElement('span'); probe.style.color = t; document.body.appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; })()";

const checks: Check[] = [
  {
    name: 'mention-menu',
    url: '?page=09-rich&demo=mention',
    run: async (p) => {
      const menu = await p.count('[data-mention-menu]');
      const box = await p.box('[data-mention-menu]');
      const ed = await p.box(ED);
      return [
        { name: '@ 后出现候选菜单', ok: menu === 1, detail: '菜单数=' + menu },
        { name: '菜单贴在编辑区内', ok: !!box && !!ed && box.x >= ed.x - 8 && box.x <= ed.right },
      ];
    },
  },
  {
    name: 'mention-atomic',
    url: '?page=09-rich&demo=mention',
    run: async (p) => {
      await p.press('Enter', 'Enter', 13);
      await p.wait(400);
      const chip = await p.count('.mention-chip');
      const userId = await p.attr('.mention-chip', 'data-mention');
      // 选中后面板已把焦点交回编辑区，直接退格即可（别点击：点击会滚动并可能丢焦点）
      await p.press('Backspace', 'Backspace', 8);
      await p.wait(300);
      return [
        { name: '选中后生成提及节点（带 user_id）', ok: chip === 1 && !!userId, detail: 'user_id=' + userId },
        { name: '一个退格删掉整块', ok: (await p.count('.mention-chip')) === 0 },
      ];
    },
  },
  {
    name: 'mention-keyboard',
    url: '?page=09-rich&demo=mention',
    run: async (p) => {
      // 打开状态由 demo 提供（那条路径已被上一组验证过），这里只验键盘：↓ 移动 + Enter 选中
      const opened = await p.count('[data-mention-menu]');
      await p.press('ArrowDown', 'ArrowDown', 40);
      await p.press('Enter', 'Enter', 13);
      await p.wait(400);
      const chip = await p.count('.mention-chip');
      const menu = await p.count('[data-mention-menu]');
      return [
        { name: '↑↓ 移动后 Enter 能选中', ok: opened === 1 && chip === 1, detail: '菜单=' + opened + ' 提及=' + chip },
        { name: '选中后菜单自动关闭', ok: menu === 0, detail: '剩余菜单=' + menu },
      ];
    },
  },
  {
    name: 'mention-escape',
    url: '?page=09-rich&demo=mention',
    run: async (p) => {
      const before = await p.count('[data-mention-menu]');
      await p.press('Escape', 'Escape', 27);
      await p.wait(300);
      const after = await p.count('[data-mention-menu]');
      return [{ name: 'Esc 关掉候选菜单', ok: before === 1 && after === 0, detail: before + ' → ' + after }];
    },
  },
  {
    name: 'mention-scroll-follow',
    url: '?page=09-rich&demo=mention',
    run: async (p) => {
      const before = await p.box('[data-mention-menu]');
      await p.eval('window.scrollBy(0, 240)');
      await p.wait(400);
      const after = await p.box('[data-mention-menu]');
      const ed = await p.box(ED);
      const moved = !!before && !!after && Math.abs(after.y - before.y) > 20;
      const stillNear = !!after && !!ed && after.y > ed.y - 400 && after.y < ed.bottom + 40;
      return [{ name: '滚动后菜单跟着走且不离位', ok: moved && stillNear, detail: 'y ' + Math.round(before?.y ?? -1) + ' → ' + Math.round(after?.y ?? -1) }];
    },
  },
  {
    name: 'mention-color-light',
    url: '?page=08-comments',
    run: async (p) => {
      const link = await p.count('a[data-mention]');
      const color = await p.style('a[data-mention]', 'color');
      const token = await p.eval<string | null>(NORMALIZE_TOKEN);
      return [
        { name: '正文里的提及是链接', ok: link > 0, detail: '数量=' + link },
        { name: '浅色：颜色等于令牌值', ok: !!color && color === token, detail: color + ' / ' + token },
      ];
    },
  },
  {
    name: 'mention-color-dark',
    url: '?page=08-comments&theme=dark',
    run: async (p) => {
      const color = await p.style('a[data-mention]', 'color');
      const token = await p.eval<string | null>(NORMALIZE_TOKEN);
      const themed = await p.attr('html', 'data-theme');
      return [
        { name: '深色主题生效（data-theme=dark）', ok: themed === 'dark', detail: 'data-theme=' + themed },
        { name: '深色：颜色等于令牌值', ok: !!color && color === token, detail: color + ' / ' + token },
      ];
    },
  },
  {
    name: 'image-counter',
    url: '?page=09-rich&demo=image',
    run: async (p) => {
      const before = await p.text('[data-testid=image-counter]');
      const imgs = await p.count(ED + ' img');
      await p.focus(ED);
      await p.selectAll();
      await p.press('Backspace', 'Backspace', 8);
      await p.wait(400);
      const after = await p.text('[data-testid=image-counter]');
      return [
        { name: '插入图片后计数为 1', ok: !!before && before.trim().startsWith('1 /') && imgs === 1, detail: before ?? '无' },
        { name: '删掉图片后计数回到 0', ok: !!after && after.trim().startsWith('0 /'), detail: after ?? '无' },
      ];
    },
  },
  {
    name: 'collapse',
    url: '?page=08-comments',
    run: async (p) => {
      const toggle = await p.count('[data-testid=collapse-toggle]');
      const masked = await p.eval<number>(
        "[...document.querySelectorAll('[data-testid=collapse-body]')].filter((d) => d.style.maskImage && d.style.maxHeight).length",
      );
      // 点开之后应当不再限高
      await p.clickSelector('[data-testid=collapse-toggle]');
      await p.wait(300);
      const maskedAfter = await p.eval<number>(
        "[...document.querySelectorAll('[data-testid=collapse-body]')].filter((d) => d.style.maskImage && d.style.maxHeight).length",
      );
      return [
        { name: '出现「展开」按钮', ok: toggle === 1, detail: '数量=' + toggle },
        { name: '超长内容被折叠（渐隐+限高）', ok: masked === 1, detail: '折叠块=' + masked },
        { name: '点「展开」后不再限高', ok: maskedAfter === 0, detail: '折叠块=' + maskedAfter },
      ];
    },
  },
  {
    name: 'dropdown-ring',
    url: '?page=07-user-render',
    run: async (p) => {
      const clicked = await p.clickSelector('[data-testid=dropdown-trigger]');
      await p.wait(600);
      const expanded = await p.attr('[data-testid=dropdown-trigger]', 'aria-expanded');
      // 最强断言：浮层里出现**我们自己的内容节点**（有内容、且挂在浮层里）
      const content = await p.count('[data-testid=dropdown-content]');
      return [
        { name: '点触发元素能展开（aria-expanded=true）', ok: clicked && expanded === 'true', detail: 'aria-expanded=' + expanded },
        { name: '浮层里渲染出我们的内容节点', ok: content === 1, detail: '内容节点=' + content },
      ];
    },
  },
  {
    name: 'toolbar',
    url: '?page=09-rich',
    run: async (p) => {
      const cases: Array<[string, string, boolean]> = [
        ['bold', 'strong', true],
        ['italic', 'em', true],
        ['code', 'code', true],
        ['quote', 'blockquote', false],
        ['list', 'ul', false],
        ['link', 'a[href]', true],
      ];
      const out = [];
      for (const [key, selector, needSelection] of cases) {
        await p.focus(ED);
        await p.selectAll();
        await p.press('Backspace', 'Backspace', 8);
        await p.wait(120);
        await p.focus(ED);
        await p.type('测试文字');
        await p.wait(120);
        if (needSelection) await p.selectAll();
        const clicked = await p.clickSelector(`[data-testid=toolbar-${key}]`);
        await p.wait(300);
        const found = await p.count(ED + ' ' + selector);
        out.push({ name: key + ' → ' + selector, ok: clicked && found > 0, detail: clicked ? '命中=' + found : '按钮不存在' });
      }
      return out;
    },
  },
  {
    name: 'max-length',
    url: '?page=09-rich',
    run: async (p) => {
      await p.focus(ED);
      for (let i = 0; i < 5; i++) await p.type('a'.repeat(4001));
      await p.wait(1500);
      const len = await p.eval<number>(`(document.querySelector(${JSON.stringify(ED)}).textContent ?? '').length`);
      return [{ name: '超限输入被截到 20000', ok: len === 20000, detail: '实际=' + len }];
    },
  },
];

const server = spawn('node', ['scripts/serve-preview.ts', 'preview-dist', String(PORT)], { stdio: 'ignore' });
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE); if (r.ok) break; } catch { await sleep(250); }
  }
  const failed = await runChecks(checks, { base: BASE, shotDir: '..\\shots\\devroom' });
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  server.kill();
}
