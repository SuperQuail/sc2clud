// 文件体量门禁（告警制）：默认 500 行。超限即「耦合风险」，永远出现在告警清单里，
// 没有豁免：清单只记录「还没重构」这件事本身与目标，不代表可以不重构；
// 报错只针对两种情况：① 新文件超限却没登记；② 已登记的文件比上次更长了（棘轮）。
//
// 用法：node scripts/check-size.mjs [--verbose]

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '')
const DEFAULT_LIMIT = 500

// 扫这些目录（只算源码，不算构建产物）
const ROOTS = ['crates', 'web/src', 'crates/sc2clud-web/templates']
const EXT = ['.rs', '.ts', '.tsx', '.html']
const SKIP_DIRS = new Set(['node_modules', 'target', 'islands', 'dist'])

// 规则：登记=「已知的耦合债务 + 重构目标」，不是免死金牌；行数只能减不能增。
const PENDING = {
  // —— 数据层：表结构集中在 models，CRUD 集中在 repo ——
  'crates/sc2clud-db/src/repo.rs': { limit: 5675, reason: '全部表的 CRUD 集中一处（按表拆要动 300+ 调用点）', goal: '拆 repo/{posts,issues,users,admin}.rs' },
  'crates/sc2clud-db/src/models.rs': { limit: 690, reason: '全部表对应的行结构', goal: '按领域拆 models/' },
  'crates/sc2clud-db/src/lib.rs': { limit: 860, reason: '连接/迁移/密钥与迁移内嵌', goal: '拆 db/{conn,migrate,secret}.rs' },
  'crates/sc2clud-db/src/backend_tests.rs': { limit: 790, reason: '仓储的端到端测试（测试文件按功能堆叠是常态）', goal: '按领域拆测试文件' },
  'crates/sc2clud-db/src/community_tests.rs': { limit: 670, reason: '社区域测试', goal: '按领域拆测试文件' },
  // —— Web 层：页面处理器与模板结构 ——
  'crates/sc2clud-web/src/pages_posts.rs': { limit: 2200, reason: '帖子/审核/评论/issue/编辑的处理器集合', goal: '拆 pages_post_edit / pages_issues / pages_comments' },
  'crates/sc2clud-web/src/pages_donations.rs': { limit: 700, reason: '打赏记录与人工验证（新模块，先观察）', goal: '拆页面与仓储调用' },
  'crates/sc2clud-web/src/pages_messages.rs': { limit: 520, reason: '私信与 SSE', goal: '拆出 SSE 部分' },
  'crates/sc2clud-web/src/routes.rs': { limit: 1445, reason: '路由表 + 跨模块辅助（图片已拆出；2026-10 新增 /admin/titles 三端点）', goal: '拆出 pages_files，routes.rs 只留路由表' },
  'crates/sc2clud-web/src/mail/mod.rs': { limit: 545, reason: 'PR #4 带来的邮件发信模块（Resend 客户端 + 账号选择）', goal: '拆 mail/{mod,types,send}.rs' },
  'crates/sc2clud-web/src/templates.rs': { limit: 1300, reason: 'askama 模板结构体集中定义', goal: '按页面拆 templates/ 子模块' },
  // —— 核心域 ——
  'crates/sc2clud-core/src/community.rs': { limit: 840, reason: '领域模型 + 渲染器 + 分区/用户组判定', goal: '拆 community/{render,groups,issues}.rs' },
  'crates/sc2clud-core/src/review.rs': { limit: 580, reason: '审核机与 AI 判定规则', goal: '拆 review/{rules,ai}.rs' },
  'crates/sc2clud-core/src/config.rs': { limit: 560, reason: '全部配置项与校验集中一处（配置项多）', goal: '按 section 拆 config/' },
  'crates/sc2clud-core/src/auth.rs': { limit: 510, reason: '角色 × 权限位的唯一定义处', goal: '拆 auth/{role,permission}.rs' },
  // —— 模板 ——
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, out)
    else if (EXT.some((e) => name.endsWith(e))) out.push(full)
  }
  return out
}

const files = [...new Set(ROOTS.flatMap((r) => walk(join(ROOT, r))))]
let failed = false
const offenders = []
const seen = new Set()

for (const file of files) {
  const key = relative(ROOT, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split('\n').length
  const pending = PENDING[key]
  seen.add(key)
  if (!pending) {
    if (lines > DEFAULT_LIMIT) {
      offenders.push({ key, lines })
      console.log(`  FAIL ${key}: ${lines} 行 > ${DEFAULT_LIMIT}（未登记：新出现的大文件必须登记重构目标）`)
      failed = true
    }
    continue
  }
  if (lines > pending.limit) {
    console.log(`  FAIL ${key}: ${lines} 行 > 豁免上限 ${pending.limit}（比记录的长度又长了：先重构，或说明为何必须增长）`)
    failed = true
  } else if (lines <= DEFAULT_LIMIT) {
    console.log(`  FAIL ${key}: 已缩到 ${lines} 行（≤ ${DEFAULT_LIMIT}），请从 PENDING 里删掉这条（已达标）`)
    failed = true
  } else {
    console.log(`  ok   ${key}: ${lines} / ${pending.limit}（${pending.reason}${pending.goal ? '；目标：' + pending.goal : ''}）`)
  }
}

for (const key of Object.keys(PENDING)) {
  if (!seen.has(key)) {
    console.log(`  FAIL 豁免登记的文件不存在了：${key}（请删除该条）`)
    failed = true
  }
}

const alarms = []
for (const file of files) {
  const key = relative(ROOT, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split('\n').length
  if (lines > DEFAULT_LIMIT) alarms.push({ key, lines, goal: PENDING[key]?.goal ?? '' })
}
console.log('')
console.log('=== 告警清单（> ' + DEFAULT_LIMIT + ' 行，共 ' + alarms.length + ' 个，永不静默）===')
for (const a of alarms.sort((x, y) => y.lines - x.lines)) {
  console.log('  ⚠ ' + a.key + ': ' + a.lines + ' 行' + (a.goal ? ' → ' + a.goal : '（未登记目标！）'))
}
if (failed) {
  console.log('')
  console.log('体量门禁未通过：新出现的大文件要登记目标；已登记的只能减不能增。')
  process.exit(1)
}
console.log('')
console.log('体量门禁通过（上表仍是待重构清单，不是豁免）。')