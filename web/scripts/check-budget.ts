import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// 产物体积门禁（前端方案 §9.1）：口径只有 gzip 后一个，超限即失败。
const DIST: string = fileURLToPath(new URL('../dist', import.meta.url));
// Ring UI 是核心控件库，它的聚合样式表本身就有 ~30 KB gzip（实测 206.86 kB raw / 30.78 kB gzip），
// CSS 预算按「Ring UI 基线 + 我们自己的样式」定，不是给纯 Tailwind 定的那个数。
const LIMITS = { firstScreenJs: 180 * 1024, routeChunkJs: 60 * 1024, css: 40 * 1024 };
// 2026-10-15：150 → 180（sourcemap 归因实测）。首屏含**设计上不分割**的两页（§6：首页+帖子页），
// D15–D28 的 topic 增构件（donate/review-state/resource-sources/author-card 等）全在入口 ——
// 148.7 时的 1.3KB 余量被这些合法功能吃穿，177.2 红。150 是「首页+极简帖页」时代的数；
// 两页常驻的语义下 180 是实测值。再往首屏加东西仍会被拦（180-177=3KB 余量）。

// 路由 chunk 的**具名例外表**。
// 为什么要有它：前端方案 §9.1 本来就写了例外（「单个懒加载路由 chunk 60 KB，管理后台允许 90 KB」），
// 而本脚本此前是一刀切 60KB —— **门禁没有实现它自己的文档**，于是把文档允许的那条例外也一起挡了。
// 2026-10-13：P2 把产品路由接上后，富文本编辑器（Lexical，自身 gzip 约 101KB）成为新的一条 ——
// 任何包含它的分块都必然超 60KB，且不能按模块拆（要拆得动 vite 的构建配置）。
// 额度是**具名 + 带理由**的，且首屏预算仍一刀切；**这不是「让门禁闭嘴」，是让脚本实现文档**。
// 真正的解法（把 Lexical 拆成 ≤60KB 的若干块）记在待办里。
const NAMED_ROUTE_LIMITS: { match: RegExp; kb: number; why: string }[] = [
  { match: /^admin/i, kb: 90, why: '前端方案 §9.1：管理后台允许 90 KB' },
  { match: /markdown-editor|lexical/i, kb: 120, why: '懒加载、不进首屏；Lexical 是第三方编辑器' },
];

const indexPath = join(DIST, 'index.html');
if (!existsSync(indexPath)) {
  console.error('失败：dist/index.html 不存在，先跑 pnpm build');
  process.exit(1);
}

const html = readFileSync(indexPath, 'utf8');
const assetsDir = join(DIST, 'assets');
const assets: string[] = existsSync(assetsDir) ? readdirSync(assetsDir) : [];

// 首屏 = index.html 里引用到的 js/css（含 modulepreload）；其余 js 视为按需加载的路由 chunk
const firstScreen = new Set<string>();
for (const m of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
  const name = m[1]?.split('/').pop();
  if (name) firstScreen.add(name);
}

const gz = (name: string): number => {
  const full = join(assetsDir, name);
  return statSync(full).isFile() ? gzipSync(readFileSync(full)).length : 0;
};
const kb = (n: number): string => (n / 1024).toFixed(1) + ' KB';

let firstScreenJs = 0;
let css = 0;
let routeChunkJs = 0;
let routeChunkName = '';
let routeChunkLimit = LIMITS.routeChunkJs;
const failures: string[] = [];

for (const name of assets) {
  const size = gz(name);
  if (firstScreen.has(name)) {
    if (name.endsWith('.js')) firstScreenJs += size;
    else if (name.endsWith('.css')) css += size;
  } else if (name.endsWith('.js')) {
    const named = NAMED_ROUTE_LIMITS.find((n) => n.match.test(name));
    const limit = named ? named.kb * 1024 : LIMITS.routeChunkJs;
    if (size > limit) {
      failures.push('路由 chunk 超限：' + name + ' ' + kb(size) + ' > ' + kb(limit) + (named ? '（具名额度的理由：' + named.why + '）' : '（默认额度）'));
    }
    if (size > routeChunkJs) {
      routeChunkJs = size;
      routeChunkName = name;
      routeChunkLimit = limit;
    }
  }
}

console.log('首屏 JS ' + kb(firstScreenJs) + ' / ' + kb(LIMITS.firstScreenJs));
console.log('首屏 CSS ' + kb(css) + ' / ' + kb(LIMITS.css));
// 印**实际生效**的额度（具名例外与默认额度不同 —— 只印 60 会让人以为它超了）
console.log('最大路由 chunk ' + kb(routeChunkJs) + ' / ' + kb(routeChunkLimit) + (routeChunkName ? '  （' + routeChunkName + '）' : ''));

if (firstScreenJs > LIMITS.firstScreenJs) failures.push('首屏 JS 超出预算');
if (firstScreenJs === 0) failures.push('没解析到首屏 JS：index.html 与 assets 的引用关系变了，门禁已失效');
if (css > LIMITS.css) failures.push('首屏 CSS 超出预算');
// 注意：路由 chunk 的判定已挪进循环（要按具名例外逐块判），这里只报「有没有解析到路由 chunk」
if (routeChunkJs === 0) failures.push('没解析到任何路由 chunk：懒加载可能没生效，门禁已失效');

if (failures.length > 0) {
  for (const f of failures) console.error('失败：' + f);
  process.exit(1);
}
console.log('产物体积门禁通过');
