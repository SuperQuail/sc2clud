// 手写原生控件清点（src/ui）。业务代码由 gate:ui 挡死，src/ui 是允许写原生元素的例外——
// 所以例外必须**有理由**：没写理由的条目会让脚本非 0 退出，避免清单烂掉。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = 'src/ui';
const LAYOUT = new Set(['div', 'span', 'p', 'ul', 'li', 'img', 'a', 'pre', 'code', 'br', 'label', 'article', 'section', 'header']);
const CONTROL = /<(button|input|textarea|select|option|table|thead|tbody|tr|td|th|dialog)\b/g;

const REASONS: Record<string, string> = {
  'comment/mention-menu.tsx <button>': '菜单行：Lexical typeahead 需要该行 DOM 元素（滚进视野），Ring Button 不外传 DOM ref',
  'dropdown-panel.tsx <button>': '触发器外壳（点击目标）与菜单行，同样需要 DOM ref',
  'rich/image-uploader.tsx <input>': '隐藏的文件选择：浏览器只允许原生 input[type=file]（触发按钮是 Ring Button）',
  'vivid/button.tsx <button>': 'B 系自研控件本体',
  'vivid/input.tsx <input>': 'B 系自研控件本体',
  'vivid/switch.tsx <button>': 'B 系自研控件本体（role=switch）',
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.tsx?$/.test(p) ? [p] : [];
  });
}

let missing = 0;
console.log('src/ui 里直接写的原生控件（每条都应有理由）：');
for (const p of walk(ROOT).sort()) {
  const src = readFileSync(p, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const tags = new Map<string, number>();
  for (const m of src.matchAll(CONTROL)) {
    if (LAYOUT.has(m[1]!)) continue;
    tags.set(m[1]!, (tags.get(m[1]!) ?? 0) + 1);
  }
  for (const [tag, count] of tags) {
    const key = relative(ROOT, p).replace(/\\/g, '/') + ' <' + tag + '>';
    const reason = REASONS[key];
    if (!reason) missing++;
    console.log('  ' + (reason ? '✓' : '✗') + ' ' + key + ' ×' + count + (reason ? '　' + reason : '　【没有理由】'));
  }
}
if (missing > 0) {
  console.error('\n有 ' + missing + ' 条没写理由');
  process.exit(1);
}
console.log('\n全部有理由');
