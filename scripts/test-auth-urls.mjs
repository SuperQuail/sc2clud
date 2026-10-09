import assert from 'node:assert/strict'
import { authTarget } from '../web/src/auth-urls.ts'

const origin = 'https://community.example'
for (const base of ['/', '/dev/', '/preview/community/']) {
  assert.deepEqual(authTarget(`${base}login`, base, origin), { mode: 'login', action: `${base}login` })
  assert.deepEqual(authTarget(`${base}register`, base, origin), { mode: 'register', action: `${base}register` })
  assert.equal(authTarget('/admin', base, origin), null)
  assert.equal(authTarget('https://other.example/login', base, origin), null)
  assert.equal(authTarget('javascript:alert(1)', base, origin), null)
  assert.equal(authTarget(`${base}login?next=https://other.example`, base, origin), null)
}
assert.equal(authTarget('/login', '/dev/', origin), null)
assert.equal(authTarget('/dev/../login', '/dev/', origin), null)
assert.equal(authTarget('/dev/login', 'https://other.example/', origin), null)
console.log('弹窗登录 URL 检查通过：根路径、代理前缀、跨站与越界请求。')
