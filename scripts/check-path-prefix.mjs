// 门禁：前端岛里的站内绝对路径必须经 appUrl()/adminUrl() 包一层。
// 原因：/dev 挂在路径前缀下，nginx sub_filter 只改 HTML、改不到 JS 字符串；
// 裸写 '/avatar/x' 会请求到生产入口（401/404）。这个 bug 已发生三次（评论头像、管理页、帖子链接）。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\//, '')
const SRC = join(ROOT, 'web/src')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(full)
  }
  return out
}

// 例外：lib/paths.ts 自己就是实现；admin.ts 用 PREFIX 手工拼（历史写法）
const ALLOW = new Set(['web/src/lib/paths.ts', 'web/src/lib/admin.ts', 'web/src/admin.ts'])
const BAD = [
  /src=\{`\/(?!\/)/,          // src={`/xxx
  /href=\{`\/(?!\/)/,         // href={`/xxx
  /fetch\(`\/(?!\/)/,         // fetch(`/xxx
  /src=\{\s*'\/(?!/),        // src={'/xxx
  /href=\{\s*'\/(?!/),       // href={'/xxx
]

let failed = false
for (const file of walk(SRC)) {
  const key = relative(ROOT, file).replace(/\\/g, '/')
  if (ALLOW.has(key)) continue
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (BAD.some((re) => re.test(line))) {
      console.log(`  FAIL ${key}:${i + 1}: 站内绝对路径必须用 appUrl()/adminUrl() 包裹`)
      console.log(`       ${line.trim().slice(0, 100)}`)
      failed = true
    }
  })
}

if (failed) {
  console.log('路径前缀门禁未通过。')
  process.exit(1)
}
console.log('路径前缀门禁通过（前端岛里的站内绝对路径都走 appUrl/adminUrl）。')