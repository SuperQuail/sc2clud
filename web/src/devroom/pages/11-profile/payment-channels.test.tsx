import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { PaymentChannelsDialog, PaymentChannelsPanel } from './payment-channels';
import { useMyPaymentChannels } from './payment-channels-hook';
import { DonationRecordsPanel } from './records-panel';

// 「赞赏与收款码」这一块（L1）在真页面里到底发了什么请求。
// 契约真源：media/handler.go:43-45（收款码 CRUD）与 reward/handler.go:40-42,45（设置 / 记录 / 撤回）。
// 断言只查「打出去的那一发」与页面文案 —— 不查 className。
//
// 2026-10-15（D22）改了形状：版面是**只吃 props 的 View**，取数与发请求在
// payment-channels-hook.ts，记录那一节搬到 records-panel.tsx。所以这里的宿主就是真站那一段接线
// （routes/settings.tsx 与 routes/profile.tsx 的弹层都是这么接的）——
// 请求面因此照旧被钉住，而「版面与取数分家」这件事本身也顺带被这条用例守着。
afterEach(() => {
  vi.unstubAllGlobals();
});

type Reply = { status?: number; body?: unknown };
const calls: Array<{ url: string; method: string; body: unknown }> = [];

function mockApi(byPath: (url: string) => Reply) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      // JSON body 解析成对象（FormData 就原样留着，由测试自己断言它是不是 FormData）
      const raw = init?.body;
      calls.push({ url: u, method, body: typeof raw === 'string' ? JSON.parse(raw) : raw });
      const reply = byPath(u);
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

const CHANNEL = { data: [{ id: 'c1', label: '微信', image: '/img/abc', sort: 0 }], next_cursor: null };
const SETTINGS = { data: { show_channels: false, records_public: false, notice_visible: true, notice_text: '' } };
const MINE = {
  data: [
    { id: 'd1', amount_cents: 1200, state: 'pending', created_at: '2026-10-14T02:00:00Z', recipient: { handle: 'a', nickname: '作者甲', avatar: '' } },
    { id: 'd2', amount_cents: 500, state: 'approved', created_at: '2026-10-13T02:00:00Z', recipient: { handle: 'b', nickname: '作者乙', avatar: '' } },
  ],
  next_cursor: null,
};

/** 真站的接线：hook 给数据，View 只画（弹层那一半由 dialog 用例覆盖）。 */
function Host({ dialog = false }: { dialog?: boolean }) {
  const c = useMyPaymentChannels();
  const view = {
    channels: c.channels,
    pending: c.channelsPending,
    error: c.channelsError,
    settings: c.settings,
    settingsPending: c.settingsPending,
    settingsError: c.settingsError,
    saveError: c.saveError,
    notice: c.notice,
    onNotice: c.setNotice,
    onAdd: c.onAdd,
    addPending: c.addPending,
    addError: c.addError,
    onDelete: c.onDelete,
    removePending: c.removePending,
    removeError: c.removeError,
    onShowChannels: c.onShowChannels,
  };
  return dialog ? <PaymentChannelsDialog open onClose={() => {}} {...view} /> : <PaymentChannelsPanel {...view} />;
}

function renderPanel() {
  return render(
    <Providers>
      <Host />
      <DonationRecordsPanel />
    </Providers>,
  );
}

it('收款码列表 + 我的打赏记录都来自真端点，状态与金额按后端字段渲染', async () => {
  mockApi((url) => {
    if (url.includes('/me/payment-channels')) return { body: CHANNEL };
    if (url.includes('/me/donation-settings')) return { body: SETTINGS };
    if (url.includes('/me/rewards')) return { body: MINE };
    return { status: 404, body: { error: { code: 'common.not_found', message: 'no' } } };
  });
  renderPanel();

  await waitFor(() => expect(screen.getByText('微信')).toBeTruthy());
  // 金额是整数分（formatCents），状态文案照 ck_donation_records_state 的四值
  expect(screen.getByText('¥12.00')).toBeTruthy();
  expect(screen.getByText('待核验')).toBeTruthy();
  expect(screen.getByText('已确认')).toBeTruthy();
  // 只有 pending 那条给「撤回」（已核验的后端给 403）
  expect(screen.getByTestId('donation-withdraw-d1')).toBeTruthy();
  expect(screen.queryByTestId('donation-withdraw-d2')).toBeNull();
  // 三个请求的路径都必须是后端真有的那三条
  expect(calls.map((c) => c.url.split('?')[0]).sort()).toEqual([
    '/api/v1/me/donation-settings',
    '/api/v1/me/payment-channels',
    '/api/v1/me/rewards',
  ]);
});

