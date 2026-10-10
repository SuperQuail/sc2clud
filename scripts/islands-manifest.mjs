// 构建来源仅覆盖前端输入；文档提交不会使产物失效。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
const root = fileURLToPath(new URL('../', import.meta.url))
const dir = join(root, 'crates/sc2clud-web/static/islands')
const files = execFileSync('git', ['ls-files', '-z', 'web'], { cwd: root }).toString().split('\0').filter(Boolean)
const hashes = execFileSync('git', ['hash-object', ...files], { cwd: root })
const sha = data => createHash('sha256').update(data).digest('hex')
writeFileSync(join(dir, 'SOURCE.sha256'), sha(hashes) + '\n')
const outputs = readdirSync(dir).filter(name => name !== 'SHA256SUMS').sort()
writeFileSync(join(dir, 'SHA256SUMS'), outputs.map(name => `${sha(readFileSync(join(dir, name)))}  ${name}\n`).join(''))
