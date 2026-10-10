// 只从本站已被代理改写的首页链接推导登录路径，避免向生产根路径或外站提交。
export function authTarget(href: string, home: string, origin: string): { mode: 'login' | 'register'; action: string } | null {
  try {
    const base = new URL(home, origin)
    const url = new URL(href, base)
    if (base.origin !== origin || url.origin !== origin || !base.pathname.endsWith('/')) return null
    if (url.search || url.hash || !url.pathname.startsWith(base.pathname)) return null
    const path = url.pathname.slice(base.pathname.length)
    return path === 'login' || path === 'register' ? { mode: path, action: url.pathname } : null
  } catch {
    return null
  }
}
