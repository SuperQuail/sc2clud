// 从已由反向代理改写的首页链接推导路径，不在应用里硬编码部署前缀。
export function readerUrl(href: string, home: string, origin: string, kind: 'post' | 'image'): string | null {
  try {
    const base = new URL(home, origin)
    const url = new URL(href, base)
    if (base.origin !== origin || url.origin !== origin || !base.pathname.endsWith('/')) return null
    if (url.search || url.hash || !url.pathname.startsWith(base.pathname)) return null
    const path = url.pathname.slice(base.pathname.length)
    const valid = kind === 'post' ? /^p\/\d+$/.test(path) : /^img\/[a-f0-9]{64}$/.test(path)
    return valid ? url.pathname : null
  } catch {
    return null
  }
}
