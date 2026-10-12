// 浏览器断言总入口：`pnpm e2e`（会先构建预览产物，再起静态服务，再跑全部检查）。
// 断言一律查 DOM 结构（存在性/数量/文本/属性/计算样式），**不匹配 HTML 源码**。
import { spawn } from 'node:child_process';
import { runChecks, type Check } from './e2e/harness.ts';

const PORT = 5271;
const BASE = 'http://127.0.0.1:' + PORT + '/devroom.html';
const editor = "[contenteditable=true]";

const checks: Check[] = [
  {
    name: '提及：@ 弹菜单',
    url: '?page=09-rich&demo=mention',
    run: async (p) => {
      const menu = await p.count('[data-mention-menu]');
      const box = await p.box('[data-mention-menu]');
      const ed = await p.box(editor);
      return [
        { name: '@ 后出现候选菜单', ok: menu === 1, detail: '菜单数=' + menu },
        { name: '菜单贴在编辑区内', ok: !!box && !!ed && box.x >= ed.x - 8 && box.x <= ed.right, detail: box ? 'left=' + Math.round(box.x) : '无菜单' },
      ];
    },
  },
  {
    name: '提及：整块删除',
    url: '?page=09-rich&demo=mention',
    run: async (p) => {
      await p.press('Enter', 'Enter', 13);
      await p.wait(400);
      const chip = await p.count('.mention-chip');
      const userId = await p.attr('.mention-chip', 'data-mention');
      await p.clickSelector(editor);
      await p.press('Backspace', 'Backspace', 8);
      await p.wait(300);
      const after = await p.count('.mention-chip');
      return [
        { name: '选中后生成提及节点（带 user_id）', ok: chip === 1 && !!userId, detail: 'user_id=' + userId },
        { name: '一个退格删掉整块', ok: after === 0, detail: '剩余=' + after },
      ];
    },
  },
  {
    name: '提及：颜色来自令牌',
    url: '?page=08-comments',
    run: async (p) => {
      const link = await p.count('a[data-mention]');
      const color = await p.style('a[data-mention]', 'color');
      // 令牌是 #4cc2ff，浏览器算出来是 rgb(76,194,255)——**同一个颜色的两种写法**，
      // 所以两边都过一遍浏览器归一化再比（不能直接比字符串，这是第二次栽在这上面）。
      const tokenNormalized = await p.eval<string | null>(
        "(() => { const t = getComputedStyle(document.documentElement).getPropertyValue('--mention-color').trim(); if (!t) return null; const probe = document.createElement('span'); probe.style.color = t; document.body.appendChild(probe); const c = getComputedStyle(probe).color; probe.remove(); return c; })()",
      );
      return [
        { name: '正文里的提及是链接', ok: link > 0, detail: '数量=' + link },
        { name: '颜色等于令牌值', ok: !!color && color === tokenNormalized, detail: color + ' / 令牌=' + tokenNormalized },
      ];
    },
  },
  {
    name: '图片计数器跟着正文变',
    url: '?page=09-rich&demo=image',
    run: async (p) => {
      const counter = () =>
        p.eval<string | null>(
          "(() => { const el = [...document.querySelectorAll('span')].find((s) => /^\\d+ \\/ 10/.test((s.textContent ?? '').trim())); return el ? el.textContent.trim() : null; })()",
        );
      const before = await counter();
      const imgs = await p.count(editor + ' img');
      await p.clickSelector(editor);
      await p.selectAll();
      await p.press('Backspace', 'Backspace', 8);
      await p.wait(400);
      const after = await counter();
      return [
        { name: '插入图片后计数为 1', ok: !!before && before.startsWith('1 /') && imgs === 1, detail: before ?? '无' },
        { name: '删掉图片后计数回到 0', ok: !!after && after.startsWith('0 /'), detail: after ?? '无' },
      ];
    },
  },
  {
    name: '长评论折叠',
    url: '?page=08-comments',
    run: async (p) => {
      const btn = await p.count('button');
      const expanded = await p.eval<boolean>(
        "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '展开')",
      );
      const masked = await p.eval<number>(
        "[...document.querySelectorAll('div')].filter((d) => d.style.maskImage && d.style.maxHeight).length",
      );
      return [
        { name: '出现「展开」按钮', ok: expanded, detail: '按钮总数=' + btn },
        { name: '被折叠的内容块存在（渐隐+限高）', ok: masked > 0, detail: '块数=' + masked },
      ];
    },
  },
  {
    name: 'Dropdown 浮层（Ring）',
    url: '?page=07-user-render',
    run: async (p) => {
      const clicked = await p.clickByText('管理员');
      await p.wait(600);
      const expanded = await p.eval<boolean>(
        "[...document.querySelectorAll('button')].some((b) => (b.textContent ?? '').includes('管理员') && b.getAttribute('aria-expanded') === 'true')",
      );
      const content = await p.eval<boolean>("document.body.innerText.includes('基线角色')");
      return [
        { name: '点徽标能展开（aria-expanded=true）', ok: clicked && expanded },
        { name: '浮层里渲染出我们的内容', ok: content },
      ];
    },
  },
  {
    name: '工具栏每个按钮都有效',
    url: '?page=09-rich',
    run: async (p) => {
      // 断言改查 DOM 结构：元素一带 class，字符串匹配就会误报（已经踩过两次）
      const cases: Array<[string, string, boolean]> = [
        ['粗体', 'strong', true],
        ['斜体', 'em', true],
        ['行内代码', 'code', true],
        ['引用', 'blockquote', false],
        ['无序列表', 'ul', false],
        ['链接', 'a[href]', true],
      ];
      const out = [];
      for (const [label, selector, needSelection] of cases) {
        await p.clickSelector(editor);
        await p.selectAll();
        await p.press('Backspace', 'Backspace', 8);
        await p.wait(150);
        await p.clickSelector(editor);
        await p.type('测试文字');
        await p.wait(150);
        if (needSelection) await p.selectAll();
        const clicked = await p.clickSelector(`button[aria-label="${label}"]`);
        await p.wait(300);
        const found = await p.count(editor + ' ' + selector);
        out.push({ name: label + ' → ' + selector, ok: clicked && found > 0, detail: clicked ? '命中=' + found : '按钮不存在' });
      }
      return out;
    },
  },
  {
    name: '字数上限 20000',
    url: '?page=09-rich',
    run: async (p) => {
      await p.clickSelector(editor);
      for (let i = 0; i < 5; i++) await p.type('a'.repeat(4001));
      await p.wait(1500);
      const len = await p.eval<number>(`(document.querySelector(${JSON.stringify(editor)}).textContent ?? '').length`);
      return [{ name: '超限输入被截到 20000', ok: len === 20000, detail: '实际=' + len }];
    },
  },
];

const server = spawn('node', ['scripts/serve-preview.ts', 'preview-dist', String(PORT)], { stdio: 'ignore' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
try {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE); if (r.ok) break; } catch { await sleep(250); }
  }
  const failed = await runChecks(checks, { base: BASE, shotDir: '..\\shots\\devroom' });
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  server.kill();
}
