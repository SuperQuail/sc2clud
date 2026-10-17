// 首页只做渐进增强；搜索、排序、分页仍由 Rust 服务端处理。
import { setupHomeReader } from './home-reader'

const root = document.documentElement
const body = document.body
root.classList.add('home-enhanced')

const viewButtons = document.querySelectorAll<HTMLButtonElement>('[data-view-btn]')
function syncView() {
  const view = root.getAttribute('data-post-view') === 'list' ? 'list' : 'card'
  viewButtons.forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.viewBtn === view))
  })
}
viewButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const view = button.dataset.viewBtn === 'list' ? 'list' : 'card'
    root.setAttribute('data-post-view', view)
    try { localStorage.setItem('sc2clud-view', view) } catch { /* 存储禁用时仍然可切换 */ }
    syncView()
  })
})
syncView()

const sort = document.querySelector<HTMLSelectElement>('#home-sort')
sort?.addEventListener('change', () => sort.form?.requestSubmit())

const menu = document.querySelector<HTMLButtonElement>('.home-menu-toggle')
const sidebar = document.querySelector<HTMLElement>('#home-sidebar')
const narrow = window.matchMedia('(max-width: 1000px)')
function syncNavigation() {
  const open = narrow.matches ? body.classList.contains('home-nav-open') : !body.classList.contains('home-nav-collapsed')
  menu?.setAttribute('aria-expanded', String(open))
  menu?.setAttribute('aria-label', open ? '收起导航' : '展开导航')
}
function closeMobileNavigation() {
  body.classList.remove('home-nav-open')
  syncNavigation()
}
menu?.addEventListener('click', () => {
  body.classList.toggle(narrow.matches ? 'home-nav-open' : 'home-nav-collapsed')
  syncNavigation()
})
document.addEventListener('click', (event) => {
  if (narrow.matches && event.target instanceof Node && !sidebar?.contains(event.target) && !menu?.contains(event.target)) closeMobileNavigation()
})
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && body.classList.contains('home-nav-open')) {
    closeMobileNavigation()
    menu?.focus()
  }
})
narrow.addEventListener('change', () => {
  body.classList.remove('home-nav-collapsed')
  closeMobileNavigation()
  syncNavigation()
})
syncNavigation()

// 门户 / 论坛与卡片 / 列表是独立偏好，切回门户时保留原来的显示方式。
const layoutToggle = document.querySelector<HTMLButtonElement>('#layout-toggle')
function syncLayout() {
  const forum = root.getAttribute('data-home-layout') === 'forum'
  layoutToggle?.setAttribute('aria-pressed', String(forum))
  layoutToggle?.setAttribute('title', forum ? '返回门户布局' : '切换到论坛布局')
}
layoutToggle?.addEventListener('click', () => {
  const layout = root.getAttribute('data-home-layout') === 'forum' ? 'portal' : 'forum'
  root.setAttribute('data-home-layout', layout)
  try { localStorage.setItem('sc2clud-layout', layout) } catch { /* 存储不可用时仍可切换 */ }
  body.classList.remove('home-nav-open', 'home-nav-collapsed')
  syncNavigation()
  syncLayout()
  window.scrollTo({ top: 0, behavior: 'instant' })
})
syncLayout()

const densityToggle = document.querySelector<HTMLButtonElement>('.forum-density-toggle')
function syncDensity() {
  densityToggle?.setAttribute('aria-pressed', String(root.getAttribute('data-forum-density') === 'compact'))
}
try {
  if (localStorage.getItem('sc2clud-forum-density') === 'compact') root.setAttribute('data-forum-density', 'compact')
} catch { /* 使用默认摘要视图 */ }
densityToggle?.addEventListener('click', () => {
  const density = root.getAttribute('data-forum-density') === 'compact' ? 'expanded' : 'compact'
  root.setAttribute('data-forum-density', density)
  try { localStorage.setItem('sc2clud-forum-density', density) } catch { /* 保持当前选择 */ }
  syncDensity()
})
syncDensity()
setupHomeReader()

// 搜索框快捷键：不拦截输入控件中的文字。
document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
  const target = event.target
  if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return
  const input = document.querySelector<HTMLInputElement>('.home-search input[type="search"]')
  if (input) { event.preventDefault(); input.focus() }
})
