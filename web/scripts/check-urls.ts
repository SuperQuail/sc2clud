import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 门禁：路径只能由 src/lib/url.ts 构造，组件里不许出现写死的绝对路径或 'art/' 前缀。
// 理由：同一份产物跑在 / 与 /dev/ 两个前缀下，散落的路径必然有一处坏掉（踩过两次）。
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const OWNER = 'lib/url.ts';
const RULES: Array<[RegExp, string]> = [
  [/(href|src)=['"]\//, '写死的绝对路径（用 appPath() / assetUrl()）'],
  [/'art\//, "写死的资源前缀（用 assetUrl()）"],
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const hits: Array<{ file: string; line: number; why: string; text: string }> = [];
for (const full of walk(SRC)) {
  if (!/\.tsx?$/.test(full) || /\.test\./.test(full)) continue;
  const rel = relative(SRC, full).split(sep).join('/');
  if (rel === OWNER) continue;
  readFileSync(full, 'utf8').split('\n').forEach((text, i) => {
    for (const [re, why] of RULES) {
      if (re.test(text)) hits.push({ file: rel, line: i + 1, why, text: text.trim().slice(0, 72) });
    }
  });
}

if (hits.length > 0) {
  console.error('='.repeat(74));
  console.error('告警：路径写死在组件里（' + hits.length + ' 处）');
  console.error('统一入口：src/lib/url.ts 的 appPath(path) / assetUrl(file)');
  console.error('');
  for (const h of hits) console.error('  web/src/' + h.file + ':' + h.line + '  ' + h.why + '  ' + h.text);
  console.error('='.repeat(74));
  process.exit(1);
}
console.log('URL 检查通过：路径都走统一入口');
