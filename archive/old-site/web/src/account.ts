// 账户菜单沿用原有链接与退出表单；没有脚本时 details 仍可展开。
const menu = document.querySelector<HTMLDetailsElement>('[data-account-menu]')
if (menu) {
  const trigger = menu.querySelector<HTMLElement>('summary')!
  const close = (restoreFocus = false) => { menu.open = false; if (restoreFocus) trigger.focus() }
  const panel = menu.querySelector<HTMLElement>('.account-panel')!
  const positionPanel = () => {
    if (!menu.open) return
    panel.style.right = '0px'
    const rect = panel.getBoundingClientRect()
    const shift = rect.left < 14 ? rect.left - 14 : Math.max(0, rect.right - window.innerWidth + 14)
    panel.style.right = `${shift}px`
    panel.style.maxHeight = `${Math.max(48, window.innerHeight - trigger.getBoundingClientRect().bottom - 28)}px`
  }
  menu.addEventListener('toggle', () => { trigger.setAttribute('aria-expanded', String(menu.open)); positionPanel() })
  window.addEventListener('resize', positionPanel)
  document.addEventListener('click', event => { if (event.target instanceof Node && !menu.contains(event.target)) close() })
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu.open) { event.preventDefault(); close(true) } })
  // focusout 到 focusin 之间 activeElement 会短暂变成 body，不能在此时关闭菜单。
  document.addEventListener('focusin', event => { if (event.target instanceof Node && !menu.contains(event.target)) close() })
  // 所有页面读取同一会话的头像；不会把个人主页主人的头像当成浏览者头像。
  const home = document.querySelector<HTMLAnchorElement>('.home-brand, .topbar .brand')?.getAttribute('href')
  if (home) {
    const base = new URL(home, location.origin)
    if (base.origin === location.origin) {
      void fetch(new URL('api/v1/me/avatar', base), { credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
        .then(async response => response.ok ? await response.json() as { avatar_hash?: string | null } : null)
        .then(data => {
          if (!data || !data.avatar_hash || !/^[a-f0-9]{64}$/.test(data.avatar_hash)) return
          const href = new URL(`avatar/${data.avatar_hash}`, base).href
          menu.querySelectorAll<HTMLImageElement>('[data-account-avatar]').forEach(image => { image.src = href })
        }).catch(() => { /* 网络失败时保留服务端头像或已有默认头像 */ })
    }
  }
}
