type ThemeMode = 'light' | 'dark' | 'system'
const root = document.documentElement
const media = window.matchMedia('(prefers-color-scheme: dark)')
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const modeButtons = document.querySelectorAll<HTMLButtonElement>('button[data-theme-mode]')
const toggle = document.querySelector<HTMLButtonElement>('#theme-toggle')
let requestedMode = (root.getAttribute('data-theme-mode') || 'system') as ThemeMode
let active: Animation | null = null
let shade: HTMLDivElement | null = null
let generation = 0
const isDark = (mode: ThemeMode) => mode === 'dark' || (mode === 'system' && media.matches)

function applyTheme(mode: ThemeMode, persist: boolean) {
  const dark = isDark(mode)
  root.setAttribute('data-theme', dark ? 'dark' : 'light')
  root.setAttribute('data-theme-mode', mode)
  modeButtons.forEach(button => button.classList.toggle('active', button.dataset.themeMode === mode))
  toggle?.setAttribute('aria-label', dark ? '切换到日间主题' : '切换到夜间主题')
  toggle?.setAttribute('title', dark ? '日间模式' : '夜间模式')
  if (persist) {
    try { localStorage.setItem('sc2clud-theme', mode) } catch { /* 浏览器禁用存储时仍能切换 */ }
  }
}

function clearFade() {
  active?.cancel()
  active = null
  shade?.remove()
  shade = null
}

function changeTheme(mode: ThemeMode, animate = true, persist = true) {
  requestedMode = mode
  const id = ++generation
  const interrupted = active !== null
  clearFade()
  // 先保存最后一次选择；退出页面时不必等待动画完成。
  if (persist) {
    try { localStorage.setItem('sc2clud-theme', mode) } catch { /* 浏览器禁用存储 */ }
  }
  if (!animate || interrupted || reducedMotion.matches || typeof root.animate !== 'function' ||
      root.getAttribute('data-theme') === (isDark(mode) ? 'dark' : 'light')) {
    applyTheme(mode, false)
    return
  }
  // 只淡入淡出一个纯色图层，不抓取页面快照，也不逐个重绘控件颜色。
  const layer = document.createElement('div')
  layer.className = 'theme-fade'
  layer.dataset.tone = isDark(mode) ? 'dark' : 'light'
  layer.setAttribute('aria-hidden', 'true')
  document.body.append(layer)
  shade = layer
  active = layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 90, easing: 'ease-out', fill: 'forwards' })
  void active.finished.then(() => {
      if (id !== generation) return
      applyTheme(mode, false)
      active = layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, easing: 'ease-in', fill: 'forwards' })
      return active.finished
  }).catch(() => { /* 连续点击取消旧动画时，不让旧回调覆盖新主题 */ }).finally(() => {
    if (id === generation) clearFade()
  })
}

applyTheme(requestedMode, false)
toggle?.addEventListener('click', () => changeTheme(isDark(requestedMode) ? 'light' : 'dark'))
modeButtons.forEach(button => button.addEventListener('click', () => changeTheme(button.dataset.themeMode as ThemeMode)))
const onSystemChange = () => { if (requestedMode === 'system') changeTheme('system', false, false) }
if (media.addEventListener) media.addEventListener('change', onSystemChange)
else media.addListener(onSystemChange)
reducedMotion.addEventListener?.('change', () => { if (reducedMotion.matches) changeTheme(requestedMode, false, false) })
