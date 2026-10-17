import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { Providers } from '@/app/providers';
import { AdminLayout } from '@/routes/admin';
import { act, fireEvent } from '@testing-library/react';

// D34 的**容器接线**（真宿主 AdminLayout → 容器 → 屏）：
//   ① 选图 → 干跑**立刻重算**：POST /admin/ai/payload 换成 multipart（probe + file 若干），回执进 images[]；
//   ② 点「测试」且当前带着图 → POST /admin/ai/test 发 **FormData**（不是 JSON 字符串）；
//   ③ 没带图时两条照旧走 JSON（旧路径一字不改的另一半在 routes/admin/ai.test.tsx 的三条既有用例里钉着）。
//
// 先红：旧实现没有选图入口（input[type=file] 不存在），第一步就挂 —— 挂在「选不了图」上就是证红。

afterEach(() => { vi.unstubAllGlobals(); });

type Call = { url: string; method: string; init?: RequestInit };
const calls: Call[] = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function aiConfig(): Reply {
  return { body: { data: {
    enabled: true, provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-flash',
    thinking: false, strict_mode: false, timeout_ms: 20000, max_output_tokens: 1024, temperature: 0,
    prompt: '', prompt_report: '', probe_sample: '标题：连通性测试\n\n正文：这是一次连接测试。',
    has_secret: true, secret_updated_at: '2026-10-01T00:00:00Z',
    last_ok_at: null, last_error: '', last_error_at: null,
  } } };
}
type Reply = { status?: number; body?: unknown };

function aiPayload(multipart: boolean): Reply {
  return { body: { data: {
    source: 'probe', topic_id: 0, title: '', trigger: 'create', open_reports: 0,
    system: '审核员提示词。', user_prefix: '', user_title: '', user_body: '',
    user_text: '标题：连通性测试', has_image_markdown: false,
    image_attachment_count: multipart ? 2 : 0,
    images: multipart
      ? [
          { position: 0, floor: 0, hash: '样例图一.png', mime: 'image/png', bytes: 100, sent: true, note: '' },
          { position: 1, floor: 0, hash: '样例图二.png', mime: 'image/png', bytes: 200, sent: true, note: '' },
        ]
      : [],
    image_count: multipart ? 2 : 0, image_skipped: 0, image_bytes: multipart ? 300 : 0,
    image_limit: 4, image_max_bytes: 2097152, image_read_failed: false,
    model: 'deepseek-flash', max_output_tokens: 1024, strict_mode: false, tool_name: 'submit_review',
    categories: ['spam', 'ad'],
  } } };
}

function mockApi() {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', init });
    const reply = u.includes('/admin/ai/config') ? aiConfig()
      : u.includes('/admin/ai/payload') ? aiPayload(init?.body instanceof FormData)
      : u.includes('/admin/ai/test') ? aiTest()
      : ME_ADMIN;
    return new Response(JSON.stringify(reply.body ?? null), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }));
}

function aiTest(): Reply {
  return { body: { data: {
    verdict: 'review', reason: '拿不准是否有外站导流', categories: ['spam'],
    model: 'deepseek-flash', latency_ms: 812, raw: '{"verdict":"review"}',
    topic_id: 0, image_count: 2, image_skipped: 0,
    images: [
      { position: 0, floor: 0, hash: '样例图一.png', mime: 'image/png', bytes: 100, sent: true, note: '' },
      { position: 1, floor: 0, hash: '样例图二.png', mime: 'image/png', bytes: 200, sent: true, note: '' },
    ],
  } } };
}

const ME_ADMIN: Reply = { body: { data: {
  id: 'u-1', handle: 'demo-admin', nickname: '示范管理员', avatar: null,
  email_verified: true, perms: ['site.setting'], is_super: false,
  role: { key: 'admin', name: '管理员' }, extra: [],
} } };

/** 渲染真宿主并等这一屏挂上来（连接通面板里的选图入口）；照 admin/ai.test.tsx 的**裸 sleep 轮询**。 */
async function mountScreen() {
  render(
    <Providers>
      <RouterProvider router={createMemoryRouter([{ path: '/admin/*', element: <AdminLayout /> }], { initialEntries: ['/admin/ai'] })} />
    </Providers>,
  );
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if (screen.queryByTestId('ai-probe-add-image') && document.querySelector('input[type=file]')) return;
  }
  throw new Error('样例编辑器的选图入口没挂上来（要等配置与干跑挂完）');
}

/** 往 headless FilePicker 里塞两张文件并触发 change。 */
async function pickImages() {
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  const mk = (name: string, size: number) => new File([new Uint8Array(size)], name, { type: 'image/png' });
  const files = [mk('样例图一.png', 100), mk('样例图二.png', 200)];
  const list = Object.assign([...files], { item: (i: number) => files[i] ?? null });
  Object.defineProperty(input, 'files', { configurable: true, value: list });
  await act(async () => {
    fireEvent.change(input, { target: { files: list as unknown as FileList } });
  });
}

it('选了两张图：干跑立刻重算成 multipart，回执里两张图都在（所见即所发）', async () => {
  mockApi();
  await mountScreen();
  const before = calls.filter((c) => c.url.includes('/admin/ai/payload')).length;
  expect(before).toBeGreaterThanOrEqual(1); // 没选图时的首轮干跑（JSON）

  await pickImages();
  for (let i = 0; i < 20; i++) {
    await sleep(100);
    if (calls.filter((c) => c.url.includes('/admin/ai/payload')).length > before) break;
  }
  const payloadCalls = calls.filter((c) => c.url.includes('/admin/ai/payload'));
  const last = payloadCalls[payloadCalls.length - 1]!;
  expect(last.init?.body).toBeInstanceOf(FormData);
  const form = last.init?.body as FormData;
  expect(form.get('probe')).toBeTruthy(); // probe 文本字段总在（可空串）
  expect(form.getAll('file')).toHaveLength(2);
  // 干跑回执进屏：两张图逐张记账
  const rows = await screen.findAllByTestId('ai-payload-image');
  expect(rows).toHaveLength(2);
  expect(rows[0]?.textContent).toContain('会发给模型');
});

it('带着图点「测试」：POST /admin/ai/test 发 FormData（还在 jsdom 里看得到 file 部件）', async () => {
  mockApi();
  await mountScreen();
  await pickImages();
  await sleep(300);
  calls.length = 0;
  fireEvent.click(screen.getByTestId('ai-test-run'));
  await sleep(300);
  const testCalls = calls.filter((c) => c.url.includes('/admin/ai/test'));
  expect(testCalls).toHaveLength(1);
  expect(testCalls[0]?.init?.body).toBeInstanceOf(FormData);
  const form = testCalls[0]!.init!.body as FormData;
  expect(form.getAll('file')).toHaveLength(2);
  expect(form.getAll('file').map((x) => (x as File).name)).toEqual(['样例图一.png', '样例图二.png']);
  // 成功回执照常渲染（错误包络路径没动，isApiError 的判据仍由坏时回 4xx 的用例钉着）
  for (let i = 0; i < 10; i++) {
    await sleep(100);
    if (screen.queryByTestId('ai-test-result')) break;
  }
  expect(screen.queryByTestId('ai-test-result')).toBeTruthy();
});
