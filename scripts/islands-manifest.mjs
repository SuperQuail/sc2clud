// 构建来源仅覆盖前端输入；文档提交不会使产物失效。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const dir = join(root, 'crates/sc2clud-web/static/islands')
// 与 Bash 的 LC_ALL=C sort -z 一致，按 UTF-8 字节排序，路径与哈希各用 NUL 分隔。
const files = execFileSync('git', ['ls-files', '-z', 'web'], { cwd: root }).toString().split('\0').filter(Boolean)
  .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
const hashes = execFileSync('git', ['hash-object', ...files], { cwd: root }).toString().trim().split(/\r?\n/)
const source = Buffer.concat(files.map((file, i) => Buffer.from(`${file}\0${hashes[i]}\0`)))
const sha = data => createHash('sha256').update(data).digest('hex')
writeFileSync(join(dir, 'SOURCE.sha256'), sha(source) + '\n')
const outputs = readdirSync(dir).filter(name => name !== 'SHA256SUMS').sort()
writeFileSync(join(dir, 'SHA256SUMS'), outputs.map(name => `${sha(readFileSync(join(dir, name)))}  ${name}\n`).join(''))
