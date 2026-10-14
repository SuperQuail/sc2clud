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
//    2026-10-14 W-FI：这里的正则原本匹配 '01-interactive': { 这种**对象字面量**写法，而 app.tsx 早已改成
//    { key: '01-interactive', title, el } 的数组。于是它一直解析出 0 个 key —— 下面那条 length>0 的
//    断言**从来没红过**，逐页存在性检查也一个都没跑（"永远通过的检查"）。改成匹配现在的写法。
const appSrc = readFileSync(join(WEB, 'src', 'devroom', 'app.tsx'), 'utf8');
const pageKeys = [...appSrc.matchAll(/key:\s*'([0-9]{2}-[a-z0-9-]+)'/g)].map((m) => m[1]!);
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

// 4) DevRoom 入口只在 dev 制品里（2026-10-14 W-FI）。F1 实测：不带 VITE_DEVROOM 时产品入口 chunk
//    里 dev-entry 被整块摇掉（换开关会让 chunk 名从 index-BPHrUDIx 变成 index-dd3c5ucU）。
//    所以这条门禁查两件事 —— 判据是**内容**不是文件名（源文件 dev-entry.tsx 在 dist 里叫 assets/index-*.js）：
//      ① 产品侧出现了 DevRoom 链接，就必须有 dist/devroom/ 兜住它（否则线上是死链）；
//      ② 没开开关的生产构建（五个模块一个都没带过这个链接）必须 0 命中。
//    为什么不做「无条件不得出现」：dev 制品**故意**带这个入口（pack-dev.ts 用 VITE_DEVROOM=1 构建），
//    无条件禁用会连它一起判红 —— 为绿而写死的例外，比没有门禁更糟。
//    每一处都配了必须非零的对照：扫描器坏了、路径变了、字符串被拆开时，也要红，而不是打印一个漂亮的 0。
const DEVROOM_MARKERS = ['devroom', '开发页面', '开发者房间'];

// 一处一处地扫：命中时把「文件 + 偏移 + 上下文」带出来，门禁失败要能一眼看出是哪一段，
// 而不是只报一句「有命中」（交接单 §5.3：只报数字的检查会被人当成通过）。
function scanMarkers(files: string[], label: (f: string) => string): { count: number; at: string[] } {
  const out = { count: 0, at: [] as string[] };
  for (const f of files) {
    const txt = readFileSync(f, 'utf8');
    for (const needle of DEVROOM_MARKERS) {
      let i = txt.indexOf(needle);
      while (i >= 0) {
        out.count++;
        out.at.push(
          label(f) + ':' + i + ' 「' + needle + '」 …' +
            txt.slice(Math.max(0, i - 90), i + 120).replace(/\n/g, '\\n') + '…',
        );
        i = txt.indexOf(needle, i + needle.length);
      }
    }
  }
  return out;
}
const scannable = (f: string) => /\.(js|html|css|json|txt|map)$/i.test(f);
const relDist = (f: string) => 'dist/' + relative(DIST, f).split(sep).join('/');
const inProduct = (f: string) => relative(DIST, f).split(sep)[0] !== 'devroom';
const devroomRoot = join(DIST, 'devroom');
const productFiles = walk(DIST).filter((f) => inProduct(f) && scannable(f));
const devroomFiles = existsSync(devroomRoot) ? walk(devroomRoot).filter(scannable) : [];
note(productFiles.length > 0, 'dist/ 的产品侧一个可扫文件都没有（构建没跑？判据路径变了？）');

// 4a) 判据自检：这些字在**源码**里就该有（不成立 = 判据/扫描坏了，后面的「0 命中」不算数）。
//     用源码对照而不是产物，是为了不受「打包器恰好把字符串拆开」影响 —— 对照组只回答「这串字扫不扫得出来」。
const srcDevEntry = readFileSync(join(WEB, 'src', 'ui', 'dev-entry.tsx'), 'utf8');
note(
  DEVROOM_MARKERS.some((m) => srcDevEntry.includes(m)),
  '自检失败：拿 ' + DEVROOM_MARKERS.join('/') + ' 去扫 src/ui/dev-entry.tsx 一个都扫不到（判据失效，4b 的 0 命中不可信）',
);

// 4b) 产品侧扫一遍，两个方向都用它
const productHit = scanMarkers(productFiles, relDist);
const devroomPresent = existsSync(devroomRoot);
// 4b-①：产品侧带了这个链接、却没有 dist/devroom/ 兜住它 = 线上死链。
//        这一条在「开了 VITE_DEVROOM 做生产构建」时就会红 —— 那正是要拦的错。
if (productHit.count > 0 && !devroomPresent) {
  for (const at of productHit.at) {
    problems.push('产品产物指向 DevRoom，但 dist/devroom/ 不存在（线上死链；这次构建开过 VITE_DEVROOM？）' + at);
  }
}
// 4c) 反向对照：DevRoom 自己的产物里必须扫得到 —— 否则 4b-② 的「生产侧 0 命中」可能只是「整个扫描什么都没读到」。
const devHit = devroomPresent ? scanMarkers(devroomFiles, relDist) : { count: 0, at: [] as string[] };
note(!devroomPresent || devHit.count > 0, 'dist/devroom/** 里扫不到任何 DevRoom 标记（扫描器没读到内容？4c 的「0 命中」因此不可信）');

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
console.log(
  '产物自洽检查通过：入口齐、' + pageKeys.length + ' 个 DevRoom 页面在产物里、' + artFiles.length + ' 个资源都在、' +
    (devroomPresent
      ? 'dev 制品：产品侧 DevRoom 入口 ' + productHit.count + ' 处，dist/devroom/** 自己的 ' + devHit.count + ' 处'
      : '生产制品：产品侧 DevRoom 痕迹 0 处'),
);
