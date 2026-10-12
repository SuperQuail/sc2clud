import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

// 产物体积门禁（前端方案 §9.1）：口径只有 gzip 后一个，超限即失败。
const DIST: string = fileURLToPath(new URL('../dist', import.meta.url));
// Ring UI 是核心控件库，它的聚合样式表本身就有 ~30 KB gzip（实测 206.86 kB raw / 30.78 kB gzip），
// CSS 预算按「Ring UI 基线 + 我们自己的样式」定，不是给纯 Tailwind 定的那个数。
const LIMITS = { firstScreenJs: 150 * 1024, routeChunkJs: 60 * 1024, css: 40 * 1024 };

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
const failures: string[] = [];

for (const name of assets) {
  const size = gz(name);
  if (firstScreen.has(name)) {
    if (name.endsWith('.js')) firstScreenJs += size;
    else if (name.endsWith('.css')) css += size;
  } else if (name.endsWith('.js')) {
    routeChunkJs = Math.max(routeChunkJs, size);
  }
}

console.log('首屏 JS ' + kb(firstScreenJs) + ' / ' + kb(LIMITS.firstScreenJs));
console.log('首屏 CSS ' + kb(css) + ' / ' + kb(LIMITS.css));
console.log('最大路由 chunk ' + kb(routeChunkJs) + ' / ' + kb(LIMITS.routeChunkJs));

if (firstScreenJs > LIMITS.firstScreenJs) failures.push('首屏 JS 超出预算');
if (firstScreenJs === 0) failures.push('没解析到首屏 JS：index.html 与 assets 的引用关系变了，门禁已失效');
if (css > LIMITS.css) failures.push('首屏 CSS 超出预算');
if (routeChunkJs > LIMITS.routeChunkJs) failures.push('路由 chunk 超出预算');

if (failures.length > 0) {
  for (const f of failures) console.error('失败：' + f);
  process.exit(1);
}
console.log('产物体积门禁通过');
