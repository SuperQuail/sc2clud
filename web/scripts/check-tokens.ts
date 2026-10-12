import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 门禁：业务代码里不许写死颜色（#rrggbb / rgb() / rgba()），颜色只能来自令牌。
// 例外：DevRoom（它就是在对比候选配色）与设计语言 B 的配色定义处（src/ui/vivid）。
// 选中的那套配色必须回写成令牌，这条靠评审，门禁只能保证不扩散。
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const ALLOW = ['devroom', 'vivid'];
const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\s*\(/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const hits: Array<{ file: string; line: number; text: string }> = [];
for (const full of walk(SRC)) {
  if (!/\.tsx?$/.test(full) || /\.test\./.test(full)) continue;
  const rel = relative(SRC, full).split(sep).join('/');
  if (ALLOW.some((p) => rel.startsWith(p + '/'))) continue;
  readFileSync(full, 'utf8').split('\n').forEach((text, i) => {
    if (LITERAL.test(text)) hits.push({ file: rel, line: i + 1, text: text.trim().slice(0, 80) });
  });
}

if (hits.length > 0) {
  console.error('='.repeat(74));
  console.error('告警：写死了颜色（' + hits.length + ' 处）——颜色只能来自令牌');
  console.error('令牌在 src/styles/tokens.css（别名层，指向 Ring UI 的主题）。');
  console.error('要新颜色：先加变量，再用 bg-[var(--x)] / text-[var(--x)]。');
  console.error('');
  for (const h of hits) console.error('  web/src/' + h.file + ':' + h.line + '  ' + h.text);
  console.error('='.repeat(74));
  process.exit(1);
}
console.log('令牌检查通过：没有写死的颜色');
