#!/usr/bin/env node
// 页面体积预算门禁：见 docs/BUDGETS.md §3。
//
// 口径与 nginx 的 brotli_static 一致：对产物做 brotli 质量 11 压缩后测量。
// 产物缺失、或超预算，都以非零退出码失败——绝不静默「通过 0 KB」。

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants } from 'node:zlib'

const STATIC = 'crates/sc2clud-web/static'
const ISLANDS = join(STATIC, 'islands')
const KB = 1024

const groups = [
  {
    label: '首屏 CSS',
    limit: 20 * KB,
    dir: STATIC,
    files: ['app.css'],
  },
  {
    label: '首屏 JS（前端岛）',
    limit: 60 * KB,
    dir: ISLANDS,
    files: existsSync(ISLANDS) ? readdirSync(ISLANDS).filter((f) => f.endsWith('.js')) : [],
  },
]

const brotliSize = (path) =>
  brotliCompressSync(readFileSync(path), {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
  }).length

let failed = false
console.log('资源体积预算（brotli 质量 11）：')

for (const group of groups) {
  if (group.files.length === 0) {
    console.log(`  FAIL ${group.label}: ${group.dir} 下没有产物，先执行 pnpm -C web build`)
    failed = true
    continue
  }

  let total = 0
  for (const file of group.files) {
    const path = join(group.dir, file)
    if (!existsSync(path)) {
      console.log(`  FAIL ${group.label}: 缺少 ${path}`)
      failed = true
      continue
    }
    const size = brotliSize(path)
    total += size
    console.log(`      ${file}: ${(size / KB).toFixed(1)} KB`)
  }

  const passed = total > 0 && total <= group.limit
  if (!passed) failed = true
  console.log(
    `  ${passed ? 'ok  ' : 'FAIL'} ${group.label}: ${(total / KB).toFixed(1)} KB / ${(group.limit / KB).toFixed(0)} KB`,
  )
}

if (failed) {
  console.error('\n预算未通过：请缩小产物，或先在 docs/BUDGETS.md 里改预算并说明理由。')
  process.exit(1)
}
console.log('\n预算检查通过。')
