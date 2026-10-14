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
  // ---- 12 · 帖子内容页（房间与真站共用同一份版式：这些断言就是那一屏的验收）----
  {
    name: 'topic-12-layout',
    url: '?page=12-topic',
    run: async (p) => {
      const tabs = await p.count('[data-testid=topic-tabs] button');
      const current = await p.count('[data-testid=topic-tabs] [aria-current=page]');
      const left = await p.box("[aria-label='分区与分区内导航']");
      const main = await p.box('[data-testid=topic-main]');
      const rail = await p.box('[data-testid=topic-rail]');
      const railKids = await p.eval<number>("document.querySelector('[data-testid=topic-rail]')?.children.length ?? -1");
      const leftHeads = await p.eval<number>(
        "document.querySelectorAll(\"[aria-label='分区与分区内导航'] h2\").length",
      );
      const leftBoards = await p.eval<number>(
        "document.querySelectorAll(\"[aria-label='分区与分区内导航'] section:first-child a\").length",
      );
      const leftNav = await p.eval<number>(
        "document.querySelectorAll(\"[aria-label='分区与分区内导航'] section:last-child button\").length",
      );
      const h1 = await p.text('[data-testid=topic-main] h1');
      const total = await p.text('[data-testid=comment-total]');
      const sourceLinks = await p.count('[data-testid=topic-main] a[href*=sources]');
      const blockedTiles = await p.eval<number>(
        "[...document.querySelectorAll('[aria-disabled=true]')].filter((e) => e.closest('[data-testid=topic-main]')).length",
      );
      const railNudge = await p.count('[data-testid=issue-nudge-rail]');
      const inlineNudge = await p.count('[data-testid=issue-nudge-inline]');
      return [
        { name: '两个大页签，当前态只有一个（aria-current）', ok: tabs === 2 && current === 1, detail: tabs + ' 个 / current=' + current },
        {
          name: '三栏并排：左栏 200 / 中栏 / 右栏 248，从左到右',
          ok: !!left && !!main && !!rail && left.x < main.x && main.x < rail.x,
          detail: [left?.x, main?.x, rail?.x].map((n) => Math.round(n ?? -1)).join(' → '),
        },
        {
          name: '左栏 = 分区列表 + 分区内导航（原来真站只有分区列表）',
          ok: leftHeads === 2 && leftBoards === 5 && leftNav === 5,
          detail: '标题' + leftHeads + ' / 分区' + leftBoards + ' / 筛选' + leftNav,
        },
        { name: '中栏有全文标题与评论数', ok: !!h1 && h1.length > 0 && total === '128', detail: '评论=' + total },
        {
          name: '下载来源：房间里不可导航（3 个转链端点）',
          ok: sourceLinks === 0 && blockedTiles === 3,
          detail: '可点=' + sourceLinks + ' 已标不可点=' + blockedTiles,
        },
        {
          name: '右栏四件齐 + 正文末尾也有反馈入口',
          ok: railKids === 4 && railNudge === 1 && inlineNudge === 1,
          detail: '右栏' + railKids + ' / 入口' + railNudge + '+' + inlineNudge,
        },
      ];
    },
  },
  {
    name: 'topic-12-report',
    url: '?page=12-topic',
    run: async (p) => {
      const before = await p.attr('[data-testid=topic-report]', 'aria-label');
      await p.clickSelector('[data-testid=topic-report]');
      await p.wait(400);
      const opened = await p.count('[role=dialog]');
      const reasons = await p.count('[role=dialog] input[type=radio]');
      // 不选事由就提交：必须被挡住（管理员按事由分类，空事由进队列没法处理）
      await p.clickSelector('[data-testid=report-submit]');
      await p.wait(300);
      const alerted = await p.count('[role=dialog] [role=alert]');
      const stillOpen = await p.count('[role=dialog]');
      // 选一条事由（Radio 的 input 是视觉隐藏的，坐标点击不可靠）再提交
      await p.eval("document.querySelectorAll('[role=dialog] input[type=radio]')[0].click()");
      await p.wait(150);
      await p.clickSelector('[data-testid=report-submit]');
      await p.wait(500);
      const after = await p.attr('[data-testid=topic-report]', 'aria-label');
      const closed = await p.count('[role=dialog]');
      const receipt = await p.eval<string | null>(
        "document.querySelector('[data-testid=design-action-note]')?.textContent ?? null",
      );
      return [
        { name: '点举报弹出弹层，事由 5 条单选', ok: opened === 1 && reasons === 5, detail: '弹层' + opened + ' / 事由' + reasons },
        { name: '不选事由提交被挡住（有提示且弹层不关）', ok: alerted === 1 && stillOpen === 1, detail: '提示=' + alerted },
        { name: '提交后按钮变「已举报」且弹层关闭', ok: !!before && !!after && before !== after && closed === 0, detail: before + ' → ' + after },
        { name: '回执落在动作条下面（不是静默）', ok: !!receipt && receipt.length > 0, detail: (receipt ?? '').slice(0, 26) },
      ];
    },
  },
  {
    name: 'topic-12-edit',
    url: '?page=12-topic',
    run: async (p) => {
      await p.clickSelector('[data-testid=topic-edit]');
      await p.wait(400);
      const opened = await p.count('[role=dialog]');
      const idleDisabled = await p.attr('[data-testid=edit-save]', 'disabled');
      await p.focus('[role=dialog] input');
      await p.selectAll();
      await p.type('改过的标题');
      await p.wait(300);
      const dirtyDisabled = await p.attr('[data-testid=edit-save]', 'disabled');
      const clicked = await p.clickSelector('[data-testid=edit-save]');
      await p.wait(500);
      const h1 = await p.text('[data-testid=topic-main] h1');
      const meta = await p.text('[data-testid=topic-main] p');
      const closed = await p.count('[role=dialog]');
      return [
        { name: '编辑弹层打开，没改动时「保存」是禁用的', ok: opened === 1 && idleDisabled !== null, detail: '弹层' + opened },
        {
          name: '改完保存：标题与「最后编辑」就地变，弹层关闭',
          ok: clicked && dirtyDisabled === null && h1 === '改过的标题' && (meta ?? '').includes('刚刚') && closed === 0,
          detail: 'h1=' + (h1 ?? '') + ' / meta=' + (meta ?? '').slice(0, 30),
        },
      ];
    },
  },
  {
    name: 'topic-12-review',
    url: '?page=12-topic&review=rejected',
    run: async (p) => {
      const rejected = await p.count("[data-testid=review-banner][data-state=rejected]");
      const resubmit = await p.count('[data-testid=topic-resubmit]');
      const reason = await p.eval<number>("document.querySelectorAll('[data-testid=review-banner] p').length");
      const hint = await p.count('[data-testid=author-only-hint]');
      await p.clickSelector('[data-testid=topic-resubmit]');
      await p.wait(300);
      const pending = await p.count("[data-testid=review-banner][data-state=pending]");
      const gone = await p.count('[data-testid=topic-resubmit]');
      return [
        {
          name: '未通过：横幅带审核理由 + 「重新提交审核」+ 只有作者可见的说明',
          ok: rejected === 1 && resubmit === 1 && reason >= 1 && hint === 1,
          detail: '理由段=' + reason,
        },
        { name: '点「重新提交审核」真的回到审核中（按钮消失）', ok: pending === 1 && gone === 0, detail: 'pending=' + pending },
      ];
    },
  },
  {
    name: 'topic-12-comments',
    url: '?page=12-topic',
    run: async (p) => {
      const before = await p.text('[data-testid=comment-total]');
      await p.focus('[contenteditable=true]');
      await p.type('自动化断言发的回复');
      await p.wait(300);
      await p.clickSelector('[data-testid=reply-publish]');
      await p.wait(500);
      const after = await p.text('[data-testid=comment-total]');
      // 只在**评论楼层**（article）里找这句话：发布后输入框里还留着刚打完的字，不能拿整页文本当证据
      const rows = "document.querySelectorAll('article')";
      const countRows = (s: string) =>
        p.eval<number>("[..." + rows + "].filter((a) => a.textContent.includes('" + s + "')).length");
      const visible = (await countRows('自动化断言发的回复')) > 0;
      // 删掉刚发的那条（只有自己的回复才给删除入口）
      const deletable = await p.count('[data-testid=comment-delete]');
      await p.clickSelector('[data-testid=comment-delete]');
      await p.wait(400);
      const back = await p.text('[data-testid=comment-total]');
      const goneText = (await countRows('自动化断言发的回复')) === 0;
      return [
        {
          name: '发布：列表里真的多一条，评论数 +1',
          ok: before === '128' && after === '129' && visible,
          detail: before + ' → ' + after,
        },
        { name: '删除自己的回复：计数 -1 且正文消失', ok: deletable > 0 && back === '128' && goneText, detail: back ?? '无' },
      ];
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
