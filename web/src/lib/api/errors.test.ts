import { describe, expect, it } from 'vitest';
import { ApiError, apiErrorLine } from './errors';

// D65：错误行统一规则 —— message 优先、fields 次之、request_id 只作次要附注。
describe('apiErrorLine', () => {
  it('message 在前、字段级理由其次、错误编号最后', () => {
    const e = new ApiError(400, 'auth.token_invalid', '验证码不正确或已过期', 'req-7788', { username: '太短' });
    expect(apiErrorLine(e)).toBe('验证码不正确或已过期（username：太短）（错误编号 req-7788）');
  });

  it('没有/只有 `_` 字段时不添括号，message 原样', () => {
    expect(apiErrorLine(new ApiError(400, 'auth.token_invalid', '验证码不正确或已过期'))).toBe('验证码不正确或已过期');
    expect(apiErrorLine(new ApiError(400, 'common.invalid_input', '参数错误', 'r1', { _: '整体没过' }))).toBe('参数错误（整体没过）（错误编号 r1）');
  });
});
