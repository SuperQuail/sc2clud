import { fireEvent, render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { AdminLayout } from '@/routes/admin';
import { classifyTestFailure } from './ai';
import { ApiError } from '@/lib/api/errors';

// D12：管理页「AI 审核」里点**连通性测试**，失败必须是**就地一行实话**，不许落进错误边界（"出错了 / 页面出错了"）。
//
// 分两层钉：
//   ① **接线**（这个文件）：真宿主 AdminLayout → 容器 → 屏，桩一失败就断言那一行在、页面还在、页面没变成「出错了」；
//   ② **分档**（classifyTestFailure 的表驱动用例）：缺 key / 401 / 超时 / 500 各一句实话。
//      「缺 key」那一档最坑：后端 POST /admin/ai/test 在没 key 时回的是 **500 common.internal**
//      （aireview 的 LoadKey 返回裸 error → httpx.Fail 兜底成 500），**错误码里没有「缺 key」这个信息** ——
//      所以前端必须用配置里的 has_secret 在**点之前**判掉它，并且真的不发那一次请求。
//
// 两个踩过的坑：
//   ① 桩的响应体是**整个包络**（api() 取 payload.data）：JSON.stringify({data: …}) / {error: …}，
//      写成 {data:{data:…}} 会让 fetchAiConfig 拿到 undefined，屏上只剩一行「配置没能加载」；
//   ② 路由形状照 router.tsx：屏是 **/admin/* 的通配片段**（AdminLayout 读 useParams()['*']），
//      少了它 params['*'] 是 undefined → 落到默认屏 users，断言全部打在别的屏上。

afterEach(() => { vi.unstubAllGlobals(); });

type Reply = { status?: number; body?: unknown };
const calls: Array<{ url: string; method: string }> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function aiConfig(over: Record<string, unknown> = {}): Reply {
  return { body: { data: {
    enabled: true, provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-chat',
    thinking: false, strict_mode: true, timeout_ms: 20000, max_output_tokens: 1024, temperature: 0,
    prompt: '', prompt_report: '', probe_sample: '【帖子】这是一次连通性测试，用来确认密钥与地址可用。',
    has_secret: true, secret_updated_at: '2026-10-01T00:00:00Z',
    last_ok_at: null, last_error: '', last_error_at: null, ...over,
  } } };
}
// D33①：容器挂载后会把「将要发送的那一份」打过来（POST /admin/ai/payload，DryRun）。
// 桩**必须**盖住它：掉进默认分支会返回一个用户对象，AiPayloadView 一渲染 images 就是 undefined →
// 错误边界接管整页 → 三条旧用例里的那颗按钮永远不出现（这正是这三条红的根因）。
function aiPayload(): Reply {
  return { body: { data: {
    source: 'probe', topic_id: 0, title: '', trigger: 'create', open_reports: 0,
    system: '', user_prefix: '', user_title: '', user_body: '',
    user_text: '标题：连通性测试\n\n正文：这是一次连接测试，用来确认密钥与地址可用。',
    has_image_markdown: false, image_attachment_count: 0, images: [],
    image_count: 0, image_skipped: 0, image_bytes: 0,
    image_limit: 4, image_max_bytes: 2097152, image_read_failed: false,
    model: 'deepseek-chat', max_output_tokens: 1024, strict_mode: true, tool_name: 'submit_review',
    categories: ['spam', 'ad'],
  } } };
}
const ME_ADMIN: Reply = { body: { data: {
  id: 'u-1', handle: 'demo-admin', nickname: '示范管理员', avatar: null,
  email_verified: true, perms: ['site.setting'], is_super: false,
  role: { key: 'admin', name: '管理员' }, extra: [],
} } };

function mockApi(testReply: Reply, configOver: Record<string, unknown> = {}) {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET' });
    const reply = u.includes('/admin/ai/config') ? aiConfig(configOver)
      : u.includes('/admin/ai/payload') ? aiPayload()
      : u.includes('/admin/ai/test') ? testReply : ME_ADMIN;
    return new Response(JSON.stringify(reply.body ?? null), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
}

/** 渲染真宿主，等这一屏挂上来再点那颗按钮。
 *  **裸 sleep 轮询**：包进 act 之后 lazy 那一层不推进（实测等不到按钮），裸 sleep 时 React 自己的调度照常跑。 */
async function clickTest() {
  render(
    <Providers>
      <RouterProvider router={createMemoryRouter([{ path: '/admin/*', element: <AdminLayout /> }], { initialEntries: ['/admin/ai'] })} />
    </Providers>,
  );
  let btn: HTMLElement | null = null;
  for (let i = 0; i < 40 && !btn; i++) {
    await sleep(100);
    btn = screen.queryByTestId('ai-test-run');
  }
  if (!btn) throw new Error('连通测试按钮没挂上来（这一屏还停在加载态？）');
  fireEvent.click(btn);
  await sleep(300);
}

const OK_BODY: Reply = { body: { data: { verdict: 'review', reason: '拿不准是否有外站导流', categories: ['spam'], model: 'deepseek-chat', latency_ms: 812, raw: '{"verdict":"review"}' } } };

it('没配密钥：不点外呼，就地说明「还没配 key」（不是「服务端内部错误」）', async () => {
  mockApi({ status: 500, body: { error: { code: 'common.internal', message: '服务端内部错误' } } }, { has_secret: false });
  await clickTest();
  const line = screen.queryByTestId('ai-test-fail');
  expect(line?.textContent).toContain('API Key');
  expect(calls.some((c) => c.url.includes('/admin/ai/test'))).toBe(false);
  expect(screen.queryByTestId('ai-test-result')).toBeNull();
  // D14：顶部那张卡喂的是**真 session**（昵称 / @handle / 角色三样都来自它），不是 AdminShell 里写死的那行。
  // 判据用**同一个容器里三样都在**表达「这一行是 session 拼出来的」——昵称与 handle 本来就该长一样，不必假装它们不同。
  const card = screen.getByText('当前管理员').parentElement;
  expect(card?.textContent).toContain('示范管理员');
  expect(card?.textContent).toContain('@demo-admin');
  expect(card?.textContent).toContain('管理员');
}, 30000);

it('401：就地说是密钥 / 鉴权的问题，页面还在（错误边界没接走）', async () => {
  mockApi({ status: 401, body: { error: { code: 'common.unauthorized', message: '请先登录' } } });
  await clickTest();
  const line = screen.queryByTestId('ai-test-fail');
  expect(line?.textContent).toContain('401');
  expect(line?.textContent).toContain('API Key');
  expect(screen.queryByText('出错了')).toBeNull();
}, 30000);

it('成功：照常出回执（失败态那条不许把成功路径带坏）', async () => {
  mockApi(OK_BODY);
  await clickTest();
  expect(screen.queryByTestId('ai-test-result')).toBeTruthy();
  expect(screen.queryByTestId('ai-test-fail')).toBeNull();
}, 30000);

/** 分档：每一档对应一个不同的动作（去配 key / 换 key / 看地址 / 看日志），所以必须分得开。 */
it('classifyTestFailure：401→auth、408→timeout、500→server，都带后端原话', () => {
  const auth = classifyTestFailure(new ApiError(401, 'common.unauthorized', '请先登录', 'req-1'));
  expect(auth.kind).toBe('auth');
  expect(auth.message).toContain('401');
  expect(auth.message).toContain('req-1');

  const timeout = classifyTestFailure(new ApiError(408, 'common.timeout', '请求超时'));
  expect(timeout.kind).toBe('timeout');
  expect(timeout.message).toContain('人工'); // 超时按「拿不准」转人工，不是放行

  // 网络层就没出去（client.ts 对 fetch 失败统一给 status 0）：也是「拿不准」，不能冒充密钥错
  const offline = classifyTestFailure(new ApiError(0, 'network', '网络不可用，请检查连接'));
  expect(offline.kind).toBe('timeout');

  const server = classifyTestFailure(new ApiError(500, 'common.internal', '服务端内部错误', 'req-9'));
  expect(server.kind).toBe('server');
  expect(server.message).toContain('req-9');
});
