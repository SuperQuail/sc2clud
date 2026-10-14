import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { NewIssuePanel } from '@/devroom/pages/13-issue/new-issue-panel';
import { IssuesPage } from './issues';

// D6（2026-10-14 用户实测）：反馈详情里显示的是 **Lexical EditorState 的 JSON 原文**。
//
// 根因：上行给后端的 body_md 是 **Markdown**（forum/internal/forum/issues.go 拿它 render →
// goldmark → bluemonday → body_html，dto.go:236 回给前端的是 body_html）。而编辑器的存储格式是
// EditorState JSON（ui/rich/markdown-editor.tsx），前端把那份 JSON 当 body_md 发上去，
// 后端只会把它当一段普通文字原样渲染：页面上出现的就是 {"root":{...}}。
//
// 这份测试的**网络替身故意照后端的行为写**（存下什么就渲染什么），而不是像旧测试那样拿一段手写 HTML
// 当 body_html —— 那样无论前端发什么它都是绿的，正是这个缺陷能活到今天的原因。
//
// 编辑器那一格注入一份假的（Lexical 在 jsdom 里不产生真实的编辑事件，测它等于测库；注入点见
// new-issue-panel.tsx 的 Editor prop）：真正要证明的是「提交时 EditorState JSON 被换成了 Markdown」，
// 这一段是路由里那一行代码，必须端到端跑。
const ME = { handle: 'demo-marine', nickname: '陆战队员', perms: ['topic.create'], is_super: false, email_verified: true };

function doc(children: unknown[]): string {
  return JSON.stringify({ root: { children, direction: 'ltr', format: '', indent: 0, type: 'root', version: 1 } });
}
function paragraph(value: string, format = 0): unknown {
  return {
    children: [{ detail: 0, format, mode: 'normal', style: '', text: value, type: 'text', version: 1 }],
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'paragraph',
    version: 1,
  };
}

/** 假编辑器：把「编辑器刚产出的那份 JSON」交给宿主（就是真编辑器 onChange 给的第二个参数） */
const EDITOR_JSON = doc([paragraph('走到第二波就卡关。')]);
function FakeEditor({ onTitle, onBody, onLength }: { title: string; onTitle: (v: string) => void; onBody: (json: string, html: string) => void; onLength: (n: number) => void }) {
  const [json, setJson] = useState('');
  return (
    <div className='flex flex-col gap-2'>
      {/* 标题那一格在这份假件里（真件里是 Ring 的 Input，见 new-issue-form.tsx） */}
      <label htmlFor='fake-title'>标题</label>
      <input id='fake-title' onChange={(e) => onTitle(e.target.value)} />
      <label htmlFor='fake-body'>假编辑器（测试注入）</label>
      <input
        id='fake-body'
        value={json}
        onChange={(e) => {
          setJson(e.target.value);
          // 真编辑器就是这么报的：先给两份产出（EditorState JSON + 只读 HTML），再报字数
          onBody(e.target.value, '<p>不管</p>');
          onLength(e.target.value.length);
        }}
      />
    </div>
  );
}

const ISSUE = {
  id: 'i-128',
  number: 128,
  kind: 'bug',
  title: '第二波卡关',
  status: 'open',
  author: { handle: 'demo-voidray', nickname: '虚空辉光舰', avatar_hash: null, avatar_small_hash: null },
  assignee: null,
  tags: [],
  comment_count: 0,
  created_at: '2026-10-10T04:00:00Z',
  updated_at: '2026-10-14T02:00:00Z',
  closed_at: null,
  topic_id: 'tp-1',
  topic_title: '第三章「余烬」发布',
  board: { slug: 'custom-campaign', name: '自制战役' },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it('D6：上行的 body_md 是 Markdown（页面里不出现 {"root"...}）', async () => {
  // 后端行为：POST 存下 body_md，详情接口回「把 body_md 当 Markdown 渲染」的那段 HTML
  let stored = '';
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as { body_md?: string });
      calls.push({ url: u, method, body });
      let out: unknown = { data: null };
      if (u.includes('/api/v1/me')) out = { data: ME };
      else if (u.includes('/topics/tp-1/issues') && method === 'POST') {
        stored = body?.body_md ?? '';
        out = { data: { ...ISSUE } };
      } else if (u.includes('/topics/tp-1/issues')) out = { data: [ISSUE], next_cursor: null };
      else if (u.includes('/issues/i-128/comments')) out = { data: [], next_cursor: null };
      else if (u.includes('/issues/i-128')) out = { data: { ...ISSUE, body_html: '<p>' + stored + '</p>' } };
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );

  render(
    <Providers>
      <MemoryRouter initialEntries={['/issues?topic=tp-1&kind=bug']}>
        <Routes>
          {/* 真页面 + 假编辑器：路由那一行（editorJsonToMarkdown）因此真的跑起来 */}
          <Route path='/issues' element={<IssuesPage NewIssueEditor={FakeEditor} />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );

  fireEvent.change(await screen.findByLabelText('标题'), { target: { value: '第二波卡关' } });
  fireEvent.change(screen.getByLabelText('假编辑器（测试注入）'), { target: { value: EDITOR_JSON } });
  fireEvent.click(screen.getByRole('button', { name: '提交反馈' }));

  await waitFor(() => expect(stored).not.toBe(''));
  // ① 上行的那一份是 Markdown，不是 JSON
  const posted = calls.find((c) => c.method === 'POST')!;
  expect((posted.body as { body_md: string }).body_md).toBe('走到第二波就卡关。');
  expect(JSON.stringify(posted.body)).not.toContain('"root"');
  // ② 详情页面上看到的是正文本身（后端把它渲染成 HTML），整页里没有 JSON 的形状
  await waitFor(() => expect(screen.getByText('走到第二波就卡关。')).toBeTruthy());
  expect(document.body.textContent ?? '').not.toContain('"root"');
});

