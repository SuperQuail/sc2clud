import { afterEach, describe, expect, it, vi } from 'vitest';
import { login, register, resetPassword, verifyEmail, verifyResetCode } from './auth';
import { mockFetch } from '@/test/fetch-mock';

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.innerHTML = '';
  vi.resetModules();
});
// ── D2（2026-10-14 实测：「顶栏右上角头像裂图，主页头像正常」）───────────────────────────────
//
// 根因不在前端渲染：两条 URL 的**来源不同**。
//   · 主页：GET /users/{handle} → user.Profile.Avatar 走 media 的 urlOf() → `/img/<hash>`（完整路径）；
//   · 顶栏：GET /me → auth.MeResult.Avatar = deref(u.AvatarHash)（forum/internal/auth/account.go:507）——
//     **裸哈希**，既没有 /img/ 前缀，也没有 media/avatar.go:14-22 那段默认头像回落。
// 于是 fetchMe 里那层「补 base」（auth.ts:34）在真数据上**没有生效对象**：补出来的是 /dev/<64位hex> → 404
// （真站实测：/dev/img/<hash> 是 webp，/dev/<hash> 不是图）。
//
// 这条用例是那份缺陷的可执行形态：**先红**。等后端把 /me 的 Avatar 交给 user.AvatarURL 拼成
// `/img/<hash>`（与 /users/{handle} 用同一份实现、同样回落默认头像池）之后，它自动转绿。
// 后半段同时钉住「不要重复补前缀」：已带 base 的值必须原样穿过。
it('D2：/me 的头像不许拼成 /dev/<hash>（裸哈希前端也要兜成 /img/<hash>）', async () => {
  // BASE 是模块加载时从 <base href> 读的，而缺陷只在 /dev/ 前缀下可见（生产 BASE=/ 时补不出来前缀），
  // 所以照 url.test.ts 的写法：先换 base、清模块，再动态 import。
  vi.resetModules();
  document.head.innerHTML = '<base href="/dev/">';
  const mod = await import('./auth');
  mockFetch([{ body: { data: { handle: 'Alenger', nickname: '爱兰琪尔', avatar: '8bec38b093bbc516c0de99f21466ede0d7cad56eddb1f5fabce3c475ec068604' } } }]);
  const now = await mod.fetchMe();
  // 判据是**形状**不是「含不含哈希」：修好之后 URL 里当然有那个哈希，关键是它带 /img/ 前缀。
  // 旧行为是 /dev/8bec38b0…（补了 base 但没补 /img/，浏览器按站点相对路径取 → 真站 404）。
  // 两层都钉：后端该发 /img/<hash>（契约），前端对裸哈希也要兜住（一个端点写错不该在界面上裂一张图）。
  const HASH = '8bec38b093bbc516c0de99f21466ede0d7cad56eddb1f5fabce3c475ec068604';
  expect(now?.avatar).toBe('/dev/img/' + HASH);
  expect(now?.avatar).not.toBe('/dev/' + HASH);

  // 后端**应该**下发的形状（= /users/{handle} 那一份：media 的 urlOf 拼过 /img/）
  mockFetch([{ body: { data: { handle: 'Alenger', nickname: '爱兰琪尔', avatar: '/img/8bec38b093bbc516c0de99f21466ede0d7cad56eddb1f5fabce3c475ec068604' } } }]);
  const ok = await mod.fetchMe();
  expect(ok?.avatar).toBe('/dev/img/8bec38b093bbc516c0de99f21466ede0d7cad56eddb1f5fabce3c475ec068604');
});


// 图形验证码是「id + answer」成对校验的（服务端按 id 找答案，无论对错都作废），
// 所以请求体里两个字段名都必须与后端契约逐字一致：captcha_id / captcha_answer。
// 这一条是被真站抓出来的：前端发的是 `captcha`，后端（handler.go 的 registerReq/loginReq）
// 读的是 `captcha_answer`，于是答案永远是空串 -> 一律 auth.captcha_required「请先填写验证码」，
// 而界面看起来完全正常。
describe('auth 请求体', () => {
  it('注册把验证码答案放在 captcha_answer', async () => {
    const { calls } = mockFetch([{ status: 201, body: { data: { handle: 'marine' } } }]);
    await register({ username: 'marine', nickname: '陆战队员', email: 'm@example.com', password: 'pw-123456', captcha: 'AB3D', captcha_id: 'cap-1' });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, string>;
    expect(body.captcha_answer).toBe('AB3D');
    expect(body.captcha_id).toBe('cap-1');
    expect(body).not.toHaveProperty('captcha');
  });

  it('登录把验证码答案放在 captcha_answer', async () => {
    const { calls } = mockFetch([{ body: { data: { id: 'u' } } }]);
    await login({ username: 'marine', password: 'pw-123456', captcha: 'AB3D', captcha_id: 'cap-1' });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, string>;
    expect(body.captcha_answer).toBe('AB3D');
    expect(body.captcha_id).toBe('cap-1');
    expect(body).not.toHaveProperty('captcha');
  });

  it('没有验证码时两个字段都不出现（游客模式 mode=off 仍能注册/登录）', async () => {
    const { calls } = mockFetch([{ body: { data: { id: 'u' } } }]);
    await login({ username: 'marine', password: 'pw-123456' });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, string>;
    expect(body).not.toHaveProperty('captcha_answer');
    expect(body).not.toHaveProperty('captcha_id');
  });
});

// 2026-10-14：这三条钉住「激活 / 找回密码」的字段名。原先它们发的是不存在的 `token`，
// 后端 verifyCodeReq{username|email, code}（auth/handler.go:88-106）直接 400 ——
// **邮箱激活在真站上是 100% 失败的**，而界面把它显示成「验证码不对」（用户以为是自己输错了）。
// 与上面 captcha 那条同族：契约两侧各写一份，两边各自的测试都过，只有请求体那一层没人测。
describe('auth 验证码请求体', () => {
  it('激活：邮箱形态发 email + code，绝不发 token', async () => {
    const { calls } = mockFetch([{ body: { data: null } }]);
    await verifyEmail('m@example.com', '123456');
    expect(String(calls[0]?.url)).toContain('/auth/email/verify');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, string>;
    expect(body).toEqual({ email: 'm@example.com', code: '123456' });
    expect(body).not.toHaveProperty('token');
    expect(body).not.toHaveProperty('username');
  });

  it('激活：用户名形态发 username + code（二选一，不能都发）', async () => {
    const { calls } = mockFetch([{ body: { data: null } }]);
    await verifyEmail('marine', '123456');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, string>;
    expect(body).toEqual({ username: 'marine', code: '123456' });
    expect(body).not.toHaveProperty('email');
  });

  it('找回密码第一步换票、第二步用 reset_ticket', async () => {
    const { calls } = mockFetch([{ body: { data: { reset_ticket: 'tk-1' } } }, { body: { data: null } }]);
    const out = await verifyResetCode('m@example.com', '654321');
    expect(out.reset_ticket).toBe('tk-1');
    expect(String(calls[0]?.url)).toContain('/auth/password/verify-code');

    await resetPassword(out.reset_ticket, 'new-pw-123');
    const body = JSON.parse(String(calls[1]?.init?.body)) as Record<string, string>;
    expect(body).toEqual({ reset_ticket: 'tk-1', new_password: 'new-pw-123' });
    expect(body).not.toHaveProperty('token');
  });
});
