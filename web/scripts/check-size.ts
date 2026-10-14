import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 文件体量门禁（前端方案 §9.2）：> 500 行必须登记重构目标，行数只减不增。
// 旧站这条门禁没进 CI，结果 5000 行的文件长期挂账 —— 这次它必须在 CI 里。
const SRC: string = fileURLToPath(new URL('../src', import.meta.url));
const LIMIT = 500;
const PENDING: Record<string, string> = {
  // 2026-10-14 FIX-TOPIC 收口：routes/messages.tsx 的重构**已经做完**（FIX-MSG 的 D10 把信息中心收成
  // prop 驱动的 notice-center View + 薄宿主，该文件降到 232 行），登记按门禁的规矩撤掉 ——
  // 留着它就是一条「已归还的债还挂在账上」，而 gate:size 会因此常红（谁也不会去修一条假账）。
  // 2026-10-14 FIX-TOPIC：topic.tsx 已从 546 降到 411 行（DTO 映射搬到 routes/_parts/topic-mappers.ts、
  // 版面全部收回 12-topic 的 View）——登记按门禁的规矩撤掉。**这次的形状就是当初那句重构目标**：
  // 宿主只留「取数 + 传参」，映射是纯函数放 _parts，版面一个字都不在这里。
  // 2026-10-14 FIX-TOPIC：issues.tsx 已降到 497 行（DTO 映射搬到 routes/_parts/issues-mappers.ts、
  // 表单搬进 13-issue/new-issue-panel.tsx、列表/详情留在页面里）——登记按门禁的规矩撤掉。
  // 2026-10-14：K-ADMIN 给后台分区屏补了封面预览/更换/清空与 ACL/版主，涨到 510 行。
  'devroom/pages/15-admin/screens/boards.tsx': '拆出 ACL 矩阵与版主任免面板',
  // 2026-10-14：Lead 补 D19（作者关注）那条宿主断言后越过 500 行。**门禁也扫测试文件**（`src/**` 里所有 .ts/.tsx），
  // 所以测试长了同样要登记 —— 重构目标：把「作者关注 / 审核横幅 / 提及候选」三组各自拆成独立文件。
  'routes/topic.test.tsx': '拆出作者关注、审核横幅、提及候选三组用例',
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