// D7（2026-10-14 用户要求）：新建反馈是**页内的一块完整表单区**，不再是弹窗。
// 判据：页面上有这块区域（aria-label=我要反馈）、**没有 dialog 角色**、两处进入方式都能开它、
// 校验逐条保留（标题 ≥4 字、正文非空各自拦一次且不发写请求）。
it('D7：新建反馈是页内表单区而不是弹窗，校验逐条保留', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      calls.push({ url: u, method });
      const out = u.includes('/api/v1/me') ? { data: ME } : { data: [], next_cursor: null };
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );

  render(
    <Providers>
      <MemoryRouter initialEntries={['/issues?topic=tp-1']}>
        <Routes>
          <Route path='/issues' element={<IssuesPage NewIssueEditor={FakeEditor} />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
  await screen.findByRole('region', { name: '反馈列表' });
  // **先等会话落定**：四个入口对未登录的人只给一句「提反馈要先登录」（见 openKind）。
  // 不等就会变成「点下去没反应」——那不是页面的毛病，是这一份测试自己抢跑。
  await waitFor(() => expect(calls.filter((c) => c.url.includes('/api/v1/me')).length).toBe(1));
  // 没有 ?kind= 时表单是收起的：页面上不该有它，也不该有 dialog
  expect(screen.queryByTestId('new-issue-form')).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();

  // 点四个类型入口之一 → 表单**就地出现**（不是弹层）
  fireEvent.click(screen.getAllByRole('button', { name: /^报个 Bug/ })[0]!);
  const panel = await screen.findByTestId('new-issue-form');
  expect(panel.getAttribute('aria-label')).toBe('我要反馈');
  expect(screen.queryByRole('dialog')).toBeNull();

  // 标题太短：拦下、且不发写请求
  fireEvent.change(await screen.findByLabelText('标题'), { target: { value: '卡关' } });
  fireEvent.click(screen.getByRole('button', { name: '提交反馈' }));
  expect(screen.getByRole('alert').textContent).toContain('标题至少 4 个字');
  // 正文为空：拦下、且不发写请求
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: '第二波卡关' } });
  fireEvent.click(screen.getByRole('button', { name: '提交反馈' }));
  expect(screen.getByRole('alert').textContent).toContain('正文还没写');
  expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

  // 收起：那块区域真的消失（不是只改一个字）
  fireEvent.click(screen.getByRole('button', { name: '收起' }));
  await waitFor(() => expect(screen.queryByTestId('new-issue-form')).toBeNull());
});

// 面板自己的一层：标题/正文两格的校验与「收起」都由它负责（宿主只接结果）
it('D7：NewIssuePanel 的提交给的是编辑器真源（bodyJson），不是渲染后的 HTML', async () => {
  const onSubmit = vi.fn();
  render(<NewIssuePanel initialKind='bug' onClose={vi.fn()} onSubmit={onSubmit} Editor={FakeEditor} />);
  fireEvent.change(screen.getByLabelText('标题'), { target: { value: '第二波卡关' } });
  fireEvent.change(screen.getByLabelText('假编辑器（测试注入）'), { target: { value: EDITOR_JSON } });
  fireEvent.click(screen.getByRole('button', { name: '提交反馈' }));
  expect(onSubmit).toHaveBeenCalledWith({ kind: 'bug', title: '第二波卡关', bodyJson: EDITOR_JSON });
});
