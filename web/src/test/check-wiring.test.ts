import { describe, expect, it } from 'vitest';
import {
  checkBaseline,
  exprToPattern,
  extractCalls,
  extractRoutes,
  isGhost,
  isWired,
  routeRegex,
  suggestScreen,
} from '../../scripts/check-wiring.ts';
import type { Baseline, Call, Route } from '../../scripts/check-wiring.ts';

// 这个检查器的逻辑全是纯函数，测试直接喂源码字符串 —— 不用真文件、不用真后端。
// 放在 src/ 下是因为 vitest 的 include 是 src/**/*.test.{ts,tsx}（vite.config.ts），
// 而本次改动不许碰那份配置：放进 src/test/ 就是零配置纳入 pnpm test 的最小改法。

const route = (method: string, path: string): Route => ({ method, path, file: 'f.go', line: 1, domain: 'demo' });
const call = (pattern: string): Call => ({ pattern, file: 'a.ts', line: 1 });

describe('真源 A：从 handler.go 取路由', () => {
  const src = [
    'func (h *Handler) Register(rg *gin.RouterGroup) {',
    '  read := rg.Group("", httpx.ValidPathIDs("id"))',
    '  read.GET("/boards", h.listBoards)',
    '  // read.GET("/commented-out", h.nope)',
    '  rg.POST("/topics/:id/pin", w("/topics/:id/pin", requireLogin, h.pinTopic)...)',
    '  g := rg.Group("/messages", requireLogin)',
    '  g.GET("", h.listConversations)',
    '  g.DELETE("/:id", h.remove)',
    '}',
  ].join('\n');

  it('带上同文件 Group() 前缀，w() 只是中间件包装', () => {
    expect(extractRoutes(src, 'forum/internal/demo/handler.go').map((r) => r.method + ' ' + r.path)).toEqual([
      'GET /boards',
      'POST /topics/:id/pin',
      'GET /messages',
      'DELETE /messages/:id',
    ]);
  });

  it('整行注释里的示例路由不算（文档里全是这种行）', () => {
    expect(extractRoutes(src, 'forum/internal/demo/handler.go').some((r) => r.path.includes('commented'))).toBe(false);
  });
});

describe('真源 B：从 lib/api 取 api() 首参', () => {
  it('字面量保留、encodeURIComponent/标识符折成 .*', () => {
    expect(exprToPattern("'topics/' + encodeURIComponent(id) + '/posts'")).toBe('topics/.*/posts');
    expect(exprToPattern("'boards'")).toBe('boards');
    expect(exprToPattern('handle')).toBe('.*');
    expect(exprToPattern("'messages/' + encodeURIComponent(handle)")).toBe('messages/.*');
    expect(exprToPattern('')).toBeNull();
  });

  const src = [
    'export async function fetchTopic(id: string) {',
    "  return api<TopicDetail>('topics/' + encodeURIComponent(id), { signal });",
    '}',
    'export async function verifySource(id: string, sid: string) {',
    "  const path = 'topics/' + encodeURIComponent(id) + '/sources/' + encodeURIComponent(sid) + '/verify';",
    "  return api<{ ok: boolean }>(path, { method: 'POST' });",
    '}',
    "export const km = () => apiPage('admin/reports', { query });",
    'const p = await apiEnvelope<{ data?: Msg[] }>(',
    "  'messages/' + encodeURIComponent(handle),",
    '  { query },',
    ');',
    '// 注释里提一句 api(\'foo/bar\') 不该被当成接线',
  ].join('\n');

  it('api / apiPage / apiEnvelope 都认，跨行首参取到逗号为止', () => {
    expect(extractCalls(src, 'web/src/lib/api/demo.ts').calls.map((c) => c.pattern)).toEqual([
      'topics/.*',
      'topics/.*/sources/.*/verify',
      'admin/reports',
      'messages/.*',
    ]);
  });

  it('首参是同文件的 const 简单常量：顺着找（verifySource 就是这种形状）', () => {
    expect(extractCalls(src, 'web/src/lib/api/demo.ts').calls.some((c) => c.pattern.endsWith('/verify'))).toBe(true);
  });

  it('定义行不是调用；首参是形参只算「间接」', () => {
    const def = extractCalls('export async function api<T>(path: string, req: Req = {}): Promise<T> {', 'f.ts');
    expect(def.calls).toEqual([]);
    const arg = extractCalls('export function go(path: string) {\n  return api(path, { method: \'POST\' });\n}', 'f.ts');
    expect(arg.calls).toEqual([]);
    expect(arg.indirect.map((x) => x.raw)).toEqual(['path']);
  });

  it('注释行里的 api(…) 不算接线', () => {
    expect(extractCalls("// api('foo/bar') 是文档里的例子", 'f.ts').calls).toEqual([]);
  });
});

describe('对账：路由模板 × 候选模式', () => {
  it('路由的 :param 当一段，候选的 .* 通配', () => {
    expect(routeRegex('/topics/:id/pin').test('topics/.*/pin')).toBe(true);
    expect(isWired(route('POST', '/topics/:id/pin'), [call('topics/.*/pin')])).toBe(true);
    expect(isWired(route('POST', '/topics/:id/pin'), [call('topics/.*/lock')])).toBe(false);
  });

  it('幽灵：前端有候选、没有任何路由接得住', () => {
    const routes = [route('GET', '/topics/:id'), route('POST', '/topics/:id/pin')];
    expect(isGhost('topics/.*/pin', routes)).toBe(false);
    expect(isGhost('foo/bar', routes)).toBe(true);
  });

  it('建议落地屏：已知给屏，未知给 <待定>', () => {
    expect(suggestScreen('/topics/:id/pin')).toBe('web/src/routes/topic.tsx');
    expect(suggestScreen('/me/sessions')).toBe('web/src/routes/settings.tsx');
    expect(suggestScreen('/who-knows')).toBe('<待定>');
  });
});

describe('基线不许腐烂', () => {
  const routes = [route('POST', '/topics/:id/pin'), route('GET', '/titles')];
  const orphans = [route('GET', '/titles')];
  const ghosts = [call('healthz')];

  it('缺 reason → 报错（基线不是垃圾桶）', () => {
    const base: Baseline = { routes: [{ route: 'GET /titles', reason: '  ' }], ghosts: [] };
    expect(checkBaseline(base, routes, orphans, ghosts).problems.join()).toContain('缺 reason');
  });

  it('已不存在的路由、已被调用的路由、已消失的幽灵 → 都是过期条目', () => {
    const base: Baseline = {
      routes: [
        { route: 'GET /titles', reason: 'r' },
        { route: 'GET /gone', reason: 'r' },
        { route: 'POST /topics/:id/pin', reason: 'r' },
      ],
      ghosts: [{ pattern: 'search', reason: 'r' }],
    };
    const problems = checkBaseline(base, routes, orphans, ghosts).problems;
    expect(problems.filter((p) => p.startsWith('过期条目')).length).toBe(3);
  });

  it('对得上的条目原样保留（它是豁免的凭据）', () => {
    const base: Baseline = { routes: [{ route: 'GET /titles', reason: '真孤儿' }], ghosts: [{ pattern: 'healthz', reason: '探针' }] };
    const got = checkBaseline(base, routes, orphans, ghosts);
    expect(got.problems).toEqual([]);
    expect(got.keptOrphans.map((r) => r.method + ' ' + r.path)).toEqual(['GET /titles']);
    expect(got.keptGhosts.map((c) => c.pattern)).toEqual(['healthz']);
  });
});