it('可见性开关改一项只 PATCH 那一个键（后端是 *bool，多发一个键就是覆盖别人那一项）', async () => {
  mockApi((url) => {
    if (url.includes('/me/payment-channels')) return { body: CHANNEL };
    if (url.includes('/me/donation-settings')) return { body: SETTINGS };
    if (url.includes('/me/rewards')) return { body: MINE };
    return { status: 404, body: { error: { code: 'common.not_found', message: 'no' } } };
  });
  renderPanel();
  await waitFor(() => expect(screen.getByText('在个人主页与帖子右栏展示我的收款码')).toBeTruthy());

  // 按**文案**找那一行的开关，不按序号：同一屏里还有别处的 checkbox（上传器/其它开关），
  // 序号会随后面加东西而漂 —— 那样测试会静默换成点另一个开关。
  const row = screen.getByText('在个人主页与帖子右栏展示我的收款码').closest('label')!;
  fireEvent.click(row.querySelector('input[type=checkbox]')!);

  await waitFor(() => {
    const patch = calls.find((c) => c.method === 'PATCH' && c.url.includes('/me/donation-settings'));
    expect(patch).toBeTruthy();
    expect(patch!.body).toEqual({ show_channels: true });
  });
});

it('删除收款码走 DELETE /me/payment-channels/{id}；撤回走 DELETE /rewards/{id}', async () => {
  mockApi((url) => {
    if (url.includes('/me/payment-channels')) return { body: CHANNEL };
    if (url.includes('/me/donation-settings')) return { body: SETTINGS };
    if (url.includes('/me/rewards')) return { body: MINE };
    return { status: 204 };
  });
  renderPanel();
  await waitFor(() => expect(screen.getByTestId('channel-delete-c1')).toBeTruthy());
  fireEvent.click(screen.getByTestId('channel-delete-c1'));
  await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/me/payment-channels/c1')).toBe(true));

  fireEvent.click(screen.getByTestId('donation-withdraw-d1'));
  await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/v1/rewards/d1')).toBe(true));
});

it('后端回的形状不是数组时给空态，**不把整页打成错误页**', async () => {
  mockApi((url) => {
    if (url.includes('/me/payment-channels')) return { body: { data: { nope: true } } };
    if (url.includes('/me/donation-settings')) return { body: SETTINGS };
    if (url.includes('/me/rewards')) return { body: { data: 'not-a-list' } };
    return { status: 404, body: { error: { code: 'common.not_found', message: 'no' } } };
  });
  renderPanel();
  await waitFor(() => expect(screen.getByText(/还没有收款码/)).toBeTruthy());
  expect(screen.getByText(/还没有申报过打赏/)).toBeTruthy();
});

// D1 的回归位（2026-10-14 用户实测「同一句提示出现两次」）：上传器内部画一行、宿主又画一行。
// 现在控件不再自己画，宿主这一行是唯一的一份 —— 把「一共几行」钉死，重复渲染回不来。
it('体积超限时提示只有一行（控件不再自己画一份）', async () => {
  mockApi((url) => {
    if (url.includes('/me/payment-channels')) return { body: CHANNEL };
    if (url.includes('/me/donation-settings')) return { body: SETTINGS };
    if (url.includes('/me/rewards')) return { body: MINE };
    return { status: 404, body: { error: { code: 'common.not_found', message: 'no' } } };
  });
  const { container } = renderPanel();
  await waitFor(() => expect(screen.getByText('微信')).toBeTruthy());

  // 12MB > 可压缩上限（AVATAR_MAX_BYTES）→ 当场拒；这里只读 name/size，不真分配 12MB
  const input = container.querySelector<HTMLInputElement>('#payment-channels input[type=file]')!;
  const huge = Object.defineProperty(new File([], 'huge.png', { type: 'image/png' }), 'size', { value: 12 * 1024 * 1024 });
  Object.defineProperty(input, 'files', { configurable: true, value: [huge] });
  fireEvent.change(input);

  await waitFor(() => expect(screen.getByText(/没有加进来/)).toBeTruthy());
  expect(screen.getAllByText(/没有加进来/)).toHaveLength(1);
  // 而且**没有**发那一发必然 413 的上传（上限在压缩之前就拦下了）
  expect(calls.some((c) => c.method === 'POST' && c.url.includes('/me/payment-channels'))).toBe(false);
});

// D22：同一条 View 换进弹层（个人主页那颗「设置我的收款码」用的就是这个）也必须工作 ——
// 「设置页能用、弹层里是空壳」正是同源要求要挡的那种分叉。
it('弹层里是同一份实现：列表、开关、上传口都在', async () => {
  mockApi((url) => {
    if (url.includes('/me/payment-channels')) return { body: CHANNEL };
    if (url.includes('/me/donation-settings')) return { body: SETTINGS };
    return { status: 404, body: { error: { code: 'common.not_found', message: 'no' } } };
  });
  render(
    <Providers>
      <Host dialog />
    </Providers>,
  );
  await waitFor(() => expect(screen.getByText('微信')).toBeTruthy());
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByText('在个人主页与帖子右栏展示我的收款码')).toBeTruthy();
});
