import { act, render, screen } from '@testing-library/react';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { Providers } from '@/app/providers';
import Page from './index';

// D10 的验收：**点哪一档，URL、选中态、右侧面板三者同时变**（清单第 2 节 D10 的原话）。
//
// 这条断言现在是**红的**，而且红在正确的地方：DevRoom 10-messages 的档位与当前会话都是页面内
// useState（只把 URL 当挂载初值读一次），点导航只改 state、不写 URL —— 与真站（routes/messages.tsx
// 的 NoticeCenter 从 ?kind= 推）是**两套真源**。修法是把这一页也改成「URL 即状态」的宿主，
// 与产品页渲染同一个 View，于是两个入口看同一页逐像素一致（清单 §0 的同源要求）。
//
// 房间没有 react-router（app.tsx 只认 ?page=），所以这里直接写 history：断言查的也是 location.search，
// 与产品路由用 useSearchParams 写出来的是同一个东西。

const real = { pathname: location.pathname, search: location.search };
// 落地 URL 带上 panel=：**深链**（把某一档的地址发给别人，打开就是那一档）也是 D10 的一部分
beforeAll(() => history.replaceState(null, '', '/devroom.html?page=10-messages&panel=messages'));
afterAll(() => history.replaceState(null, '', real.pathname + real.search));

/** Ring 的 Button 没有 aria-pressed，选中态是类名（messages.test.tsx 里同一条口径）。 */
const selected = (key: string) => screen.getByTestId('notice-nav-' + key).className.includes('ring-button-active');

it('点每一档：URL 变、选中态跟着变、右侧面板也换（三处一致）', async () => {
  render(
    <Providers>
      <Page />
    </Providers>,
  );

  // 「我的消息」档（URL 说哪一档就是哪一档 —— 这是深链，不是页面内 state）
  expect(new URLSearchParams(location.search).get('panel')).toBe('messages');
  expect(selected('messages')).toBe(true);
  expect(await screen.findByTestId('conversation-demo-marine')).toBeTruthy();

  // 切到「收到的赞」：URL 落到 kind 档、选中态跟着走、右边换成那一档的列表
  await act(async () => screen.getByTestId('notice-nav-kind:like').click());
  const after = new URLSearchParams(location.search);
  expect(after.get('panel')).toBe('notices');
  expect(after.get('kind')).toBe('like');
  // 房间的导航键（?page=）不该被写没：它在，房间才知道自己在哪一页
  expect(after.get('page')).toBe('10-messages');
  expect(selected('kind:like')).toBe(true);
  expect(selected('messages')).toBe(false);
  expect(screen.getByTestId('notice-list').textContent).toContain('收到的赞');

  // 再切到「消息设置」：仍旧三处一致，而且 kind 不该再挂在 URL 上（panel=settings）
  await act(async () => screen.getByTestId('notice-nav-settings').click());
  const q = new URLSearchParams(location.search);
  expect(q.get('panel')).toBe('settings');
  expect(q.get('kind')).toBeNull();
  expect(selected('settings')).toBe(true);
  // 设置是异步取的（房间的假数据也有 120ms 延迟），所以要等它出来
  expect(await screen.findByText('消息提醒')).toBeTruthy();
});
