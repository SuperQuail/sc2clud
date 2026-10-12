// 开发侧安全门禁：**离线可跑**，所以能进 `pnpm check`。
// 查的都是「一旦漏了就很久不会被发现」的项：
//   ① 产物里不许有 sourcemap（源码结构不该发到线上）；
//   ② 仓库不许跟踪密钥/环境文件（.gitignore 被改坏时能被抓住）；
//   ③ 产品代码里不许有**未受控的调试开关**（?demo= / ?panel= 这类会随构建上线）。
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const WEB = process.cwd();
const problems: string[] = [];

// ① sourcemap
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const maps = existsSync(join(WEB, 'dist')) ? walk(join(WEB, 'dist')).filter((f) => f.endsWith('.map')) : [];
if (maps.length > 0) problems.push('产物里有 ' + maps.length + ' 个 .map（sourcemap 不该上线）；在 vite 配置里关掉 build.sourcemap');

// ② 密钥 / 环境文件
const tracked = execSync('git ls-files secrets .env .env.local', { cwd: WEB, encoding: 'utf8' }).trim();
if (tracked !== '') problems.push('git 跟踪了不该提交的文件：' + tracked.split('\n').slice(0, 3).join(', '));

// ③ 产品代码里的调试开关：读 URL 参数必须挂在 import.meta.env.DEV 上
const PROD_DIRS = ['src/ui', 'src/lib', 'src/features', 'src/routes', 'src/app'];
for (const dir of PROD_DIRS) {
  for (const file of walk(join(WEB, dir))) {
    if (!/\.tsx?$/.test(file)) continue;
    const src = readFileSync(file, 'utf8');
    // 只看**读页面 URL** 的用法：`new URLSearchParams()` 常用来构造请求查询串，那不是调试开关。
    // （这条规则第一版把 client.ts 的构造用法误报成开关——检查自己也会错，规则要收窄。）
    const reads = src
      .split('\n')
      .filter((l) => /URLSearchParams\(\s*(window\.)?location/.test(l));
    if (reads.length === 0) continue;
    const gated = reads.every((l) => l.includes('import.meta.env.DEV'));
    if (!gated) problems.push('产品代码里有未受控的 URL 参数开关：' + file.replace(WEB + '\\', '') + '（应限定在 import.meta.env.DEV）');
  }
}

if (problems.length > 0) {
  console.error('安全门禁失败（' + problems.length + ' 条）：');
  for (const p of problems) console.error('  ✗ ' + p);
  process.exit(1);
}
console.log('开发侧安全门禁通过：无 sourcemap 上线、无密钥入库、无未受控调试开关');
