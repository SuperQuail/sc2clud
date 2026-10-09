import { authTarget } from './auth-urls'

type Mode = 'login' | 'register'

function setup(dialog: HTMLDialogElement) {
  const home = document.querySelector<HTMLAnchorElement>('.home-brand, .topbar .brand')?.getAttribute('href')
  const title = dialog.querySelector<HTMLElement>('#auth-dialog-title')!
  const subtitle = dialog.querySelector<HTMLElement>('#auth-dialog-subtitle')!
  const status = dialog.querySelector<HTMLElement>('#auth-status')!
  const forms = { login: dialog.querySelector<HTMLFormElement>('#auth-panel-login')!, register: dialog.querySelector<HTMLFormElement>('#auth-panel-register')! }
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  if (!home || !authTarget(forms.login.action, home, location.origin) || !authTarget(forms.register.action, home, location.origin)) return
  const homeHref = home
  let mode: Mode = 'login'
  let opener: HTMLElement | null = null
  let controller: AbortController | null = null
  let styles: Promise<void> | null = null
  let opening = 0
  let closing = false
  let busy = false

  function ensureStyles() {
    if (!styles) {
      styles = new Promise<void>((resolve, reject) => {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        // 从当前脚本地址推导，天然保留代理路径前缀；首屏不下载弹窗 CSS。
        const cssName = '../' + 'auth.css?v=20261009-art-v7'
        link.href = new URL(cssName, import.meta.url).href
        link.onload = () => resolve()
        link.onerror = () => { link.remove(); styles = null; reject(new Error('弹窗样式加载失败')) }
        document.head.append(link)
      })
    }
    return styles
  }

  function message(text: string, success = false) {
    status.textContent = text
    status.hidden = !text
    status.dataset.success = String(success)
  }

  function setMode(next: Mode) {
    mode = next
    dialog.dataset.mode = mode
    message('')
    title.textContent = mode === 'login' ? '欢迎回到星际社区' : '让你的热爱被看见'
    subtitle.textContent = mode === 'login' ? '与同样热爱星际的人，再次相遇。' : '创建一个账号，开启你的社区故事。'
    for (const key of ['login', 'register'] as const) {
      forms[key].hidden = key !== mode
      const tab = dialog.querySelector<HTMLButtonElement>(`#auth-tab-${key}`)!
      tab.setAttribute('aria-selected', String(key === mode))
      tab.tabIndex = key === mode ? 0 : -1
    }
    if (dialog.open && !reducedMotion.matches) {
      forms[mode].animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' })
    }
  }

  function setBusy(value: boolean) {
    busy = value
    for (const form of Object.values(forms)) {
      const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!
      submit.disabled = value
      submit.setAttribute('aria-busy', String(value))
      submit.querySelector('span')!.textContent = value ? '正在提交…' : form === forms.login ? '登录社区' : '加入星际社区'
    }
    dialog.querySelectorAll<HTMLButtonElement>('[data-auth-mode]').forEach(button => { button.disabled = value })
  }

  function clearPasswords() {
    dialog.querySelectorAll<HTMLInputElement>('input[name="password"]').forEach(input => { input.value = ''; input.type = 'password' })
    dialog.querySelectorAll<HTMLButtonElement>('[data-auth-password]').forEach(button => { button.setAttribute('aria-pressed', 'false'); button.setAttribute('aria-label', '显示口令') })
  }

  function close() {
    opening++
    if (!dialog.open || closing) return
    closing = true
    controller?.abort()
    controller = null
    setBusy(false)
    clearPasswords()
    dialog.classList.remove('is-visible')
    const finish = () => {
      if (!closing) return
      dialog.close()
      document.documentElement.classList.remove('auth-modal-open')
      closing = false
      opener?.focus({ preventScroll: true })
    }
    if (reducedMotion.matches) finish()
    else {
      const timer = window.setTimeout(finish, 340)
      dialog.addEventListener('transitionend', event => { if (event.target === dialog && event.propertyName === 'opacity') { clearTimeout(timer); finish() } }, { once: true })
    }
  }

  async function open(next: Mode, source: HTMLAnchorElement) {
    const token = ++opening
    try { await ensureStyles() } catch { if (token === opening) location.assign(source.href); return }
    if (token !== opening || closing) return
    opener = source
    setMode(next)
    if (!dialog.open) {
      document.documentElement.classList.add('auth-modal-open')
      dialog.showModal()
      requestAnimationFrame(() => requestAnimationFrame(() => { if (dialog.open && !closing) dialog.classList.add('is-visible') }))
    }
    forms[mode].querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
  }

  dialog.querySelector('.auth-modal-close')!.addEventListener('click', close)
  dialog.addEventListener('cancel', event => { event.preventDefault(); close() })
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Tab') return
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))
      .filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (!first || !last) return
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  })
  let startedOnBackdrop = false
  const outside = (event: PointerEvent | MouseEvent) => { const bounds = dialog.getBoundingClientRect(); return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom }
  dialog.addEventListener('pointerdown', event => { startedOnBackdrop = event.target === dialog && outside(event) })
  dialog.addEventListener('click', event => { if (startedOnBackdrop && event.target === dialog && outside(event)) close(); startedOnBackdrop = false })
  dialog.querySelectorAll<HTMLButtonElement>('[data-auth-mode]').forEach(button => {
    button.addEventListener('click', () => { if (!busy) setMode(button.dataset.authMode as Mode) })
    if (button.getAttribute('role') === 'tab') button.addEventListener('keydown', event => {
      if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      setMode(event.key === 'Home' ? 'login' : event.key === 'End' ? 'register' : mode === 'login' ? 'register' : 'login')
      dialog.querySelector<HTMLButtonElement>(`#auth-tab-${mode}`)!.focus()
    })
  })
  dialog.querySelectorAll<HTMLButtonElement>('[data-auth-password]').forEach(button => {
    button.addEventListener('click', () => {
      const input = button.parentElement!.querySelector<HTMLInputElement>('input')!
      const visible = input.type === 'password'
      input.type = visible ? 'text' : 'password'
      button.setAttribute('aria-pressed', String(visible))
      button.setAttribute('aria-label', visible ? '隐藏口令' : '显示口令')
    })
  })

  for (const form of Object.values(forms)) form.addEventListener('submit', async event => {
    event.preventDefault()
    if (busy || closing) return
    const target = authTarget(form.action, homeHref, location.origin)
    if (!target) return
    const body = new URLSearchParams()
    new FormData(form).forEach((value, key) => { if (typeof value === 'string') body.set(key, value) })
    const request = new AbortController()
    controller = request
    setBusy(true)
    message('')
    try {
      const response = await fetch(target.action, { method: 'POST', body, headers: { Accept: 'application/json' }, credentials: 'same-origin', redirect: 'error', signal: request.signal })
      const data = await response.json() as { ok?: boolean; message?: string; needs_activation?: boolean }
      if (controller !== request || !dialog.open || closing) return
      if (!response.ok || data.ok !== true) {
        message(typeof data.message === 'string' ? data.message : '暂时无法完成请求，请稍后重试。')
        form.querySelector<HTMLInputElement>('input[name="password"]')!.value = ''
        return
      }
      clearPasswords()
      if (target.mode === 'register' && data.needs_activation === true) {
        setMode('login')
        forms.login.querySelector<HTMLInputElement>('input[name="account"]')!.value = body.get('handle') || ''
        message('账号已创建！现在可以登录，发帖与上传需要管理员激活。', true)
        forms.login.querySelector<HTMLInputElement>('input[name="password"]')!.focus()
      } else {
        message('登录成功，正在回到当前页面…', true)
        location.reload()
      }
    } catch {
      if (!request.signal.aborted && controller === request) message('连接暂时中断，请检查网络后重试。')
    } finally {
      if (controller === request) { controller = null; setBusy(false) }
    }
  })
  return open
}

