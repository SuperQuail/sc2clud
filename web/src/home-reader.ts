// 阅读面板只获取现有 SSR 详情；正文以 textContent 写入，不执行页面脚本。
import { readerUrl } from './home-urls'

export function setupHomeReader() {
  const reader = document.querySelector<HTMLDialogElement>('.forum-reader')
  const posts = Array.from(document.querySelectorAll<HTMLElement>('.home-post[data-post-url]'))
  if (!reader || !posts.length) return
  const home = document.querySelector<HTMLAnchorElement>('.home-brand')?.getAttribute('href') ?? '/'
  const title = reader.querySelector<HTMLElement>('#forum-reader-title')!
  const meta = reader.querySelector<HTMLElement>('[data-reader-meta]')!
  const category = reader.querySelector<HTMLElement>('[data-reader-category]')!
  const content = reader.querySelector<HTMLElement>('.forum-reader-content')!
  const body = reader.querySelector<HTMLElement>('[data-reader-body]')!
  const images = reader.querySelector<HTMLElement>('.forum-reader-images')!
  const status = reader.querySelector<HTMLElement>('.forum-reader-status')!
  const link = reader.querySelector<HTMLAnchorElement>('[data-reader-link]')!
  const previous = reader.querySelector<HTMLButtonElement>('[data-reader-prev]')!
  const next = reader.querySelector<HTMLButtonElement>('[data-reader-next]')!
  const position = reader.querySelector<HTMLElement>('[data-reader-position]')!
  const scroll = reader.querySelector<HTMLElement>('.forum-reader-scroll')!
  let index = 0
  let revision = 0
  let request: AbortController | undefined
  let returnFocus: HTMLElement | null = null

  async function openPost(target: number) {
    const post = posts[target]
    const href = post?.querySelector('h3 a')?.getAttribute('href')
    const url = href ? readerUrl(href, home, location.origin, 'post') : null
    if (!url) return
    index = target
    const current = ++revision
    request?.abort()
    const controller = new AbortController()
    request = controller
    title.textContent = post.querySelector('h3 a')?.textContent ?? '帖子预览'
    meta.textContent = post.querySelector('.home-post-meta')?.textContent ?? ''
    category.textContent = post.querySelector('.forum-post-channel')?.textContent ?? ''
    body.textContent = post.querySelector('.home-post-excerpt')?.textContent ?? ''
    images.replaceChildren()
    link.href = url
    position.textContent = `${target + 1} / ${posts.length}`
    previous.disabled = target === 0
    next.disabled = target === posts.length - 1
    status.textContent = '正在加载完整内容…'
    content.setAttribute('aria-busy', 'true')
    if (!reader!.open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      reader!.showModal()
      document.body.classList.add('reader-open')
    }
    scroll.scrollTop = 0
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(url, {
        headers: { Accept: 'text/html' },
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('详情不可用')
      const html = await response.text()
      if (current !== revision || !reader!.open) return
      const page = new DOMParser().parseFromString(html, 'text/html')
      const fullBody = page.querySelector('.post-body')
      if (!fullBody) throw new Error('详情不可用')
      category.textContent = (post.querySelector('.forum-post-channel')?.textContent ?? '') + (page.querySelector('[data-feature-badge]:not([hidden])') ? ' · 精华' : '')
      body.textContent = fullBody.textContent
      page.querySelectorAll<HTMLImageElement>('.gallery img').forEach((source) => {
        const imageUrl = readerUrl(source.getAttribute('src') ?? '', home, location.origin, 'image')
        if (!imageUrl) return
        const image = document.createElement('img')
        image.setAttribute('data-post-image', '')
        image.src = imageUrl
        image.alt = `${title.textContent}的配图`
        image.loading = 'lazy'
        images.append(image)
      })
      status.textContent = ''
    } catch {
      if (current === revision && reader!.open) {
        status.textContent = controller.signal.aborted
          ? '加载超时。你可以进入讨论页继续阅读。'
          : '暂时无法加载完整内容。你可以进入讨论页重试。'
      }
    } finally {
      window.clearTimeout(timeout)
      if (current === revision) content.setAttribute('aria-busy', 'false')
    }
  }

  posts.forEach((post, target) => {
    post.querySelector('.forum-preview-button')?.addEventListener('click', () => void openPost(target))
  })
  previous.addEventListener('click', () => { if (index > 0) void openPost(index - 1) })
  next.addEventListener('click', () => { if (index + 1 < posts.length) void openPost(index + 1) })
  reader.querySelector('[data-reader-close]')?.addEventListener('click', () => reader.close())
  reader.addEventListener('click', (event) => {
    const bounds = reader.getBoundingClientRect()
    if (event.target === reader && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) reader.close()
  })
  reader.addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); void openPost(index - 1) }
    if (event.key === 'ArrowRight' && index + 1 < posts.length) { event.preventDefault(); void openPost(index + 1) }
  })
  reader.addEventListener('close', () => {
    ++revision
    request?.abort()
    document.body.classList.remove('reader-open')
    content.setAttribute('aria-busy', 'false')
    body.textContent = ''
    images.replaceChildren()
    returnFocus?.focus({ preventScroll: true })
  })
}
