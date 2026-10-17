// dev 实例挂在 /dev/ 前缀下（nginx sub_filter 只改 HTML，改不到 JS 里的字符串），
// 所以岛里的所有绝对路径都要由当前地址推导前缀，否则 dev 上的请求会打到生产入口（401）。

export function basePath(): string {
  const matched = location.pathname.match(/^(.+?)\/p\/\d+/)
  return matched ? matched[1] : ''
}

export function appUrl(path: string): string {
  return `${basePath()}${path}`
}
