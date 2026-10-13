import { BASE } from './base';

// **全站唯一的 URL 构造入口**。任何「去哪」和「取什么资源」都必须经过这里。
// 为什么：同一份产物要同时在 / 与 /dev/ 两个前缀下跑，路径写死或各写各的相对路径就会各坏各的。
// 踩过的账：导航用了绝对路径 → 从 dev 跳到了生产端；图片用本地 'art/' helper → 一旦换前缀就 404。
export function appPath(path = ''): string {
  const url = new URL(path, new URL(BASE, location.origin));
  return url.pathname + url.search + url.hash;
}

// 静态资源（public/ 下的东西，构建时原样拷进产物根）
export function assetUrl(file: string): string {
  return appPath('art/' + file.replace(/^\/+/, ''));
}

// 给 react-router 的 <Link to> / useNavigate() / ?next= 参数用：**basename 相对**的路径。
//
// 为什么不能用 appPath()：react-router 会把 basename **前置**到绝对的 to 上，
// 而 appPath() 返回的路径已经含 BASE 前缀 —— 于是在 dev（basename=/dev）下，
// 把 appPath() 的结果直接交给 <Link to>，会变成 /dev/dev/b/x（2026-10-13 用户实测「点分区路径有两个 dev」）。
// BASE=/ 时看不出来，所以这个 bug 只在 dev 暴露。
//
// 规则：**<a href> 用 appPath()；react-router 的 to/navigate/next 用 routePath()。**
export function routePath(p = ''): string {
  const full = appPath(p);
  const base = BASE.endsWith('/') ? BASE.slice(0, -1) : BASE; // '/dev/' -> '/dev'，'/' -> ''
  if (base !== '' && (full === base || full.startsWith(base + '/'))) return full.slice(base.length) || '/';
  return full;
}
