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
