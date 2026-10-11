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
//   2. 单岛上限（含它 import 的本地 chunk）：React 岛会共享 React 运行时的 chunk，
//      只量入口文件会低估真实下载量，所以按 import 闭包求和。
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

/** 单个岛（含其本地 chunk）的上限，与 web/vite.config.ts 的注释一致。 */
const ISLAND_LIMIT = 120 * KB
// 具名豁免：富文本编辑器天生重（TipTap/ProseMirror + markdown 往返 ≈ 164 KB brotli），
// 且只在登录后的编辑页加载、不进任何页面的首屏（首屏 3.5/60）。理由见 docs/BUDGETS.md。
const ISLAND_LIMIT_OVERRIDES = { postform: 200 * KB }
const islandLimitFor = (entry) => ISLAND_LIMIT_OVERRIDES[entry] ?? ISLAND_LIMIT

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

/** 产物里的本地 chunk 引用形如 from"./ui.js"（vite 输出无空格）。 */
const localImports = (name) => {
  const path = join(ISLANDS, name + '.js')
  if (!existsSync(path)) return []
  return [...readFileSync(path, 'utf8').matchAll(/from"\.\/([A-Za-z0-9-]+)\.js"/g)].map((m) => m[1])
}

/** 入口 + 它递归 import 的本地 chunk（去重）。 */
function islandClosure(name, seen = new Set()) {
  if (seen.has(name)) return seen
  seen.add(name)
  for (const dep of localImports(name)) islandClosure(dep, seen)
  return seen
}

let failed = false
console.log('资源体积预算（brotli 质量 11）：')

// ---- CSS ----
for (const group of [
  // 22 KB：首页外壳 CSS 在 2026-10 已到 20.1 KB（顶栏未读红点等小样式累积），
  // 留 2 KB 余量；理由记录在 docs/BUDGETS.md。
  { label: '首屏 CSS', limit: 22 * KB, files: ['app.css', 'home.css', 'forum.css'] },
  { label: '非首页 CSS', limit: 20 * KB, files: ['app.css', 'site.css'] },
]) {
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
      const worst = present
        .map((n) => ({ n, size: brotliSize(join(ISLANDS, n + '.js')) }))
        .reduce((a, b) => (b.size > a.size ? b : a))
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

// ---- 单岛上限（含本地 chunk） + 模板引用校验 ----
if (existsSync(ISLANDS)) {
  const built = readdirSync(ISLANDS)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\.js$/, ''))
    .sort()

  const referenced = new Set()
  for (const file of readdirSync(TEMPLATES).filter((f) => f.endsWith('.html'))) {
    const html = readFileSync(join(TEMPLATES, file), 'utf8')
    for (const m of html.matchAll(/islands\/([a-z0-9-]+)\.js/g)) referenced.add(m[1])
  }

  if (referenced.size === 0) {
    console.log('  FAIL 单岛上限: 没有任何模板引用岛')
    failed = true
  } else {
    // 模板引用的入口 + 它的 chunk 闭包 = 该页面为一个岛付出的下载量
    let worst = { entry: '', size: 0, parts: [] }
    for (const entry of [...referenced].sort()) {
      const closure = [...islandClosure(entry)].sort()
      const missing = closure.filter((n) => !built.includes(n))
      if (missing.length > 0) {
        console.log(`  FAIL 单岛上限: ${entry} 依赖的 chunk 不存在: ${missing.join(', ')}`)
        failed = true
        continue
      }
      const size = closure.reduce((sum, n) => sum + brotliSize(join(ISLANDS, n + '.js')), 0)
      if (size > worst.size) worst = { entry, size, parts: closure }
    }
    const passed = worst.size <= islandLimitFor(worst.entry)
    if (!passed) failed = true
    console.log(
      `  ${passed ? 'ok  ' : 'FAIL'} 单岛上限（最大者）: ${worst.entry}.js（含 ${worst.parts.length} 个 chunk）` +
        ` ${(worst.size / KB).toFixed(1)} KB / ${(islandLimitFor(worst.entry) / KB).toFixed(0)} KB`,
    )
  }

  const missing = [...referenced].filter((n) => !built.includes(n)).sort()
  if (missing.length > 0) {
    console.log(`  FAIL 模板引用了未构建的岛: ${missing.join(', ')}`)
    failed = true
  } else {
    console.log(`  ok   模板引用的 ${referenced.size} 个岛均已构建`)
  }

  // 既没被模板引用、也没被别的岛 import 的产物 = 真正的死产物
  const imported = new Set(built.flatMap((n) => localImports(n)))
  const orphan = built.filter((n) => !referenced.has(n) && !imported.has(n)).sort()
  if (orphan.length > 0) {
    console.log(`  FAIL 死产物（既无模板引用也无人 import）: ${orphan.join(', ')}`)
    failed = true
  }
}

if (failed) {
  console.error('\n预算未通过：请缩小产物，或先在 docs/BUDGETS.md 里改预算并说明理由。')
  process.exit(1)
}
console.log('\n预算检查通过。')