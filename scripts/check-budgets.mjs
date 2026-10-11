#!/usr/bin/env node
// 页面体积预算门禁：见 docs/BUDGETS.md §3。
//
// 口径与 nginx 的 brotli_static 一致：对产物做 brotli 质量 11 压缩后测量。
// 产物缺失、或超预算，都以非零退出码失败——绝不静默「通过 0 KB」。
//
// 三条断言互相独立：
//   1. 首屏 JS：**每个页面首次渲染真正会下载的那一份**，也就是 base.html 里
//      无条件挂着的那几个岛。原先把 islands/ 下所有 .js 无条件相加，等于量了
//      一个不存在的东西——没有任何页面会同时加载全部岛，那个和既不是首屏、
//      也不是任何一个单页的体积。
//   2. 单岛上限 ≤ 120 KB：与 web/vite.config.ts 里写的预算一致，兜住
//      「某个页面自己的岛悄悄膨胀」。
//   3. 模板引用的岛必须真实存在：防模板里写错文件名、或产物没生成。
//
// 改模板里的 <script src="/static/islands/..."> 时，同步下面的 SHARED / SHELL_ALTERNATIVES。

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'

const STATIC = 'crates/sc2clud-web/static'
const ISLANDS = join(STATIC, 'islands')
const TEMPLATES = 'crates/sc2clud-web/templates'
const KB = 1024

/** 每个页面都要下载的岛（base.html 里无条件挂载）。 */
const SHARED = ['theme', 'post-images']

/** base.html 里按登录态二选一的岛：整页只会下其中一个，取较大的当上界。 */
const SHELL_ALTERNATIVES = [['account', 'auth']]

/** 单岛上限，与 web/vite.config.ts 的注释一致。 */
const ISLAND_LIMIT = 120 * KB

const brotliSize = (path) =>
  brotliCompressSync(readFileSync(path), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length

/** 逐文件测量；缺失即失败。 */
function measure(dir, files, label) {
  const rows = []
  for (const file of files) {
    const path = join(dir, file)
    if (!existsSync(path)) {
      console.log(`  FAIL ${label}: 缺少 ${path}`)
      return null
    }
    const size = brotliSize(path)
    rows.push({ file, size })
    console.log(`      ${file}: ${(size / KB).toFixed(1)} KB`)
  }
  return rows
}

let failed = false
console.log('资源体积预算（brotli 质量 11）：')

// ---- CSS ----
const cssGroups = [
  { label: '首屏 CSS', limit: 20 * KB, files: ['app.css', 'home.css', 'forum.css'] },
  { label: '非首页 CSS', limit: 20 * KB, files: ['app.css', 'site.css'] },
]
for (const group of cssGroups) {
  const rows = measure(STATIC, group.files, group.label)
  if (!rows) {
    failed = true
    continue
  }
  const total = rows.reduce((sum, r) => sum + r.size, 0)
  const passed = total <= group.limit
  if (!passed) failed = true
  console.log(
    `  ${passed ? 'ok  ' : 'FAIL'} ${group.label}: ${(total / KB).toFixed(1)} KB / ${(group.limit / KB).toFixed(0)} KB`,
  )
}

// ---- 首屏 JS：共享外壳（二选一的岛取较大者） ----
if (!existsSync(ISLANDS)) {
  console.log(`  FAIL 首屏 JS: ${ISLANDS} 下没有产物，先执行 pnpm -C web build`)
  failed = true
} else {
  const rows = measure(ISLANDS, SHARED.map((n) => n + '.js'), '首屏 JS')
  if (!rows) {
    failed = true
  } else {
    let total = rows.reduce((sum, r) => sum + r.size, 0)
    for (const pair of SHELL_ALTERNATIVES) {
      const present = pair.filter((n) => existsSync(join(ISLANDS, n + '.js')))
      if (present.length === 0) {
        console.log(`  FAIL 首屏 JS: 缺少 ${pair.map((n) => n + '.js').join(' / ')}`)
        failed = true
        continue
      }
      // 同一页只会下其中一个，取大的那个计
      const sizes = present.map((n) => ({ n, size: brotliSize(join(ISLANDS, n + '.js')) }))
      const worst = sizes.reduce((a, b) => (b.size > a.size ? b : a))
      total += worst.size
      console.log(`      ${worst.n}.js: ${(worst.size / KB).toFixed(1)} KB（二选一，取较大者）`)
    }
    const limit = 60 * KB
    const passed = total <= limit
    if (!passed) failed = true
    console.log(
      `  ${passed ? 'ok  ' : 'FAIL'} 首屏 JS（每页共享外壳）: ${(total / KB).toFixed(1)} KB / ${(limit / KB).toFixed(0)} KB`,
    )
  }
}

// ---- 单岛上限 ----
if (existsSync(ISLANDS)) {
  const islands = readdirSync(ISLANDS).filter((f) => f.endsWith('.js')).sort()
  if (islands.length === 0) {
    console.log('  FAIL 单岛上限: islands/ 下没有产物')
    failed = true
  } else {
    let worst = { file: '', size: 0 }
    for (const file of islands) {
      const size = brotliSize(join(ISLANDS, file))
      if (size > worst.size) worst = { file, size }
    }
    const passed = worst.size <= ISLAND_LIMIT
    if (!passed) failed = true
    console.log(
      `  ${passed ? 'ok  ' : 'FAIL'} 单岛上限（最大者）: ${worst.file} ${(worst.size / KB).toFixed(1)} KB / ${(ISLAND_LIMIT / KB).toFixed(0)} KB`,
    )
  }

  // ---- 模板引用的岛必须存在 ----
  const referenced = new Set()
  for (const file of readdirSync(TEMPLATES).filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(join(TEMPLATES, file), 'utf8')
    for (const m of html.matchAll(/islands\/([a-z0-9-]+)\.js/g)) referenced.add(m[1])
  }
  const built = new Set(islands.map((f) => f.replace(/\.js$/, '')))
  const missing = [...referenced].filter((n) => !built.has(n)).sort()
  const orphan = [...built].filter((n) => !referenced.has(n)).sort()
  if (missing.length > 0) {
    console.log(`  FAIL 模板引用了未构建的岛: ${missing.join(', ')}`)
    failed = true
  } else {
    console.log(`  ok   模板引用的 ${referenced.size} 个岛均已构建`)
  }
  if (orphan.length > 0) {
    console.log(`       （已构建但模板未引用：${orphan.join(', ')}）`)
  }
}

if (failed) {
  console.error('\n预算未通过：请缩小产物，或先在 docs/BUDGETS.md 里改预算并说明理由。')
  process.exit(1)
}
console.log('\n预算检查通过。')
