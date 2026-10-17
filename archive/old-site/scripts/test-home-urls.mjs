import assert from 'node:assert/strict'
import { readerUrl } from '../web/src/home-urls.ts'

const origin = 'https://community.example'
const hash = 'a'.repeat(64)
for (const base of ['/', '/dev/', '/preview/community/']) {
  assert.equal(readerUrl(`${base}p/12`, base, origin, 'post'), `${base}p/12`)
  assert.equal(readerUrl(`${base}img/${hash}`, base, origin, 'image'), `${base}img/${hash}`)
  assert.equal(readerUrl('/admin', base, origin, 'post'), null)
  assert.equal(readerUrl('https://other.example/p/12', base, origin, 'post'), null)
  assert.equal(readerUrl('javascript:alert(1)', base, origin, 'post'), null)
  assert.equal(readerUrl(`${base}p/12?other=1`, base, origin, 'post'), null)
  assert.equal(readerUrl(`${base}img/no-hash`, base, origin, 'image'), null)
}
assert.equal(readerUrl('/p/12', '/dev/', origin, 'post'), null)
assert.equal(readerUrl(`/img/${hash}`, '/dev/', origin, 'image'), null)
assert.equal(readerUrl('/dev/../p/12', '/dev/', origin, 'post'), null)
assert.equal(readerUrl('/dev/p/12', 'https://other.example/', origin, 'post'), null)
console.log('首页 URL 检查通过：根路径、代理前缀、跨站与越界路径。')
