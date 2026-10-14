import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 文件体量门禁（前端方案 §9.2）：> 500 行必须登记重构目标，行数只减不增。
// 旧站这条门禁没进 CI，结果 5000 行的文件长期挂账 —— 这次它必须在 CI 里。
const SRC: string = fileURLToPath(new URL('../src', import.meta.url));
const LIMIT = 500;
const PENDING: Record<string, string> = {
  // 2026-10-14：W1 的信息中心（DevRoom 10-messages）。**重构目标**：把「取数 + 通知四档 + 私信面板」
  // 拆成 notice-center（壳 + 导航 + 各档面板）与 dm-panel（会话列表 + 聊天）两个文件；行数只减不增。
  'routes/messages.tsx': '拆成 notice-center / dm-panel 两个文件',
  // 2026-10-14：K3-FIX 给 topic.tsx 补了关注分区 / 成员数 / 角色徽标 / 提及候选 / MarkdownEditor 编辑，
  // 涨到 546 行。**重构目标**：把三块弹层与动作条拆到 routes/topic/ 下，行数只减不增。
  'routes/topic.tsx': '拆出弹层与动作条到 routes/topic/',
  // 2026-10-14：W3/K3-FIX 给 issues.tsx 补了检索/筛选/赞踩/排序，涨到 540 行。
  'routes/issues.tsx': '拆出列表与详情到 routes/issues/',
  // 2026-10-14：K-ADMIN 给后台分区屏补了封面预览/更换/清空与 ACL/版主，涨到 510 行。
  'devroom/pages/15-admin/screens/boards.tsx': '拆出 ACL 矩阵与版主任免面板',
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(SRC).filter((f) => /\.(ts|tsx|css)$/.test(f));
const problems: string[] = [];
let over = 0;

for (const file of files) {
  const rel = relative(SRC, file).split(sep).join('/');
  const lines = readFileSync(file, 'utf8').split('\n').length;
  const registered = Object.prototype.hasOwnProperty.call(PENDING, rel);
  if (lines > LIMIT) {
    over++;
    if (!registered) problems.push(rel + ' 有 ' + lines + ' 行（上限 ' + LIMIT + '），未登记重构目标');
    else console.log('告警 ' + rel + ' ' + lines + ' 行 → ' + PENDING[rel]);
  } else if (registered) {
    problems.push(rel + ' 已降到 ' + lines + ' 行，请从 PENDING 删掉登记');
  }
}

for (const rel of Object.keys(PENDING)) {
  if (!files.some((f) => relative(SRC, f).split(sep).join('/') === rel)) {
    problems.push('PENDING 里的 ' + rel + ' 已不存在，请删掉登记');
  }
}

console.log('检查 ' + files.length + ' 个文件，超限 ' + over + ' 个，登记 ' + Object.keys(PENDING).length + ' 个');
if (problems.length > 0) {
  for (const p of problems) console.error('失败：' + p);
  process.exit(1);
}
console.log('文件体量门禁通过');
