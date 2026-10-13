import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 开发规范自查 —— **每次跑 pnpm check 都会打印**。
// 为什么要有它：门禁通过时是静默的，而「静默通过」等于没有提醒。
// 这个脚本做两件事：① 把每条规范连同它的检查结果摊开；② 把机器查不了、必须人确认的项列出来。
const WEB = fileURLToPath(new URL('..', import.meta.url));
const REPO = join(WEB, '..');

type Row = { rule: string; how: string; ok: boolean; detail: string };

function gate(script: string): { ok: boolean; detail: string } {
  const r = spawnSync('node', [join(WEB, 'scripts', script)], { cwd: WEB, encoding: 'utf8' });
  const out = ((r.stdout ?? '') + (r.stderr ?? '')).trim().split('\n');
  const last = out[out.length - 1] ?? '';
  return { ok: r.status === 0, detail: last.slice(0, 60) };
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const rows: Row[] = [];
function add(rule: string, how: string, res: { ok: boolean; detail: string }) {
  rows.push({ rule, how, ok: res.ok, detail: res.detail });
}

add('禁止手写 HTML 控件', 'gate:ui', gate('check-ui-usage.ts'));
add('颜色只能来自令牌', 'gate:tokens', gate('check-tokens.ts'));
add('路径只能来自 src/lib/url.ts', 'gate:urls', gate('check-urls.ts'));
add('控件必须先在 DevRoom 验证并登记', 'gate:controls', gate('check-controls.ts'));
add('开发侧安全（无 sourcemap / 无密钥 / 无未受控开关）', 'gate:security', gate('check-security.ts'));
// gate:bundle 检查「dist 里有 DevRoom」，那是打包环节的事：裸 pnpm build 会清空 dist 且不建 DevRoom，
// 在这里跑必然假失败（已因此误判过一次）。它由 pack-dev.ts 在打包前执行。

// ── 文案哨兵：机械查找替换最容易弄坏、而图上看不出来的地方 ──
// 来历（2026-10-13）：把用户可见文案里的「主题」统一改成「帖子」时，
// `src/ui/theme-switcher.tsx` 的 `aria-label='主题：日间'` 是**配色主题**，
// 被一起替换就会变成「帖子：日间」—— 读屏标签与悬停提示坏掉，而**截图上看不出来**。
// 所以用一条特征串兜住它：命中即红。
// 按 缺陷处理总纲 §7.2：这里**打印扫描文件数**，让「0 命中」是可解释的（而不是假绿）。
{
  const SENTINEL = /帖子：(日间|夜间|跟随系统)|帖子切换/;
  const scanned = walk(join(WEB, 'src')).filter((f) => /\.tsx?$/.test(f) && !f.includes('.test.'));
  const broken = scanned.filter((f) => SENTINEL.test(readFileSync(f, 'utf8')));
  rows.push({
    rule: '文案哨兵：配色主题没被当成帖子替换掉',
    how: `扫 ${scanned.length} 个文件`, ok: broken.length === 0,
    detail: broken.length === 0
      ? `命中 0（已扫 ${scanned.length} 个文件）`
      : '命中 ' + broken.map((x) => x.replace(WEB, '')).join('、'),
  });
}

// ── 机器查不了、必须人确认的项 ──
const TODO: string[] = [];

// 1) 自建控件是否都在 DevRoom 里出现过（gate:controls 只管 Ring UI 的控件）
const uiFiles = walk(join(WEB, 'src', 'ui')).filter((f) => f.endsWith('.tsx') && !f.includes('.test.'));
const devSources = walk(join(WEB, 'src', 'devroom')).
  filter((f) => f.endsWith('.tsx')).
  map((f) => readFileSync(f, 'utf8')).
  join('\n');
const ownComponents = new Set<string>();
for (const f of uiFiles) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/export function ([A-Z][A-Za-z0-9]*)/g)) ownComponents.add(m[1]!);
  for (const m of src.matchAll(/export const ([A-Z][A-Za-z0-9]*)\s*[:=]/g)) ownComponents.add(m[1]!);
}
// 显式豁免：必须写明理由，别用「它不重要」蒙过去
// 浏览器断言不在 pnpm check 里跑（要 Chrome + 预览服务），但每次检查都要提醒别忘
const E2E_HINT = 'pnpm e2e —— 本地浏览器断言（12 组，要 Chrome/预览服务，**刻意不进 CI**）：改了交互控件就跑一次';

const EXEMPT: Record<string, string> = {
  DevEntry: '构建期开关控制的开发期入口（VITE_DEVROOM），不面向用户，生产构建里不存在',
};
const unshown = [...ownComponents].filter((n) => !devSources.includes(n) && !(n in EXEMPT));
if (unshown.length > 0) TODO.push('自建控件没在 DevRoom 出现：' + unshown.join('、') + '（规范要求先验证再进业务代码）');

// 2) 出了新 DevRoom 页面但没出图
const pageFiles = walk(join(WEB, 'src', 'devroom', 'pages'));
const newestPage = Math.max(...pageFiles.map((f) => statSync(f).mtimeMs), 0);
const shotDir = join(REPO, 'shots', 'devroom');
const shots = existsSync(shotDir) ? walk(shotDir) : [];
const newestShot = shots.length ? Math.max(...shots.map((f) => statSync(f).mtimeMs)) : 0;
if (newestPage > newestShot) TODO.push('DevRoom 页面比截图新：改了页面就重新出图并看图（' + pageFiles.length + ' 个页面 / ' + shots.length + ' 张图）');

// 3) 依赖有没有变动（规范：不引入新依赖）
const diff = spawnSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).stdout ?? '';
if (diff.includes('package.json')) TODO.push('最近一次提交改了 package.json：确认没有引入新依赖（规范：不引入；要引先说明理由）');

// ── 打印 ──
const bar = '─'.repeat(74);
console.log(bar);
console.log('开发规范自查（每次 pnpm check 都会打印）');
console.log('  · ' + E2E_HINT);
console.log(bar);
for (const r of rows) {
  console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.rule.padEnd(30) + r.how.padEnd(16) + r.detail);
}
console.log(bar);
if (TODO.length === 0) {
  console.log('需要人确认的项：无');
} else {
  console.log('需要人确认的项（机器查不了，别跳过）：');
  for (const t of TODO) console.log('  ! ' + t);
}
console.log(bar);

// 硬门禁失败才算失败；上面的提醒项不影响退出码，但每次都会重新出现
const failed = rows.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error('规范自查失败：' + failed.map((r) => r.how).join(', '));
  process.exit(1);
}
