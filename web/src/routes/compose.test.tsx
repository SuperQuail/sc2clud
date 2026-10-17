import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { ComposePage } from './compose';

// 上行正文（缺陷清单 D6 的同一条根因）：编辑器给宿主的是 EditorState JSON，而后端 content_md 那一列收的是
// **Markdown**（forum 的 render 过 goldmark → bluemonday 渲染成 content_html）。把 JSON 当 Markdown 发上去，
// 库里存的就是那串 JSON，别人打开看到的就是它。
//
// 这一份把编辑器换成假的：Lexical 在 jsdom 里收不到真实输入（实测 fireEvent.input 不产生 onChange），
// 测它等于测库 —— 与 issues.new-issue.test.tsx 对 NewIssuePanel 的 Editor 注入同一个理由。
// 假件照真编辑器的契约报数：onChange 给的那两份是 **EditorState JSON + HTML**。
const EDITOR_JSON = JSON.stringify({
  root: {
    children: [
      {
        children: [{ detail: 0, format: 0, mode: 'normal', style: '', text: '走到第二波就卡关。', type: 'text', version: 1 }],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'paragraph',
        version: 1,
      },
    ],
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
});
vi.mock('@/ui/rich/markdown-editor', async () => {
  const [{ default: Input }, { useRef }] = await Promise.all([
    import('@jetbrains/ring-ui-built/components/input/input'),
    import('react'),
  ]);
  return {
    // **照抄真编辑器的语义**：InitialState 带 `done` 守卫，只在挂载那一刻读一次 value ——
    // 之后再改 value 不会回灌。假件要是不照抄这条，「预灌晚了一步」这个真缺陷就测不出来
    // （2026-10-15 实测：编辑器先以空值挂载，effect 再灌 → 正文永远空白）。
    MarkdownEditor: ({ value, onChange }: { value: string; onChange: (json: string, html: string) => void }) => {
      const first = useRef(value);
      return (
        <>
          <Input label='假编辑器（测试注入）' onChange={(e) => onChange(e.target.value, '<p>不管</p>')} />
          <span data-testid='editor-initial'>{first.current}</span>
        </>
      );
    },
  };
});

// 真页面（routes/compose.tsx）用**设计稿的件**：这里只换网络边界，断言那几件真的进了 DOM，
// 而且用的是**服务端真实的字段**（sources[] 的 provider / extraction_code / upkeep，不是照 mock 猜的）。
// 2026-10-14 用户要求：发帖页与 devroom/pages/18-compose 一致，并补下载来源编辑器。
afterEach(() => {
  vi.unstubAllGlobals();
});

type Reply = { status?: number; body?: unknown };
/** 网络替身：顺带记下每次请求（url / method / body）——「上行的那一份长什么样」只能从这里看。 */
function mockApi(byPath: (url: string) => Reply) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      const reply = byPath(u);
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

const ME = {
  data: { id: 'u1', handle: 'demo-admin', nickname: '管理员', email_verified: true, perms: ['topic.create'], is_super: false },
};
const BOARDS = {
  data: [{ slug: 'custom-campaign', name: '自制战役', description: '玩家自制战役', cover: null, topic_count: 3 }],
};
// 形状照后端 TopicDetailDTO：sources[] 是 SourceDTO（id / go_path / label / url / provider /
// extraction_code / size / upkeep / verified_at）。
const TOPIC = {
  data: {
    id: 'tp-1',
    board: { slug: 'custom-campaign', name: '自制战役' },
    kind: 'resource',
    title: '第三章「余烬」发布',
    content_md: '# 余烬',
    content_html: '<p>正文</p>',
    author: { handle: 'demo-admin', nickname: '管理员' },
    reply_count: 0,
    like_count: 0,
    view_count: 0,
    featured: false,
    pinned: false,
    created_at: '2026-10-12T01:20:00Z',
    last_reply_at: null,
    updated_at: '2026-10-12T02:20:00Z',
    sources: [
      {
        id: 's1',
        provider: 'baidu',
        label: '主线战役 v3.1',
        url: 'https://pan.baidu.com/s/1abc',
        go_path: '/api/v1/topics/tp-1/sources/s1/go',
        extraction_code: 'sc2c',
        size: '2.4 GB',
        verified_at: '2026-10-13T02:00:00Z',
        upkeep: 'active',
      },
      {
        id: 's2',
        provider: 'pan123',
        label: '旧版',
        url: 'https://www.123pan.com/s/old',
        go_path: '/api/v1/topics/tp-1/sources/s2/go',
        extraction_code: null,
        size: '',
        verified_at: null,
        upkeep: 'archived',
      },
    ],
  },
};

// 保存后会跳到帖子页：放一条探针，断言跳的是**真 id** 而不是 `undefined`
// （2026-10-15 实测：PATCH 回执里没有 id，拿它拼路径 → /t/undefined → 400 参数错误）。
function TopicProbe() {
  const loc = useLocation();
  return <div data-testid='probe-topic'>{loc.pathname}</div>;
}

function renderCompose(path: string) {
  return render(
    <Providers>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path='/new' element={<ComposePage />} />
          <Route path='/t/:topicId' element={<TopicProbe />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  );
}

it('新建页：提交区说清缺什么 + 预览与编辑器同一份状态 + 来源什么时候能加', async () => {
  mockApi((url) => (url.includes('/me') ? { body: ME } : { body: BOARDS }));
  renderCompose('/new');

  await waitFor(() => expect(screen.getByTestId('compose-missing').textContent).toContain('标题'));
  expect(screen.getByTestId('compose-missing').textContent).toContain('正文');
  expect(screen.getByLabelText('预览')).toBeTruthy();
  expect(screen.getByTestId('preview-toggle')).toBeTruthy();
  // 新建时还没有 topic id，来源编辑器画不出来 —— 但不能静默，要说清什么时候能加
  expect(screen.queryByTestId('compose-sources')).toBeNull();
  fireEvent.click(screen.getByTestId('compose-kind-resource'));
  expect(screen.getByTestId('compose-sources-later').textContent).toContain('发布');
  // 配图同理：上传端点绑在主题上（POST /topics/{id}/images），发新帖时还没有 id。
  // 说清「发布之后从帖子页点编辑回来配图」，而不是画一个点了必失败的入口。
  expect(screen.getByTestId('compose-images-later').textContent).toContain('发布');
});

it('编辑资源帖：SourceEditor 用的是服务端那份 sources（真字段：站点 / 提取码 / 归档 / 链接原文）', async () => {
  mockApi((url) =>
    url.includes('/me') ? { body: ME } : url.includes('/topics/tp-1') ? { body: TOPIC } : { body: BOARDS },
  );
  renderCompose('/new?edit=tp-1');

  await waitFor(() => expect(screen.getByTestId('source-row-s1')).toBeTruthy());
  expect(screen.getByTestId('source-row-s1').textContent).toContain('百度网盘');
  expect(screen.getByTestId('source-row-s1').textContent).toContain('sc2c');
  expect(screen.getByTestId('source-row-s1').textContent).toContain('2.4 GB');
  expect(screen.getByTestId('source-row-s2').textContent).toContain('已归档');
  // 链接原文只在编辑时露出来（读者点的是 go_path，不是这个）
  expect(screen.getByTitle('https://pan.baidu.com/s/1abc')).toBeTruthy();
  // 编辑态：按钮说的是「保存修改」，标题已从接口回填
  expect(screen.getByTestId('compose-submit').textContent).toContain('保存修改');
  expect((screen.getByTestId('compose-title') as HTMLInputElement).value).toBe('第三章「余烬」发布');
});

// 2026-10-15 实测：编辑帖子进去**正文空白**（标题/分区/来源都对）——
// content_md 是历史列（老站是 Markdown 纯文本），直接灌编辑器（按 EditorState JSON 解析）就是空文档。
// 这条钉住回填：编辑器拿到的必须是**含正文文本的 EditorState**，一字不能丢。
it('编辑态回填：编辑器初始值是从 content_md 换出来的 EditorState（正文不空）', async () => {
  mockApi((url) =>
    url.includes('/me') ? { body: ME } : url.includes('/topics/tp-1') ? { body: TOPIC } : { body: BOARDS },
  );
  renderCompose('/new?edit=tp-1');
  await waitFor(() => expect((screen.getByTestId('compose-title') as HTMLInputElement).value).toBe('第三章「余烬」发布'));
  const initial = JSON.parse(screen.getByTestId('editor-initial').textContent ?? '') as {
    root: { children: { children: { text: string }[] }[] };
  };
  expect(initial.root.children[0]!.children[0]!.text).toBe('# 余烬');
});

// D6 的同一条根因，影响面最大的两处：**发帖**与**编辑正文**。
// 断言的是「请求体里的正文字段是 Markdown、且不含 "root"」（旧行为：编辑器 JSON 原样上行）。
it('上行（发帖）：POST /topics 的 content_md 是 Markdown，不是 EditorState JSON', async () => {
  const calls = mockApi((url) => (url.includes('/me') ? { body: ME } : url.includes('/topics') ? { body: TOPIC } : { body: BOARDS }));
  renderCompose('/new?board=custom-campaign');
  fireEvent.change(await screen.findByTestId('compose-title'), { target: { value: '第二章卡关记录' } });
  fireEvent.change(screen.getByLabelText('假编辑器（测试注入）'), { target: { value: EDITOR_JSON } });
  // 三项齐了才点得动（分区来自 ?board=，标题与正文刚填完）——不先等这一下，红了也说不清是为什么
  await waitFor(() => expect(screen.queryByTestId('compose-missing')).toBeNull());
  fireEvent.click(screen.getByTestId('compose-submit'));

  await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
  const post = calls.find((c) => c.method === 'POST')!;
  expect(post.url).toContain('/api/v1/topics');
  expect((post.body as { content_md: string }).content_md).toBe('走到第二波就卡关。');
  expect(JSON.stringify(post.body)).not.toContain('"root"');
});

it('上行（编辑正文）：PATCH /topics/{id} 的 content_md 也是 Markdown', async () => {
  const calls = mockApi((url) => (url.includes('/me') ? { body: ME } : url.includes('/topics/tp-1') ? { body: TOPIC } : { body: BOARDS }));
  renderCompose('/new?edit=tp-1');
  // 等回填落定（标题来自接口），确认这一屏真的是「编辑已发出去的帖子」
  await waitFor(() => expect((screen.getByTestId('compose-title') as HTMLInputElement).value).toBe('第三章「余烬」发布'));
  fireEvent.change(screen.getByLabelText('假编辑器（测试注入）'), { target: { value: EDITOR_JSON } });
  await waitFor(() => expect(screen.queryByTestId('compose-missing')).toBeNull());
  fireEvent.click(screen.getByTestId('compose-submit'));

  await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
  const patch = calls.find((c) => c.method === 'PATCH')!;
  expect(patch.url).toContain('/api/v1/topics/tp-1');
  expect((patch.body as { content_md: string }).content_md).toBe('走到第二波就卡关。');
  expect(JSON.stringify(patch.body)).not.toContain('"root"');
  // **没改分区就不许带 board**：后端对带 board 的 PATCH 要 topic.move，每次都发会把
  // 「没有这个权限的作者」连保存都挡掉（2026-10-15 修「改分区无效」时定的形状）。
  expect((patch.body as { board?: string }).board).toBeUndefined();
  // 保存后跳的是**真 id**（PATCH 回执 {ok:true} 里没有 id；用 undefined 拼路径会 400）
  await waitFor(() => expect(screen.getByTestId('probe-topic').textContent).toBe('/t/tp-1'));
});

it('编辑非资源帖：不画来源编辑器，但说清为什么（后端 forum.not_resource）', async () => {
  const discussion = { data: { ...TOPIC.data, kind: 'discussion', sources: [] } };
  mockApi((url) =>
    url.includes('/me') ? { body: ME } : url.includes('/topics/tp-1') ? { body: discussion } : { body: BOARDS },
  );
  renderCompose('/new?edit=tp-1');

  await waitFor(() => expect(screen.getByTestId('compose-sources-other-kind')).toBeTruthy());
  expect(screen.queryByTestId('compose-sources')).toBeNull();
});
