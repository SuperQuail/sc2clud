import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 门禁：业务代码只能用 src/devroom/registry.ts 里登记过的 Ring UI 控件。
// 没验证过就用的控件，一定会以「错位 / 不生效 / 抛错」的形式在页面上还回来。
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const registryPath = join(SRC, 'devroom', 'registry.ts');

const registry = readFileSync(registryPath, 'utf8');
const verified = new Set(
  [...registry.matchAll(/^\s*name:\s*'([a-z0-9-]+)'/gm)].map((m) => m[1]!),
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const IMPORT = /from\s+'@jetbrains\/ring-ui-built\/components\/([a-z0-9-]+)\//g;
const offenders: Array<{ file: string; match: string }> = [];
for (const full of walk(SRC)) {
  if (!/\.tsx?$/.test(full)) continue;
  const rel = relative(SRC, full).split(sep).join('/');
  if (rel.startsWith('devroom/') || rel.startsWith('ui/')) continue; // 房间本身与控件库允许
  const text = readFileSync(full, 'utf8');
  for (const m of text.matchAll(IMPORT)) {
    const name = m[1]!;
    // global/icon/util 这些是非组件模块（枚举、图标基类、工具），不是控件，不纳入登记要求
    if (['global', 'icon', 'util', 'lib'].includes(name)) continue;
    if (!verified.has(name)) offenders.push({ file: rel, match: name });
  }
}

if (offenders.length > 0) {
  const bar = '='.repeat(74);
  console.error(bar);
  console.error('告警：用了没在开发者房间验证过的 Ring UI 控件（' + offenders.length + ' 处）');
  console.error(bar);
  console.error('规矩：控件必须先在 src/devroom/ 里出一页验证，再登记进 src/devroom/registry.ts。');
  console.error('步骤：1) 在 src/devroom/pages/ 加一页，把该控件的变体/尺寸/图标/禁用态都渲染出来；');
  console.error('      2) 出图看过、确认无错位与告警；3) 在 registry.ts 登记；4) 才能写进业务代码。');
  console.error('');
  for (const o of offenders) console.error('  web/src/' + o.file + '  使用了未登记控件: ' + o.match);
  console.error(bar);
  process.exit(1);
}
console.log('控件登记检查通过：只用了已登记的 ' + verified.size + ' 个控件');
