import { describe, expect, it } from 'vitest';
import { ApiError, apiErrorLine, apiErrorLineWith } from './errors';

// D65：错误行统一规则 —— message 优先、fields 次之、request_id 只作次要附注。
// D70：message 是空串时**绝不能只剩编号** —— 先用 code→中文原因表，再用 HTTP 状态兜底。
describe('apiErrorLine', () => {
  it('message 在前、字段级理由其次、错误编号最后', () => {
    const e = new ApiError(400, 'auth.token_invalid', '验证码不正确或已过期', 'req-7788', { username: '太短' });
    expect(apiErrorLine(e)).toBe('验证码不正确或已过期（username：太短）（错误编号 req-7788）');
  });

  it('没有/只有 `_` 字段时不添括号，message 原样', () => {
    expect(apiErrorLine(new ApiError(400, 'auth.token_invalid', '验证码不正确或已过期'))).toBe('验证码不正确或已过期');
    expect(apiErrorLine(new ApiError(400, 'common.invalid_input', '参数错误', 'r1', { _: '整体没过' }))).toBe('参数错误（整体没过）（错误编号 r1）');
  });

  it('message 是空白时按 code 给中文原因，编号仍在末尾', () => {
    expect(apiErrorLine(new ApiError(500, 'common.internal', '', 'req-1'))).toBe('服务器错误（错误编号 req-1）');
    expect(apiErrorLine(new ApiError(429, 'common.rate_limited', '   '))).toBe('操作太频繁');
    expect(apiErrorLine(new ApiError(0, 'network', '', 'req-2'))).toBe('网络不可用，请检查连接（错误编号 req-2）');
  });

  it('只给 requestId（message 空、code 也陌生）时按 HTTP 状态兜底，不留空行', () => {
    expect(apiErrorLine(new ApiError(503, 'weird.code', '', 'req-3'))).toBe('服务器错误（错误编号 req-3）');
    expect(apiErrorLine(new ApiError(418, 'weird.code', '', 'req-4'))).toBe('请求失败（HTTP 418）（错误编号 req-4）');
  });

  it('message 空但 fields 有理由时，字段理由当正文（不再重复进括号）', () => {
    expect(apiErrorLine(new ApiError(400, 'common.invalid_input', '', 'r1', { title: '太短' }))).toBe('title：太短（错误编号 r1）');
    expect(apiErrorLine(new ApiError(400, 'custom.code', '', undefined, { _: '整体没过' }))).toBe('整体没过');
  });
});

// 各页那张业务话术表还归各页；这里只保证编号与字段理由的位置不出现第二个真源。
describe('apiErrorLineWith', () => {
  it('换正文，编号与字段理由的位置仍由同一处规则决定', () => {
    const e = new ApiError(403, 'forum.board_denied', '没有权限', 'r9', { board: '只读区' });
    expect(apiErrorLineWith(e, '这个分区不允许你发帖。')).toBe('这个分区不允许你发帖。（board：只读区）（错误编号 r9）');
  });

  it('正文留空 = 走 message 为空那条规则', () => {
    expect(apiErrorLineWith(new ApiError(400, 'x', '参数错误', 'r1', { title: '太短' }), '')).toBe('title：太短（错误编号 r1）');
  });
});
