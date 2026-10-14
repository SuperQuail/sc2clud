import { render, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import type { NoticeSources } from './notice-logic';

// **同源断言（清单 §0 的机器判据）**：DevRoom 10-messages 与真站渲染的必须是**同一个 View**，
// 喂同一批数据时 DOM 的 class 序列逐字相同 —— 版面只有一份，不是抄一份。
//
// 它盯的是「同源」这件事本身，不是某一屏的样子：谁把版面抄回产品路由、或给房间另写一份布局，
// 这条立刻红。两个入口漂移就是从「看起来差不多的两份实现」开始的。
//
// 数据是注入出来的（notice-logic 的 NoticeSources）：两边用**同一份**假数据，
// 所以差别只剩数据之外的东西 —— 按 §0，那部分必须为零。

afterEach(() => {
  vi.doUnmock('@/devroom/pages/10-messages/mock-data');
  vi.resetModules();
});

/** 两边的数据源：同一份（同一个对象）—— 差别只允许在数据之外。 */
function fakeData() {
  const peers: Record<string, { handle: string; nickname: string; avatar: null }> = {
    'demo-admin': { handle: 'demo-admin', nickname: '示范管理员', avatar: null },
  };
  const notice = {
    id: 'n-1',
    kind: 'like',
    payload: { text: '等总计 1321 人赞了我的评论' },
    link: '/t/tp-1',
    read_at: null,
    created_at: '2026-10-14T02:00:00Z',
    actor: peers['demo-admin'],
  };
  const sources: NoticeSources = {
    conversations: async () => ({ items: [], next: null }),
    thread: async () => ({ peer: peers['demo-admin']!, items: [], next: null }),
    unreadMessages: async () => 0,
    notices: async () => ({ items: [notice], next: null }),
    unreadNotices: async () => 1,
    settings: async () => ({ alert: true, reply_scope: 'all' as const, mention_scope: 'all' as const, like_alert: true }),
    searchPeers: async () => [],
    // 写动作也给上：不给的话 View 会按「这一档没有落库」去掉动作槽位，
    // 于是两边比出来的是**功能不同**而不是版面不同（实测：房间多出「标为已读 / 删除」两格）。
    saveSettings: async (next) => next,
    markNoticesRead: async () => {},
    deleteNotice: async () => {},
    muteKind: async () => {},
  };
  return { notice, sources };
}

/** DOM 骨架：标签名 + 决定版面的那些 class（顺序敏感，逐字比）。 */
function skeleton(root: Element) {
  return Array.from(root.querySelectorAll('*'))
    .map((el) => {
      const cls = (el.getAttribute('class') ?? '')
        .split(/\s+/)
        .filter((c) => /^(flex|grid|gap-|min-h|h-|w-|rounded|border|bg-|p[xyltrb]?-|m[xyltrb]?-|text-\[|lg:|sm:|xl:)/.test(c))
        .join(' ');
      return el.tagName.toLowerCase() + '.' + cls;
    })
    .join('\n');
}

it('同一档、同一批数据：房间与产品渲染的是同一个 View（骨架逐字相同）', async () => {
  const data = fakeData();
  // 房间页的取数函数来自 ./mock-data（宿主里那个 NoticeSources），把它换成**与产品同一份**假数据；
  // 其余导出（ME / DIRECTORY / 写动作）照原样留下 —— 只有数据来源该被换掉。
  vi.resetModules();
  vi.doMock('@/devroom/pages/10-messages/mock-data', async (importOriginal) => ({
    ...(await importOriginal<typeof import('./mock-data')>()),
    roomConversations: () => [],
    roomThread: (handle: string) => ({ peer: { handle, nickname: '示范管理员', avatar: null }, items: [], next: null }),
    roomNotices: () => [data.notice],
    roomMarkRead: () => {},
    roomSend: () => {},
    roomRetract: () => {},
    roomMarkNoticesRead: () => {},
    roomDeleteNotice: () => {},
    roomMuteKind: () => {},
    NOTICES: {},
  }));
  const [{ default: RoomPage }, { NoticeCenterView }] = await Promise.all([
    import('./index'),
    import('./notice-center-view'),
  ]);

  // 两侧各占一个独立容器：否则两个 render 落在同一个 document.body 里，查询会互相看见
  // （实测：房间那一份先渲染，产品侧的 find 命中的是**房间**的节点，比出来的是自己跟自己）。
  const roomBox = document.createElement('div');
  const productBox = document.createElement('div');
  document.body.append(roomBox, productBox);

  // 房间侧：真实入口（宿主 + View），URL 由 jsdom 的地址栏给
  history.replaceState(null, '', '/devroom.html?page=10-messages&panel=notices&kind=like');
  render(
    <Providers>
      <RoomPage />
    </Providers>,
    { container: roomBox },
  );
  // 等**内容**出来再比：NoticeList 的卡片在加载态就已经在 DOM 里，等容器等于什么都没等
  await waitFor(() => expect(within(roomBox).getByText('示范管理员')).toBeTruthy());

  // 产品侧：同一个 View 直接渲染（真站那一层只做取数，取数在 routes/messages.test.tsx 里钉）
  render(
    <Providers>
      <NoticeCenterView
          panel='notices'
          kind='like'
          onNav={() => {}}
          onPeer={() => {}}
          sources={data.sources}
          session={{ isLoading: false, loggedIn: true, nickname: '陆战队员' }}
        />
    </Providers>,
    { container: productBox },
  );
  await waitFor(() => expect(within(productBox).getByText('示范管理员')).toBeTruthy());

  const a = skeleton(within(roomBox).getByTestId('notice-center'));
  const b = skeleton(within(productBox).getByTestId('notice-center'));
  expect(a.length).toBeGreaterThan(50);
  expect(a).toBe(b);
  // 房间自己的那一段说明文字**在 View 外面**（它不该进产品页）
  expect(within(roomBox).getByTestId('notice-center').textContent).not.toContain('本页的件都来自');
});
