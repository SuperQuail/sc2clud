import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addPaymentChannel,
  channelImageSrc,
  createDonation,
  deletePaymentChannel,
  fetchMyDonations,
  fetchUserChannels,
  fetchUserDonations,
  updateDonationSettings,
} from './rewards';
import { mockFetch } from '@/test/fetch-mock';

afterEach(() => {
  vi.unstubAllGlobals();
});

// 打赏这一块 2026-10-14 之前在前端是**零接线**（`web/src/lib` 里没有任何 reward/payment 客户端），
// 所以这一份钉的是「后端明明有、前端一次都没调过」的那几条端点的路径与形状。
// 契约两侧各写一份是本仓库最高频的事故（交接单 §5.1），所以路径与字段名逐字对着
// `media/handler.go` 与 `reward/handler.go` 抄，并在下面把「不该出现的东西」也断言掉。
describe('打赏 / 收款码请求', () => {
  it('收款码列表走 GET /users/{handle}/channels 并剥掉列表包络', async () => {
    mockFetch([
      { body: { data: [{ id: 'c1', label: '支付宝', image: '/img/abc', sort: 0 }], next_cursor: null } },
    ]);
    const out = await fetchUserChannels('demo drone');
    expect(out).toEqual([{ id: 'c1', label: '支付宝', image: '/img/abc', sort: 0 }]);
  });

  it('收款码上传是 multipart（字段名 file + label），绝不套 JSON', async () => {
    const { calls } = mockFetch([{ status: 201, body: { data: { id: 'c1' } } }]);
    await addPaymentChannel(new Blob(['x'], { type: 'image/png' }), '微信');
    expect(String(calls[0]?.url)).toBe('/api/v1/me/payment-channels');
    expect(calls[0]?.init?.method).toBe('POST');
    const body = calls[0]?.init?.body;
    expect(body).toBeInstanceOf(FormData);
    const form = body as FormData;
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(form.get('label')).toBe('微信');
    // JSON 会被 content-type 写成 application/json，那会让后端的 readFormFile 直接 400
    expect(calls[0]?.init?.headers).toBeUndefined();
  });

  it('删除收款码走 DELETE /me/payment-channels/{id}，id 要转义', async () => {
    const { calls } = mockFetch([{ status: 204 }]);
    await deletePaymentChannel('c/1');
    expect(String(calls[0]?.url)).toBe('/api/v1/me/payment-channels/c%2F1');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('收款码图是站根路径，渲染前要过 imagePath（原样当 src 会在 /dev/ 下拿到 SPA 的 HTML）', () => {
    expect(channelImageSrc({ id: 'c1', label: '微信', image: '/img/abc', sort: 0 })).toBe('/img/abc');
  });

  it('申报用后端字段名 to_handle / amount_cents（不是 mock 的 to / amount）', async () => {
    const { calls } = mockFetch([{ status: 201, body: { data: { id: 'd1' } } }]);
    await createDonation({ to_handle: 'author', amount_cents: 1000, post_id: 'tp-1', channel_id: 'c1', note: '加油' });
    expect(String(calls[0]?.url)).toBe('/api/v1/rewards');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ to_handle: 'author', amount_cents: 1000, post_id: 'tp-1', channel_id: 'c1', note: '加油' });
    expect(body).not.toHaveProperty('to');
    expect(body).not.toHaveProperty('amount');
    expect(body).not.toHaveProperty('ip');
  });

  it('我的打赏记录 GET /me/rewards 带游标，next_cursor 不能被吃掉', async () => {
    const { calls } = mockFetch([{ body: { data: [{ id: 'd1' }], next_cursor: 'cur-2' } }]);
    const page = await fetchMyDonations({ cursor: 'cur-1', limit: 5 });
    expect(String(calls[0]?.url)).toBe('/api/v1/me/rewards?limit=5&cursor=cur-1');
    expect(page.next).toBe('cur-2');
    expect(page.items).toHaveLength(1);
  });

  it('别人主页的公开记录走 GET /users/{handle}/rewards', async () => {
    const { calls } = mockFetch([{ body: { data: [], next_cursor: null } }]);
    await fetchUserDonations('demo-drone');
    expect(String(calls[0]?.url)).toBe('/api/v1/users/demo-drone/rewards?limit=20');
  });
});

describe('赞赏设置', () => {
  it('部分更新只发改过的键（后端是 *bool，多发一个键就是覆盖别人那一项）', async () => {
    const { calls } = mockFetch([
      { body: { data: { show_channels: true, records_public: false, notice_visible: true, notice_text: '' } } },
    ]);
    const out = await updateDonationSettings({ show_channels: true });
    expect(calls[0]?.init?.method).toBe('PATCH');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({ show_channels: true });
    expect(out.show_channels).toBe(true);
  });
});
