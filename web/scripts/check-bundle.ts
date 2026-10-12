import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 门禁：校验**构建产物自洽**。跑在打包/部署之前，任何一条不成立就中止。
// 起因：今天三次同类事故，形状完全一样——「命令跑完了，但该做的事没做」：
//   ① pnpm check 里的 build 清空 dist，抹掉手工塞进去的 devroom → /dev/devroom/ 变 404；
//   ② 打包时跳过了前端构建 → 部署的是旧 devroom，新页看不见；
//   ③ 新加的页面没进产物 → 页面上根本没有这个入口。
// 这三件事**没有一件会被 typecheck/lint/单测发现**，只能靠断言。所以把它做成门禁。
const WEB = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(WEB, 'dist');
const PUBLIC = join(WEB, 'public');

const problems: string[] = [];
const note = (ok: boolean, msg: string) => {
  if (!ok) problems.push(msg);
};

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

// 1) 两个入口都得在产物里
note(existsSync(join(DIST, 'index.html')), 'dist/index.html 不存在（产品入口没构建）');
note(existsSync(join(DIST, 'devroom', 'index.html')), 'dist/devroom/index.html 不存在（DevRoom 没塞进产物）');

// 2) devroom 里注册的每个页面都要出现在产物 JS 里（新增页忘了构建就会在这里被抓住）
const appSrc = readFileSync(join(WEB, 'src', 'devroom', 'app.tsx'), 'utf8');
const pageKeys = [...appSrc.matchAll(/'([0-9]{2}-[a-z0-9-]+)':\s*\{/g)].map((m) => m[1]!);
note(pageKeys.length > 0, '从 app.tsx 里没解析出任何页面 key（注册写法变了？）');
const devJs = walk(join(DIST, 'devroom', 'assets')).filter((f) => f.endsWith('.js'));
const devBundle = devJs.map((f) => readFileSync(f, 'utf8')).join('\n');
for (const key of pageKeys) {
  note(devBundle.includes(key), 'DevRoom 页面 ' + key + ' 不在产物里（构建顺序错了或忘了 build）');
}

// 3) public/ 下的静态资源必须原样进产物（图片丢一张就是页面上一个裂图）
const artRoot = join(PUBLIC, 'art');
const artFiles = walk(artRoot);
for (const f of artFiles) {
  const rel = relative(artRoot, f).split(sep).join('/');
  note(existsSync(join(DIST, 'art', rel)), '产物缺资源: dist/art/' + rel);
  if (existsSync(join(DIST, 'devroom', 'index.html'))) {
    note(existsSync(join(DIST, 'devroom', 'art', rel)), 'DevRoom 产物缺资源: dist/devroom/art/' + rel);
  }
}

if (problems.length > 0) {
  console.error('='.repeat(74));
  console.error('门禁失败：构建产物不自洽（' + problems.length + ' 条）');
  console.error('='.repeat(74));
  for (const p of problems) console.error('  ✗ ' + p);
  console.error('');
  console.error('修法：跑 node scripts/pack-dev.ts <sha>（它会按正确顺序重建并自检），不要在裸 dist 上打包。');
  console.error('='.repeat(74));
  process.exit(1);
}
console.log('产物自洽检查通过：入口齐、' + pageKeys.length + ' 个 DevRoom 页面在产物里、' + artFiles.length + ' 个资源都在');
