import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// 出预览图：node scripts/shoot-previews.ts a1='s=a&v=1&theme=light' ...
// 每个条目出两张：*-900.png（验「一屏 ≥4 卡片」这类可视区指标）与 *.png（整页）
// 用本机 Chrome/Edge，不需要 Playwright。产物落在仓库外层的 shots/preview/（已 gitignore）。
const OUT = process.env.SHOT_OUT ?? join(process.cwd(), '..', 'shots', 'preview');
const BASE = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5199/preview.html';
const CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const items = process.argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  return { name: a.slice(0, i), query: a.slice(i + 1) };
});
if (items.length === 0) {
  console.error('用法: node scripts/shoot-previews.ts <名字>=<query> [...]');
  process.exit(2);
}

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error('找不到 Chrome/Edge；装一个或设 SHOT_BROWSER');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

let failed = 0;
for (const { name, query } of items) {
  for (const [suffix, size] of [['-900', '1440,900'], ['', '1440,2600']] as const) {
    const out = join(OUT, name + suffix + '.png');
    const args = [
      '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
      '--force-device-scale-factor=1', '--window-size=' + size, '--virtual-time-budget=6000',
      '--user-data-dir=' + join(process.env.TEMP ?? '/tmp', 'sc2clud-shot'),
      '--screenshot=' + out, BASE + '?' + query,
    ];
    const r = spawnSync(browser, args, { stdio: 'ignore' });
    if (r.status === 0 && existsSync(out)) console.log('OK   ' + name + suffix + '.png');
    else { failed++; console.error('FAIL ' + name + suffix); }
  }
}
console.log('输出目录: ' + OUT);
process.exit(failed > 0 ? 1 : 0);
