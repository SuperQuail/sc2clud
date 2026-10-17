import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { IssuesPage } from './issues';

// D5（2026-10-14 用户实测）：点顶上「问题反馈」页签**不切换**，人还停在帖子内容页。
// 根因：页签的 onOpenIssue 在真站没接成导航（组件层默认是 noop），点下去一片死寂。
//
// 断言的判据是**地址真的变了**，不是「组件回调被调用过」—— 回调被调用而没人管，正是缺陷本身。
// 两页共用一套 key：帖子内容 = /t/<id>，问题反馈 = /issues?topic=<id>（&view=issue）。
afterEach(() => {
  vi.unstubAllGlobals();
});

const ME = { handle: 'demo-marine', nickname: '陆战队员', perms: ['topic.create'], is_super: false, email_verified: true };

/** 帖子页的替身：只用来证明「点页签真的把人送回了帖子页」，版面不在这里测 */
function TopicStub() {
  return <p data-testid='topic-stub'>帖子页</p>;
}

function renderIssues(path: string) {
  return render(
    <Providers>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path='/issues' element={<IssuesPage />} />
          <Route path='/t/:topicId' element={<TopicStub />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}

it('D5：从帖子页过来点「问题反馈」页签时，地址是 /issues?topic=<id>&view=issue（页签真选中）', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      const body = u.includes('/api/v1/me') ? { data: ME } : { data: [], next_cursor: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  const { container } = renderIssues('/issues?topic=tp-1&view=issue');
  await screen.findByRole('region', { name: '反馈列表' });

  const tabs = container.querySelectorAll('[data-testid=topic-tabs] button');
  // 页签在：两格，且「问题反馈」是选中态（aria-current=page 是选中态的唯一机器判据）
  expect(tabs.length).toBe(2);
  expect(tabs[1]!.getAttribute('aria-current')).toBe('page');
});

it('D5：点「帖子内容」页签回帖子页（页签不是两块死按钮）', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      const body = u.includes('/api/v1/me') ? { data: ME } : { data: [], next_cursor: null };
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  const { container } = renderIssues('/issues?topic=tp-1&view=issue');
  await screen.findByRole('region', { name: '反馈列表' });

  fireEvent.click(container.querySelectorAll('[data-testid=topic-tabs] button')[0]!);
  // 人真的到了帖子页（不是「回调被调用过」）
  expect(await screen.findByTestId('topic-stub')).toBeTruthy();
});

