import { afterEach, expect, it, vi } from 'vitest';

// BASE 是**模块加载时**从 <base href> 读的，所以每条用例都换 base 再重新 import。
// 这一条盯的是 dev 实测报过的那个 404：后端给的 go_path 是根路径绝对地址（/api/v1/…），
// 而 URL('/api/v1/x', '/dev/') 解析出来不带 /dev —— 点下去就出了站。
async function withBase(href: string) {
  vi.resetModules();
  document.head.innerHTML = '<base href="' + href + '">';
  return await import('./url');
}

afterEach(() => {
  document.head.innerHTML = '';
  vi.resetModules();
});

it('appPath：站根绝对地址（后端 go_path / 通知 link）要跟到 BASE 下，不能丢前缀', async () => {
  const { appPath } = await withBase('/dev/');
  expect(appPath('/api/v1/topics/t1/sources/s1/go')).toBe('/dev/api/v1/topics/t1/sources/s1/go');
  // 已经写对的相对写法不能因此变成 /dev/dev/…
  expect(appPath('api/v1/x')).toBe('/dev/api/v1/x');
  expect(appPath('t/abc')).toBe('/dev/t/abc');
  expect(appPath('')).toBe('/dev/');
  expect(appPath('?page=12-topic')).toBe('/dev/?page=12-topic');
});

it('imagePath：后端下发的 /img/<hash> 要落到本实例前缀下，外链/blob/已带前缀的原样', async () => {
  const { imagePath } = await withBase('/dev/');
  // dev 实测：<img src="/img/8bec…"> 会去根实例要图，那儿回的是 SPA 的 HTML（用户报的「头像丢失」）
  expect(imagePath('/img/8bec38b0')).toBe('/dev/img/8bec38b0');
  expect(imagePath('img/8bec38b0')).toBe('/dev/img/8bec38b0');
  // mappers.imageUrl 已经拼过前缀的不能再拼一次
  expect(imagePath('/dev/img/8bec38b0')).toBe('/dev/img/8bec38b0');
  // 上传前的本地预览与站外链接不受影响
  expect(imagePath('blob:http://localhost/9f2')).toBe('blob:http://localhost/9f2');
  expect(imagePath('https://example.com/a.png')).toBe('https://example.com/a.png');
});

it('appPath：生产（BASE=/）下保持原样', async () => {
  const { appPath } = await withBase('/');
  expect(appPath('/api/v1/x')).toBe('/api/v1/x');
  expect(appPath('t/abc')).toBe('/t/abc');
});
