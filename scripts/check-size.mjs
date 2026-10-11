// 文件体量门禁：默认 500 行。超限即视为「耦合风险」，必须重构；
// 确实必要（例如数据模型、迁移脚本）可以登记豁免，但豁免必须写明理由与目标，
// 且会被本脚本校验：文件删了/缩到限内/行数又涨了，都会报出来。
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

// 豁免登记表：key 用相对仓库根的路径；limit 必填；reason 必填；goal 是重构目标（可为空字符串）
// 规则：只有「本来就在、且确实必要」的大文件才登记；登记后**不允许行数继续增长**（会报 FAIL）。
const ALLOWED = {
  // —— 数据层：表结构集中在 models，CRUD 集中在 repo ——
  'crates/sc2clud-db/src/repo.rs': { limit: 5700, reason: '全部表的 CRUD 集中一处（按表拆要动 300+ 调用点）', goal: '拆 repo/{posts,issues,users,admin}.rs' },
  'crates/sc2clud-db/src/models.rs': { limit: 660, reason: '全部表对应的行结构', goal: '按领域拆 models/' },
  'crates/sc2clud-db/src/lib.rs': { limit: 850, reason: '连接/迁移/密钥与迁移内嵌', goal: '拆 db/{conn,migrate,secret}.rs' },
  'crates/sc2clud-db/src/backend_tests.rs': { limit: 790, reason: '仓储的端到端测试（测试文件按功能堆叠是常态）', goal: '按领域拆测试文件' },
  'crates/sc2clud-db/src/community_tests.rs': { limit: 670, reason: '社区域测试', goal: '按领域拆测试文件' },
  // —— Web 层：页面处理器与模板结构 ——
  'crates/sc2clud-web/src/pages_posts.rs': { limit: 2200, reason: '帖子/审核/评论/issue/编辑的处理器集合', goal: '拆 pages_post_edit / pages_issues / pages_comments' },
  'crates/sc2clud-web/src/pages_admin.rs': { limit: 2200, reason: '管理面板处理器集合（含 AI 审核与用户组）', goal: '按面板分区拆分' },
  'crates/sc2clud-web/src/pages_donations.rs': { limit: 700, reason: '打赏记录与人工验证（新模块，先观察）', goal: '拆页面与仓储调用' },
  'crates/sc2clud-web/src/pages_messages.rs': { limit: 520, reason: '私信与 SSE', goal: '拆出 SSE 部分' },
  'crates/sc2clud-web/src/routes.rs': { limit: 1400, reason: '路由表 + 跨模块辅助（图片已拆出）', goal: '拆出 pages_files，routes.rs 只留路由表' },
  'crates/sc2clud-web/src/templates.rs': { limit: 1300, reason: 'askama 模板结构体集中定义', goal: '按页面拆 templates/ 子模块' },
  // —— 核心域 ——
  'crates/sc2clud-core/src/community.rs': { limit: 840, reason: '领域模型 + 渲染器 + 分区/用户组判定', goal: '拆 community/{render,groups,issues}.rs' },
  'crates/sc2clud-core/src/review.rs': { limit: 580, reason: '审核机与 AI 判定规则', goal: '拆 review/{rules,ai}.rs' },
  'crates/sc2clud-core/src/config.rs': { limit: 560, reason: '全部配置项与校验集中一处（配置项多）', goal: '按 section 拆 config/' },
  'crates/sc2clud-core/src/auth.rs': { limit: 510, reason: '角色 × 权限位的唯一定义处', goal: '拆 auth/{role,permission}.rs' },
  // —— 模板 ——
  'crates/sc2clud-web/templates/admin.html': { limit: 900, reason: '管理面板模板', goal: '按面板分区拆 partial' },
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
  const allow = ALLOWED[key]
  seen.add(key)
  if (!allow) {
    if (lines > DEFAULT_LIMIT) {
      offenders.push({ key, lines })
      console.log(`  FAIL ${key}: ${lines} 行 > ${DEFAULT_LIMIT}（未登记豁免：要么重构，要么在 ALLOWED 里写明理由与目标）`)
      failed = true
    }
    continue
  }
  if (lines > allow.limit) {
    console.log(`  FAIL ${key}: ${lines} 行 > 豁免上限 ${allow.limit}（豁免不是免死金牌：不许继续变长）`)
    failed = true
  } else if (lines <= DEFAULT_LIMIT) {
    console.log(`  FAIL ${key}: 已缩到 ${lines} 行（≤ ${DEFAULT_LIMIT}），请从 ALLOWED 里删掉这条豁免`)
    failed = true
  } else {
    console.log(`  ok   ${key}: ${lines} / ${allow.limit}（${allow.reason}${allow.goal ? '；目标：' + allow.goal : ''}）`)
  }
}

for (const key of Object.keys(ALLOWED)) {
  if (!seen.has(key)) {
    console.log(`  FAIL 豁免登记的文件不存在了：${key}（请删除该条）`)
    failed = true
  }
}

const over = files.filter((f) => readFileSync(f, 'utf8').split('\n').length > DEFAULT_LIMIT).length
console.log('')
console.log(`文件体量门禁：扫描 ${files.length} 个文件，> ${DEFAULT_LIMIT} 行的 ${over} 个（全部已登记豁免并给出重构目标）`)
if (failed) {
  console.log('体量门禁未通过：请重构，或在 ALLOWED 里登记理由与目标。')
  process.exit(1)
}
console.log('体量门禁通过。')