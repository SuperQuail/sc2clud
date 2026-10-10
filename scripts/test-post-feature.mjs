import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from '../web/node_modules/typescript/lib/typescript.js'

const code = ts.transpile(readFileSync('web/src/post-feature.ts', 'utf8'), { target: ts.ScriptTarget.ES2020 })
async function scenario(response, reject = false, canAdd = true) {
  const button = { disabled: false, textContent: '设为精华' }
  const target = { value: '1' }
  const note = { textContent: '' }
  const badge = { hidden: true }
  let submit, resolve, calls = 0, request, removed = false
  const form = {
    action: 'http://localhost/dev/p/3/featured',
    dataset: { featureAddAllowed: String(canAdd) },
    remove: () => { removed = true },
    elements: { namedItem: () => target },
    addEventListener: (_, handler) => { submit = handler },
    querySelector: (selector) => selector.includes('button') ? button : note,
    setAttribute() {},
  }
  vm.runInNewContext(code, {
    document: { querySelectorAll: (selector) => selector === '[data-feature-form]' ? [form] : [badge] },
    FormData: class { *[Symbol.iterator]() { yield ['csrf', 'token']; yield ['featured', target.value] } },
    URLSearchParams,
    fetch: (url, options) => { calls++; request = { url, options }; return new Promise((yes, no) => { resolve = () => reject ? no(new Error('网络错误')) : yes(response) }) },
  })
  const pending = submit({ preventDefault() {} })
  assert.equal(button.disabled, true)
  assert.equal(target.value, '1')
  assert.equal(badge.hidden, true)
  await submit({ preventDefault() {} })
  assert.equal(calls, 1)
  resolve()
  await pending
  assert.equal(button.disabled, false)
  assert.equal(request.url, form.action)
  assert.equal(request.options.headers.Accept, 'application/json')
  assert.equal(request.options.body.get('featured'), '1')
  return { button, target, note, badge, calls, removed }
}
const success = await scenario({ ok: true, json: async () => ({ featured: true, changed: false }) })
assert.equal(success.target.value, '0')
assert.equal(success.button.textContent, '取消精华')
assert.equal(success.badge.hidden, false)
assert.equal(success.note.textContent, '')
for (const [response, reject] of [[{ ok: false }, false], [{ ok: true, json: async () => ({ featured: 'true' }) }, false], [null, true]]) {
  const failure = await scenario(response, reject)
  assert.equal(failure.target.value, '1')
  assert.equal(failure.badge.hidden, true)
  assert.equal(failure.button.textContent, '设为精华')
  assert.ok(failure.note.textContent)
  assert.equal(failure.calls, 1)
}
const archived = await scenario({ ok: true, json: async () => ({ featured: false }) }, false, false)
assert.equal(archived.removed, true)
console.log('精华交互：成功后同步、请求禁用、防重复、失败保留状态、无自动重试、服务端 action 前缀均通过。')