const host = document.querySelector<HTMLElement>('#auth-dialog-host')
const home = document.querySelector<HTMLAnchorElement>('.home-brand, .topbar .brand')?.getAttribute('href')
if (host && home && typeof HTMLDialogElement.prototype.showModal === 'function') {
  const base = new URL(home, location.origin)
  let ready: Promise<NonNullable<ReturnType<typeof setup>>> | null = null
  let latest = 0
  document.addEventListener('click', async event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]')
    if (!link || (link.target && link.target !== '_self') || link.hasAttribute('download')) return
    const target = authTarget(link.href, home, location.origin)
    if (!target) return
    event.preventDefault()
    const token = ++latest
    if (!ready) ready = (async () => {
      const response = await fetch(new URL('auth/dialog', base), { credentials: 'same-origin', redirect: 'error' })
      if (!response.ok) throw new Error('弹窗暂时无法加载')
      const fragment = new DOMParser().parseFromString(await response.text(), 'text/html')
      const dialog = fragment.querySelector<HTMLDialogElement>('#auth-dialog')
      if (!dialog) throw new Error('弹窗内容缺失')
      // 兼容代理是否改写片段中的资源地址，只允许本项目的静态路径。
      dialog.querySelectorAll<HTMLImageElement>('img[src]').forEach(image => {
        const source = image.getAttribute('src')!
        if (source.startsWith('/static/')) image.src = new URL(source.slice(1), base).href
      })
      for (const mode of ['login', 'register']) dialog.querySelector<HTMLFormElement>(`#auth-panel-${mode}`)!.action = new URL(mode, base).href
      host.replaceChildren(document.adoptNode(dialog))
      const open = setup(dialog)
      if (!open) throw new Error('弹窗登录路径无效')
      return open
    })()
    try { const open = await ready; if (token === latest) await open(target.mode, link) }
    catch { ready = null; if (token === latest) location.assign(link.href) }
  })
}
