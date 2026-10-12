import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 告警：src/ui/ 之外不允许手写 HTML 控件（见 完全重构/开发必读.md §1）
const SRC: string = fileURLToPath(new URL('../src', import.meta.url));
const FORBIDDEN = ['button', 'input', 'select', 'textarea', 'table', 'dialog'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

type Hit = { file: string; line: number; el: string; text: string };
const hits: Hit[] = [];
for (const full of walk(SRC)) {
  if (!full.endsWith('.tsx')) continue;
  const rel = relative(SRC, full).split(sep).join('/');
  if (rel.startsWith('ui/')) continue; // src/ui 是封装控件的地方，允许
  // 先把注释抹成空格（保留行号）：否则「说明不要手写 <button>」的注释会被误报
  const src = readFileSync(full, 'utf8')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  src.split('\n').forEach((text, i) => {
    for (const el of FORBIDDEN) {
      if (new RegExp('<' + el + '(\\s|>|/|$)').test(text)) {
        hits.push({ file: rel, line: i + 1, el, text: text.trim().slice(0, 72) });
      }
    }
  });
}

if (hits.length > 0) {
  const bar = '='.repeat(74);
  console.error(bar);
  console.error('告警：手写了本该由控件库提供的 HTML 控件（' + hits.length + ' 处）');
  console.error(bar);
  console.error('规则：src/ui/ 之外不允许直接写 <button>/<input>/<select>/<textarea>/<table>/<dialog>。');
  console.error('要新控件？先在 web/src/ui/ 里做一次封装（写清 props 与可访问性），再从那里复用。');
  console.error('首选 Ring UI：@jetbrains/ring-ui-built/components/<name>/<name>。');
  console.error('见 完全重构/开发必读.md §1 与 §2。');
  console.error('');
  for (const h of hits) {
    console.error('  web/src/' + h.file + ':' + h.line + '  <' + h.el + '>  ' + h.text);
  }
  console.error(bar);
  process.exit(1);
}
console.log('控件用法检查通过：没有手写 HTML 控件');
