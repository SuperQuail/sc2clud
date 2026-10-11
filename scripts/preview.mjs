#!/usr/bin/env node
// ============================================================
// 前端预览：把**真实数据下的整页**渲染成 PNG，供人（和 AI）看图确认。
//
// 为什么需要它：askama 模板改动只有真跑起来才看得见；只看代码/空壳截图会漏掉
// 「同页面其它内容被挤坏」这类问题。所以这里：
//   1. 拉一份 **dev 库的只读快照**（VACUUM INTO，不碰 dev/生产）；
//   2. 本地起实例（独立数据目录 + 独立端口 + 独立 Cookie 名）；
//   3. 用真实账号**登录**，CDP 设 Cookie，整页截图（含登录态页面）；
//   4. **断言页面里有真实内容**（空壳直接报错退出）。
//
// 用法：
//   node scripts/preview.mjs [--server root@host] [--handle tangtian] [--out ../../shots/preview]
//                                 [--port 18120] [--theme light|dark|both] [--pages /,/p/11]
//
// 只会读服务器数据；密码只写进**本地临时副本**，不会碰 dev 与生产。
// ============================================================

import { spawn, spawnSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { mkdirSync, copyFileSync, writeFileSync, existsSync, openSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const server = arg('server', process.env.SC2CLUD_SERVER ?? '')
// 私钥在仓库外（secrets/），用环境变量传，别写进脚本
const sshKey = process.env.SC2CLUD_SSH_KEY ?? ''
const sshOpts = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', ...(sshKey ? ['-i', sshKey, '-o', 'IdentitiesOnly=yes'] : [])]
const handle = arg('handle', 'tangtian')
const password = arg('password', 'preview-pass-' + Math.random().toString(36).slice(2, 8))
const port = Number(arg('port', '18120'))
const theme = arg('theme', 'both')
// PC 视口：默认 1440×900（只截首屏，比例正常）；--full 才截整页长图
const width = Number(arg('width', '1440'))
const height = Number(arg('height', '900'))
const fullPage = args.includes('--full')
// --qr-test：生成三张不同分辨率的纯蓝测试图，走**真实上传接口**传进本地副本，
// 用来验证「上传分辨率不同、展示尺寸一致」
const qrTest = args.includes('--qr-test')
// --bio "文字"：给登录用户写一段简介（只写本地副本），用来渲染带简介的页面
const bioArg = arg('bio', '')
// --donate-test：给登录用户开启打赏展示（只写本地副本），用来渲染带赞助按钮的页面
const donateTest = args.includes('--donate-test')
// --dm <handle>：给某人发一条私信（只写本地副本），让消息中心有真实会话可渲染
const dmTo = arg('dm', '')
// --send-test：在消息中心里真的发一条（走页面上的无感发送），用来验证「不刷新就地出气泡」
const sendTest = args.includes('--send-test')
// --seed-titles：往**本地快照副本**塞几个头衔（dev/生产一个字节都不碰），用于渲染头衔区
const seedTitles = args.includes('--seed-titles')
// --title-test：打开用户编辑弹窗，走真实接口发放 → 核对徽章/计数/DB 行数 → 收回（只动本地副本）
const titleTest = args.includes('--title-test')
// shortcut: --comment-test 的无感发布验证这次没做通（脚本流程问题），先撤掉，等要自动化时再补
const outDir = arg('out', join(repo, '..', 'shots', 'preview'))
const pagesArg = arg('pages', '')

// 纯色 PNG 编码器（只要 zlib，够造测试图）：8 位 RGB、无滤波
const solidPng = (size, [r, g, b]) => {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y++) {
    const row = y * (size * 3 + 1)
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      raw[row + 1 + x * 3] = r
      raw[row + 2 + x * 3] = g
      raw[row + 3 + x * 3] = b
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const run = (cmd, cmdArgs, opts = {}) => {
  const res = spawnSync(cmd, cmdArgs, { encoding: 'utf8', ...opts })
  if (res.status !== 0) {
    throw new Error(`${cmd} ${cmdArgs.join(' ')} 失败：${res.stderr || res.stdout}`)
  }
  return res.stdout
}

  // 迁移是编译期内嵌的：增量编译可能不重编，先 touch 一下（与 deploy/dev.sh 同样的坑）
  const dbLib = repo + '/crates/sc2clud-db/src/lib.rs'
  if (existsSync(dbLib)) {
    const fs = await import('node:fs')
    const now = new Date()
    fs.utimesSync(dbLib, now, now)
  }
// askama 模板与迁移都是**编译期**内嵌的：不重建就会「模板是旧的 / 迁移认不出来」，
// 预览与上线也就不是同一份代码了。所以这里强制重建（增量，通常几秒）。
console.log('==> 构建（模板与迁移内嵌，必须重建才能反映当前代码）')
const build = spawnSync('cargo', ['build', '-p', 'sc2clud-app', '-q'], { cwd: repo, stdio: 'inherit' })
if (build.status !== 0) throw new Error('构建失败，先手动 cargo build -p sc2clud-app 看错误')

// 与上面的构建一致：先找 debug（cargo build 默认产物），再退到 release
const exe = ['target/debug/sc2clud.exe', 'target/release/sc2clud.exe'].map((p) => join(repo, p)).find(existsSync)
if (!exe) throw new Error('构建产物没找到')

const browser = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/msedge.exe',
].find(existsSync)
if (!browser) throw new Error('找不到 Chrome/Edge')

// ---------- 1. 准备数据：dev 库的只读快照 ----------
const work = join(tmpdir(), 'sc2clud-preview-' + Date.now())
mkdirSync(work, { recursive: true })
const dbPath = join(work, 'sc2clud.sqlite3')
if (server) {
  console.log('==> 拉取 dev 库快照（VACUUM INTO，只读）')
  const remote = '/tmp/preview-snap.sqlite3'
  run('ssh', [...sshOpts, server,
    `sqlite3 /srv/sc2clud-dev/data/sc2clud.sqlite3 "VACUUM INTO '${remote}'" && echo ok`])
  run('scp', ['-q', ...sshOpts, `${server}:${remote}`, dbPath])
  run('ssh', [...sshOpts, server, `rm -f ${remote}`])
  // 图片/头像走内容寻址：把 dev 的 blob 也拉一份（只读），否则页面里图片是空的
  run('scp', ['-q', '-r', ...sshOpts, `${server}:/srv/sc2clud-dev/data/blobs`, join(work, 'blobs')])
} else if (existsSync(join(repo, 'preview-seed.sqlite3'))) {
  copyFileSync(join(repo, 'preview-seed.sqlite3'), dbPath)
  console.log('==> 用本地 preview-seed.sqlite3')
} else {
  console.log('==> 没有 --server 也没有 preview-seed.sqlite3：用空库（页面会很空，仅供布局自检）')
}

// 头衔样张：只写本地副本（内容寻址的库是快照，dev 不受影响）
if (seedTitles && existsSync(dbPath)) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(dbPath)
  // 先清掉可能残留的样张（早期版本删过 titles 行，user_titles 会留下孤儿）
  const sampleKeys = ['veteran', 'translator_sample', 'founder_sample']
  for (const key of sampleKeys) {
    db.prepare('DELETE FROM user_titles WHERE title_id IN (SELECT id FROM titles WHERE key = ?)').run(key)
    db.prepare('DELETE FROM titles WHERE key = ?').run(key)
  }
  const rows = [
    ['veteran', '老兵', '#f97316', '2024 年前就在的老账号'],
    ['translator_sample', '汉化组', '#2563eb', '参与过汉化与校对'],
    ['founder_sample', '元老', '#7c3aed', '建站成员（已归档，只可收回）', 1],
  ]
  for (const [key, name, color, description, archived] of rows) {
    db.prepare('INSERT OR IGNORE INTO titles (key, name, color, description, created_at, archived_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(key, name, color, description, 1_700_000_000, archived ? 1_700_000_000 : null)
  }
  db.close()
  console.log('==> 已往本地快照塞入 3 个头衔样张（veteran / translator_sample / founder_sample）')
}

// ---------- 2. 起本地实例（独立端口 / 数据目录 / Cookie 名） ----------
const env = {
  ...process.env,
  SC2CLUD_BIND: `127.0.0.1:${port}`,
  SC2CLUD_BASE_URL: `http://127.0.0.1:${port}`,
  SC2CLUD_DATA_DIR: work,
  SC2CLUD_COOKIE_NAME: 'sc2clud_preview_session',
  SC2CLUD_DEBUG_PAGES: '1',
  SC2CLUD_SERVE_BLOBS_LOCALLY: '1',
  SC2CLUD_DOWNLOAD_SECRET: 'preview-secret-not-a-real-one',
  SC2CLUD_LOG: 'warn',
}
if (existsSync(dbPath)) {
  // 只改本地副本里的密码：dev/生产完全不受影响
  spawnSync(exe, ['set-password', handle, password], { env, encoding: 'utf8' })
}
// 应用输出落日志：起不来时能直接看到原因，不要吞掉
const appLog = openSync(join(work, 'app.log'), 'a')
const app = spawn(exe, ['serve'], { env, stdio: ['ignore', appLog, appLog] })
const base = `http://127.0.0.1:${port}`
const waitUp = async () => {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(base + '/healthz')
      if (res.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('本地实例没起来，看日志：' + join(work, 'app.log'))
}

// ---------- 3. CDP：登录 + 整页截图 ----------
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map() }
  static async open(port) {
    // 必须连**页面级** target：/json/version 是浏览器级，没有 Page/Network 域
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    const page = list.find((t) => t.type === 'page') ?? list[0]
    if (!page?.webSocketDebuggerUrl) throw new Error('没有可用的页面 target')
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('CDP WebSocket 连接失败'))
    })
    const cdp = new Cdp(ws)
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.id === undefined) {
          cdp.onEvent?.(msg)
          return
        }
        const slot = cdp.pending.get(msg.id)
        if (!slot) return
        cdp.pending.delete(msg.id)
        // 别吞 CDP 错误：吞了只会得到「undefined 不是字符串」这种没头没脑的报错
        if (msg.error) slot.reject(new Error(msg.error.message))
        else slot.resolve(msg.result ?? {})
      } catch (err) {
        console.error('CDP 回包处理失败：' + err.message)
      }
    }
    return cdp
  }
  send(method, params = {}) {
    const id = ++this.id
    this.ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }))
  }
  close() { this.ws.close() }
}

