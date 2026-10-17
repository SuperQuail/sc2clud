import { BASE } from './base';

// **全站唯一的 URL 构造入口**。任何「去哪」和「取什么资源」都必须经过这里。
// 为什么：同一份产物要同时在 / 与 /dev/ 两个前缀下跑，路径写死或各写各的相对路径就会各坏各的。
// 踩过的账：导航用了绝对路径 → 从 dev 跳到了生产端；图片用本地 'art/' helper → 一旦换前缀就 404。
export function appPath(path = ''): string {
  // **前导斜杠要吃掉**：URL('/api/v1/x', base) 解析出来是**站根**路径，BASE 前缀被丢掉 ——
  // 后端给的 go_path（'/api/v1/topics/…/sources/…/go'）与通知里的 link 都是这种形状，
  // 在 /dev/ 下点它就跳到站外 /api/v1/…（404）。约定：传进来的一律当「站点相对」。
  const url = new URL(path.replace(/^\/+/, ''), new URL(BASE, location.origin));
  return url.pathname + url.search + url.hash;
}

// 后端把图片地址当**完整路径**下发（media/dto.go 的 urlOf → '/img/<hash>'），但它是**站根**路径：
// 在 /dev/ 下 <img src="/img/…"> 会去根实例要图（那儿返回的是 SPA 的 HTML，浏览器判定为坏图）——
// 2026-10-14 用户报的「头像丢失」就是这个。凡是把后端 URL 直接当 src 的地方都过这一层。
// 外链 / blob: / data:（上传前的本地预览）与已经带 BASE 前缀的都原样返回。
export function imagePath(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const base = BASE.endsWith('/') ? BASE.slice(0, -1) : BASE;
  if (base !== '' && (url === base || url.startsWith(base + '/'))) return url;
  return appPath(url);
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
