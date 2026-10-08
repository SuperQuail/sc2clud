// 管理面板的异步提交。
//
// 目标：改预算 / 改显示名 / 改等级 / 激活停用 / 添加用户，**都不刷新整页**——
// 只就地更新受影响的单元格与总览，避免编辑时页面跳动、滚动位置丢失。
// 没有 JS 时表单照旧 POST + 跳转（服务端两条路都支持）。

const NOTE_CLASS = 'form-note'

function note(form: HTMLFormElement, text: string, ok: boolean) {
  let el = form.querySelector<HTMLElement>('[data-note]')
  if (!el) {
    el = document.createElement('span')
    el.dataset.note = ''
    el.className = NOTE_CLASS
    form.appendChild(el)
  }
  el.textContent = text
  el.classList.toggle('ok', ok)
  el.classList.toggle('err', !ok)
  window.setTimeout(() => {
    if (el) el.textContent = ''
  }, 2600)
}

function flash(el: Element | null, ok: boolean) {
  if (!el) return
  el.classList.remove('flash-ok', 'flash-err')
  void (el as HTMLElement).offsetWidth
  el.classList.add(ok ? 'flash-ok' : 'flash-err')
}

function humanBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function syncQuotaText(form: HTMLFormElement) {
  const input = form.querySelector<HTMLInputElement>('input[name="quota_gb"]')
  const cell = form.closest('.quota-cell')
  const label = cell?.querySelector<HTMLElement>('[data-quota-value]')
  if (!input || !label) return
  const gb = Number.parseFloat(input.value || '0')
  label.textContent = humanBytes(Math.max(0, gb) * 1024 * 1024 * 1024)
}

/// 只换掉数据区域，不整页刷新：用于新增用户、激活状态这类会改动多处的动作。
async function refreshRegions() {
  const res = await fetch(window.location.pathname + window.location.search, {
    headers: { 'x-requested-with': 'fetch' },
    credentials: 'same-origin',
  })
  if (!res.ok) return
  const html = await res.text()
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const id of ['pending', 'users', 'quota', 'backups']) {
    const fresh = doc.getElementById(id)
    const current = document.getElementById(id)
    if (fresh && current) {
      current.replaceWith(fresh)
    } else if (!fresh && current) {
      current.remove()
    }
  }
  bind()
}

async function submit(form: HTMLFormElement) {
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')
  const restore = button?.disabled ?? false
  if (button) button.disabled = true
  try {
    // 注意：不能直接发 FormData —— 那是 multipart/form-data，
    // 而 axum 的 Form 提取器只接受 application/x-www-form-urlencoded（会 415）。
    // 所以这里显式转成 URLSearchParams（多值字段也不会丢）。
    const payload = new URLSearchParams()
    new FormData(form).forEach((value, key) => {
      if (typeof value === 'string') payload.append(key, value)
    })
    const res = await fetch(form.action, {
      method: 'POST',
      body: payload,
      headers: {
        'x-requested-with': 'fetch',
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      credentials: 'same-origin',
    })
    const data = (await res.json().catch(() => ({}))) as { message?: string }
    if (!res.ok) {
      flash(form, false)
      note(form, data.message || `失败（${res.status}）`, false)
      return
    }
    flash(form, true)
    note(form, data.message || '已保存', true)

    const after = form.dataset.after
    if (after === 'quota') {
      syncQuotaText(form)
      await refreshRegions()
    } else if (after === 'name') {
      const name = (form.querySelector('input[name="display_name"]') as HTMLInputElement | null)?.value
      const cell = form.closest('tr')?.querySelector('[data-display-name]')
      if (name && cell) cell.textContent = name
    } else if (after === 'role') {
      const select = form.querySelector('select[name="role"]') as HTMLSelectElement | null
      const badge = form.closest('tr')?.querySelector<HTMLElement>('[data-role-badge]')
      if (select && badge) {
        badge.textContent = select.options[select.selectedIndex]?.text ?? badge.textContent
        badge.className = 'role-badge role-' + select.value
      }
    } else {
      await refreshRegions()
    }
  } catch (error) {
    flash(form, false)
    note(form, '网络错误：' + String(error), false)
  } finally {
    if (button) button.disabled = restore
  }
}

function bind() {
  for (const form of document.querySelectorAll<HTMLFormElement>('form[data-async]')) {
    if (form.dataset.bound === '1') continue
    form.dataset.bound = '1'
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      void submit(form)
    })
  }
}

bind()

// 站点可能挂在路径前缀下（测试实例是 /dev）。
// nginx 会给 HTML 里的链接补前缀，但 JS 里硬拼的路径不会，
// 所以这里按当前路径自己算一份。
const PREFIX = location.pathname.startsWith('/dev') ? '/dev' : ''

// ---------- 编辑用户弹窗（参考 Open WebUI 的 EditUserModal）----------
// 列表里点铅笔打开：预填当前值 → 改完点保存（等级也就地切换，不用跳页）。
const dialog = document.getElementById('user-dialog') as HTMLDialogElement | null
const userForm = document.getElementById('user-form') as HTMLFormElement | null

function field(id: string): HTMLInputElement | HTMLSelectElement | null {
  return document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null
}

document.addEventListener('click', (event) => {
  const target = event.target as HTMLElement
  if (target.closest('[data-modal-close]')) {
    dialog?.close()
    return
  }
  const trigger = target.closest<HTMLElement>('[data-edit-user]')
  if (!trigger || !dialog || !userForm) return
  const row = trigger.closest<HTMLElement>('[data-user-row]')
  if (!row) return
  const data = row.dataset
  const name = data.name ?? ''
  const head = document.getElementById('modal-name')
  if (head) head.textContent = name
  const handle = document.getElementById('modal-handle')
  if (handle) handle.textContent = '@' + (data.handle ?? '')
  const initial = document.getElementById('modal-initial')
  const avatar = document.getElementById('modal-avatar') as HTMLImageElement | null
  if (avatar && initial) {
    if (data.avatar) {
      avatar.src = PREFIX + '/avatar/' + data.avatar
      avatar.hidden = false
      initial.hidden = true
    } else {
      initial.textContent = data.initial || '?'
      initial.className = 'avatar-initial avatar-lg c' + (data.color ?? '0')
      initial.hidden = false
      avatar.hidden = true
    }
  }
  const role = field('modal-role')
  if (role) role.value = data.role ?? ''
  const display = field('modal-display')
  if (display) display.value = name
  const email = field('modal-email')
  if (email) email.value = data.email ?? ''
  const quota = field('modal-quota')
  if (quota) quota.value = data.quota ?? '0.0'
  const trusted = document.getElementById('modal-trusted') as HTMLInputElement | null
  if (trusted) trusted.checked = data.trusted === '1'
  const activated = document.getElementById('modal-activated') as HTMLInputElement | null
  if (activated) activated.checked = data.activated === '1'
  const password = field('modal-password')
  if (password) password.value = ''
  const more = document.getElementById('modal-more') as HTMLAnchorElement | null
  if (more) more.href = PREFIX + '/admin/users/' + (data.id ?? '')
  const hint = document.getElementById('modal-note')
  if (hint) {
    hint.textContent =
      data.isSelf === '1' ? '这是你自己的账号：不能改自己的等级，也不能停用。' : ''
  }
  userForm.action = PREFIX + '/admin/users/' + (data.id ?? '') + '/update'
  dialog.showModal()
})

// 异步提交成功后把弹窗关掉（提交本身仍由上面的 bind() 处理）
userForm?.addEventListener('submit', () => {
  window.setTimeout(() => dialog?.close(), 400)
})