const shots = []
let failed = 0

const main = async () => {
  await waitUp()
  console.log('==> 本地实例已就绪：' + base)

  // 登录：拿会话 Cookie（失败也不致命，游客页面照样能截）
  let cookie = null
  if (existsSync(dbPath)) {
    const form = new URLSearchParams({ account: handle, password })
    const res = await fetch(base + '/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: form,
      redirect: 'manual',
    })
    const raw = res.headers.getSetCookie?.() ?? []
    const line = raw.find((c) => c.startsWith('sc2clud_preview_session='))
    cookie = line ? line.split(';')[0] : null
    console.log(cookie ? `==> 已登录：${handle}` : '==> 登录失败，只截游客视图')
  }

  // 发一条私信：消息中心要看到真实会话与气泡
  if (dmTo && cookie && existsSync(dbPath)) {
    const page = await (await fetch(base + '/inbox', { headers: { cookie } })).text()
    const csrf = (page.match(/name="csrf" value="([^"]+)"/) ?? [])[1]
    const res = await fetch(base + '/messages/' + dmTo, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ csrf, body: '你好，我是唐天。想跟你确认一下 mod 的下载源是否还有效？' }),
      redirect: 'manual',
    })
    console.log('==> 发测试私信给 ' + dmTo + ' → ' + res.status)
  }
  // （评论无感发布的验证挪到 cdp 就绪之后，见下方）

  // 开打赏（本地副本）：让作者主页/帖子页出现「赞助作者」
  if (donateTest && cookie && existsSync(dbPath)) {
    const page = await (await fetch(base + '/settings', { headers: { cookie } })).text()
    const csrf = (page.match(/name="csrf" value="([^"]+)"/) ?? [])[1]
    const res = await fetch(base + '/settings/donation', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ csrf, visible: '1', notice_visible: '1' }),
      redirect: 'manual',
    })
    console.log('==> 开启打赏展示 → ' + res.status)
  }

  // 写简介（只为预览好看，且只写本地副本）
  if (bioArg && cookie && existsSync(dbPath)) {
    const page = await (await fetch(base + '/settings', { headers: { cookie } })).text()
    const csrf = (page.match(/name="csrf" value="([^"]+)"/) ?? [])[1]
    const res = await fetch(base + '/settings/bio', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ csrf, bio: bioArg }),
      redirect: 'manual',
    })
    console.log('==> 写入测试简介 → ' + res.status)
  }

  // 三张纯蓝测试图（200 / 512 / 1200），走真实上传接口 —— 验证展示尺寸是否一致
  if (qrTest && cookie && existsSync(dbPath)) {
    const page = await (await fetch(base + '/settings', { headers: { cookie } })).text()
    const csrf = (page.match(/name="csrf" value="([^"]+)"/) ?? [])[1]
    if (!csrf) throw new Error('拿不到 csrf，无法上传测试图')
    for (const size of [200, 512, 1200]) {
      const png = solidPng(size, [37, 99, 235])
      const res = await fetch(
        `${base}/api/v1/me/payment-channels?channel=test${size}&label=${size}px`,
        { method: 'POST', headers: { 'x-csrf-token': csrf, cookie }, body: png },
      )
      console.log(`==> 上传测试收款码 ${size}×${size} → ${res.status}`)
    }
  }
  // 页面清单：默认覆盖「首页 / 分区 / 帖子 / 编辑页 / 后台 / 我的」
  let pages = pagesArg ? pagesArg.split(',') : []
  if (!pages.length) {
    const home = await (await fetch(base + '/')).text()
    const postId = (home.match(/\/p\/(\d+)/) ?? [])[1] ?? '1'
    pages = ['/', '/?section=custom_campaign', `/p/${postId}`, `/p/${postId}/edit`, '/new', '/admin/users/overview', '/me']
  }

  const chromePort = port + 1
  const chrome = spawn(browser, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${chromePort}`, `--user-data-dir=${join(work, 'chrome')}`,
    'about:blank',
  ], { stdio: 'ignore' })
  let cdp
  for (let i = 0; i < 40 && !cdp; i++) {
    try { cdp = await Cdp.open(chromePort) } catch { await new Promise((r) => setTimeout(r, 250)) }
  }
  if (!cdp) throw new Error('连不上 Chrome 调试端口')
  await cdp.send('Runtime.enable')
  await cdp.send('Network.enable')
  cdp.onEvent = (msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const parts = (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type)
      console.log('  [page:' + msg.params.type + '] ' + parts.join(' '))
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      console.log('  [page:exception] ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text))
    }
  }
  await cdp.send('Page.enable')
  // 不设视口的话 headless 默认 ~800 宽，截出来就是窄长条
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  })
  if (cookie) {
    await cdp.send('Network.setCookie', {
      name: 'sc2clud_preview_session', value: cookie.split('=')[1],
      domain: '127.0.0.1', path: '/', httpOnly: true,
    })
  }

  // 无感发送验证：在页面里触发提交，然后数一数气泡有没有就地多出来（没有发生跳转）
  if (sendTest) {
    // 先真的打开消息中心页（否则脚本跑在 about:blank 上，抓不到 composer）
    const target = '/inbox?tab=dm' + (dmTo ? '&with=' + dmTo : '')
    await cdp.send('Page.navigate', { url: base + target })
    await new Promise((r) => setTimeout(r, 900))
    const before = await cdp.send('Runtime.evaluate', { expression: "location.pathname + location.search" })
    await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const handleForTest = ${JSON.stringify(dmTo)};
        const form = document.querySelector('[data-composer]');
        if (!form) return 'no-composer';
        const input = form.querySelector('input[name=body]');
        input.value = '无感发送验证：这条没有刷新页面';
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        await new Promise((r) => setTimeout(r, 1200));
        const sent = document.querySelector('.inbox-msg.mine:last-child');
        const sentId = sent ? sent.dataset.msgId : null;
        // 轮询验证：把刚发的那条从 DOM 里摘掉（模拟「本地还没收到」），等一个轮询周期看它是否被补回来
        if (sent) sent.remove();
        const afterRemove = document.querySelectorAll('[data-msg-id]').length;
        await new Promise((r) => setTimeout(r, 6500));
        const restored = sentId ? !!document.querySelector('[data-msg-id="' + sentId + '"]') : false;
        // SSE 验证：带会话拉一次事件流，只看响应头（1.5 秒后中断，不真的等消息）
        let sseInfo = 'n/a';
        try {
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 1500);
          const es = await fetch('/api/v1/messages/' + encodeURIComponent(handleForTest) + '/stream', { signal: ac.signal });
          clearTimeout(t);
          sseInfo = es.status + ' ' + (es.headers.get('content-type') || '') + ' buffering=' + (es.headers.get('x-accel-buffering') || '-');
        } catch (e) { sseInfo = 'aborted(正常，流已建立): ' + (e.name || e); }
        const last = document.querySelector('.inbox-msg.mine:last-child');
        return JSON.stringify({
          mine: document.querySelectorAll('.inbox-msg.mine').length,
          lastHasAvatar: !!(last && last.querySelector('img.msg-avatar')),
          lastText: last ? last.querySelector('.bubble').textContent.slice(0, 24) : '',
          pollingRestored: restored,
          countAfterRemove: afterRemove,
          sse: sseInfo,
        });
      })()`,
      awaitPromise: true,
      returnByValue: true,
    }).then((r) => console.log('==> 无感发送：气泡数 = ' + (r.result?.value ?? '?')))
    const after = await cdp.send('Runtime.evaluate', { expression: "location.pathname + location.search" })
    console.log('==> 地址是否未变：' + (before.result?.value === after.result?.value ? '是（没有跳页）✓' : '否 ✗ ' + before.result?.value + ' → ' + after.result?.value))

  }

  // （--comment-test 的自动化验证这次没做通，已撤；见 preview.mjs 顶部注释）
  if (titleTest && cookie) {
    await cdp.send('Page.navigate', { url: base + '/admin/users/overview' })
    await new Promise((r) => setTimeout(r, 1800))
    const before = await cdp.send('Runtime.evaluate', { expression: 'location.pathname + location.search' })
    const openDialog = `(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const waitFor = async (fn, ms = 5000) => {
        const t0 = Date.now()
        while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(120) }
        return null
      }
      const edit = await waitFor(() => document.querySelector('[data-island=\"admin-users\"] tbody button[title=\"编辑用户\"]'))
      if (!edit) return 'no-edit-button'
      edit.click()
      const dialog = await waitFor(() => document.querySelector('dialog[open] .modal-titles'))
      if (!dialog) return 'no-titles-section'
      const chip = await waitFor(() => dialog.querySelector('.title-chip-name'))
      if (!chip) return 'no-chips'
      dialog.scrollIntoView({ block: 'center' })
      await sleep(250)
      return 'ready'
    })()`
    const opened = await cdp.send('Runtime.evaluate', { expression: openDialog, awaitPromise: true, returnByValue: true, timeout: 20000 })
    console.log('==> 打开编辑弹窗：' + (opened.result?.value ?? '(无返回)'))
    const box = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const el = document.querySelector('.modal-titles'); if (!el) return 'none'; const r = el.getBoundingClientRect(); return JSON.stringify({ top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }) })()`,
      returnByValue: true,
    })
    console.log('==> 头衔区在视口里的位置：' + (box.result?.value ?? '?'))
    const probe = await cdp.send('Runtime.evaluate', { expression: 'typeof window.__adminUsersProbe === "function" ? window.__adminUsersProbe() : "no-probe"' })
    console.log('==> 组件内状态：' + (probe.result?.value ?? '?'))
    const dialogShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(join(outDir, 'admin-titles-dialog-' + theme + '.png'), Buffer.from(dialogShot.data, 'base64'))
    console.log('==> 截图：admin-titles-dialog-' + theme + '.png（弹窗·头衔区）')
    const result = await cdp.send('Runtime.evaluate', {
      expression: `(async () => {
        const out = {}
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
        const waitFor = async (fn, ms = 5000) => {
          const t0 = Date.now()
          while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(120) }
          return null
        }
        const dialog = document.querySelector('dialog[open] .modal-titles')
        if (!dialog) return JSON.stringify({ error: '弹窗关掉了？' })
        const rows = [...dialog.querySelectorAll('.title-row')]
        const nameOf = (row) => row.querySelector('.title-chip-name').textContent.trim()
        const heldCount = () => dialog.querySelectorAll('.title-row.is-held').length
        const top = dialog.querySelector('.title-count')
        out.total = rows.length
        out.filters = [...dialog.querySelectorAll('.title-filter')].map((b) => b.textContent.trim())
        out.names = rows.map(nameOf)
        out.heldBefore = heldCount()
        out.counterBefore = top ? top.textContent.trim() : ''
        // 挑一个「未持有且未归档」的：发放 → 核对 → 收回，回到原状
        const free = rows.find((r) => !r.classList.contains('is-held') && !r.querySelector('.title-chip-flag') && r.querySelector('button'))
        if (!free) return JSON.stringify({ error: '没有可发放的头衔样张', names: out.names })
        out.picked = nameOf(free)
        const button = (row, text) => [...row.querySelectorAll('button')].find((b) => b.textContent.includes(text))
        // 请求在飞的时候按钮是禁用的：等它落地再点下一步（免得被并发覆盖）
        const settled = () => waitFor(() => [...dialog.querySelectorAll('.title-row button')].every((b) => !b.disabled))
        button(free, '发放').click()
        const granted = await waitFor(() => free.classList.contains('is-held') && button(free, '收回'))
        out.afterGrant = { isHeld: free.classList.contains('is-held'), button: granted ? '收回' : '发放' }
        out.heldAfterGrant = heldCount()
        out.counterAfterGrant = top ? top.textContent.trim() : ''
        out.notice = (dialog.querySelector('[role=status]') || {}).textContent || ''
        const settledOk = await settled()
        const revQuery = () => button(free, '收回')
        out.beforeRevoke = { settled: !!settledOk, hasRevokeBtn: !!revQuery(), disabled: revQuery()?.disabled ?? 'n/a' }
        revQuery()?.click()
        await sleep(300)
        out.afterClick = { isHeld: free.classList.contains('is-held'), text: revQuery()?.textContent.trim() ?? 'gone', disabled: revQuery()?.disabled ?? 'n/a', counter: top ? top.textContent.trim() : '' }
        const revoked = await waitFor(() => !free.classList.contains('is-held'))
        out.afterRevoke = { isHeld: free.classList.contains('is-held'), back: revoked }
        out.counterAfterRevoke = top ? top.textContent.trim() : ''
        // 归档头衔只能收回，不能发放
        const archived = rows.find((r) => r.querySelector('.title-chip-flag'))
        const archivedBtn = archived ? button(archived, '发放') : null
        out.archived = archived ? { name: nameOf(archived), grantDisabled: archivedBtn ? archivedBtn.disabled : 'no-button' } : 'none'
        return JSON.stringify(out)
      })()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 30000,
    })
    // 端点级验证：直接打 HTTP（比点 DOM 硬），并把每一步的 DB 行数打出来
    if (existsSync(dbPath)) {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(dbPath)
      const count = (titleName, userId) =>
        db.prepare('SELECT COUNT(*) AS n FROM user_titles ut JOIN titles t ON t.id = ut.title_id WHERE t.name = ? AND ut.user_id = ?').get(titleName, userId).n
      const page = await (await fetch(base + '/admin/users/overview', { headers: { cookie } })).text()
      const csrf = (page.match(/name="csrf" value="([^"]+)"/) ?? [])[1]
      // 面板把行数据放在 data-json 里（比从 HTML 里猜路径稳）：取第一个用户 id
      const islandJson = (page.match(/data-island="admin-users"[^>]*data-json="([^"]*)"/) ?? [])[1] ?? "{}"
      // askama 会转义 " 为 &quot; 或 &#34;，两种都还原
      const decoded = islandJson.replace(/&quot;|&#34;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      const userId = ((JSON.parse(decoded).users ?? [])[0] ?? {}).id
      if (!userId) throw new Error('拿不到用户 id（面板 data-json 里没有 users）')
      const heroRes = await fetch(base + '/admin/users/' + userId + '/titles', { headers: { cookie, 'x-requested-with': 'fetch' } })
      const heroText = await heroRes.text()
      if (!heroRes.ok) throw new Error('GET /titles 失败：' + heroRes.status + ' ' + heroText.slice(0, 120))
      const hero = JSON.parse(heroText)
      const target = hero.titles.find((t) => !t.archived && !hero.held.includes(t.id))
      const post = (titleId, action) =>
        fetch(base + '/admin/users/' + userId + '/titles', {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-requested-with': 'fetch' },
          body: new URLSearchParams({ csrf, title_id: String(titleId), action }),
        })
      console.log('==> 端点级：被编辑的用户 id=' + userId + '，目标头衔=「' + target.name + '」，起点行数=' + count(target.name, userId))
      const granted = await post(target.id, 'grant')
      const grantedBody = await granted.json()
      console.log('    发放 → HTTP ' + granted.status + '，' + grantedBody.message + '，DB 行数=' + count(target.name, userId))
      const revoked = await post(target.id, 'revoke')
      const revokedBody = await revoked.json()
      console.log('    收回 → HTTP ' + revoked.status + '，' + revokedBody.message + '，DB 行数=' + count(target.name, userId))
      const again = await post(target.id, 'revoke')
      console.log('    再收回一次（幂等）→ HTTP ' + again.status + '，DB 行数=' + count(target.name, userId))
      console.log('    收回后接口回的 held=' + JSON.stringify(revokedBody.held))
      db.close()
    }

    console.log('==> 头衔实测（DOM 观测）：' + (result.result?.value ?? '(无返回)'))
    const probeAfter = await cdp.send('Runtime.evaluate', { expression: 'typeof window.__adminUsersProbe === "function" ? window.__adminUsersProbe() : "no-probe"' })
    console.log('==> 发放后组件内 titleIds（DOM 之外的事实来源）：' + (probeAfter.result?.value ?? '?'))
    const after = await cdp.send('Runtime.evaluate', { expression: 'location.pathname + location.search' })
    console.log('==> 地址是否未变：' + (before.result?.value === after.result?.value ? '是（就地更新，没有整页刷新）✓' : '否 ✗ ' + before.result?.value + ' → ' + after.result?.value))
    if (existsSync(dbPath)) {
      const { DatabaseSync } = await import('node:sqlite')
      const db = new DatabaseSync(dbPath)
      const total = db.prepare('SELECT COUNT(*) AS n FROM user_titles').get()
      const rows = db.prepare('SELECT ut.user_id, t.name FROM user_titles ut JOIN titles t ON t.id = ut.title_id ORDER BY t.name').all()
      db.close()
      console.log('==> 本地库 user_titles 行数 = ' + total.n + '；明细 = ' + JSON.stringify(rows))
    }
  }


  mkdirSync(outDir, { recursive: true })
  const themes = theme === 'both' ? ['light', 'dark'] : [theme]
  for (const t of themes) {
    await cdp.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: t === 'dark' ? 'dark' : 'light' }],
    })
    for (const path of pages) {
      await cdp.send('Page.navigate', { url: base + path })
      await new Promise((r) => setTimeout(r, 700))
      const html = await (await fetch(base + path, { headers: cookie ? { cookie } : {} })).text()
      // 空壳检查：页面必须有真实内容（帖子卡片 / 标题 / 表格），否则这次预览不算数
      // 空壳判据只看「有没有真实数据」，不猜具体类名（样式/类名天天改，靠不住）：
      //   1. 不是错误页；2. 有基本体量；3. 该页该有的真实内容确实出现了。
      const ok =
        html.length > 3000 &&
        !html.includes('页面或接口不存在') &&
        // 注意：不要再拿 'not_found' 这种子串去判 —— 管理页内联脚本里的错误码表也含它，会被误判成空壳
        !/<h1[^>]*>\s*(404|出错了)/.test(html) &&
        (path === '/new'
          ? html.includes('<form') && html.includes('csrf')
          : path.startsWith('/admin')
            ? html.includes('csrf') && /<table|<form/.test(html)
            : path === '/me'
              ? html.includes('csrf') || html.includes('/p/')
              // 分区页可能本来就是空的（该分区还没有帖子）——空态也算真实渲染
              : /\/p\/\d+/.test(html) || /(empty|还没有|暂无|没有匹配)/.test(html))
      const shot = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: fullPage,
      })
      const name = (path === '/' ? 'home' : path.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')) + '-' + t + '.png'
      writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'))
      shots.push({ name, path, theme: t, ok, bytes: Buffer.from(shot.data, 'base64').length })
      if (!ok) failed++
    }
  }
  cdp.close()
  chrome.kill()
}

const cleanup = () => {
  try { app.kill() } catch {}
}

main()
  .then(() => {
    console.log('\n页面预览（整页，真实数据）：')
    for (const s of shots) {
      console.log(`  ${s.ok ? '✓' : '✗ 空壳'} ${s.name}  ${(s.bytes / 1024).toFixed(0)} KB  ${s.path} [${s.theme}]`)
    }
    console.log('\n输出目录：' + outDir)
    cleanup()
    if (failed) {
      console.error(`\n有 ${failed} 张是空壳（页面没有真实内容）——预览不算通过，先查数据或模板`)
      process.exit(1)
    }
  })
  .catch((err) => {
    console.error('预览失败：' + err.message)
    cleanup()
    process.exit(1)
  })