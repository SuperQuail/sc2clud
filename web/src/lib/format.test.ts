import { describe, expect, it } from 'vitest';
import { formatMinute } from './format';

// D74（用户原话「评论时间显示过于冗余，精确到分钟即可」）：评论区不再吃整串 RFC3339。
// 断言断**形状**（日期 + 时:分）而不是具体日期：机器时区换了日子会平移，平移不该让这条红。
describe('formatMinute', () => {
  it('毫秒与秒全截掉，只留「YYYY-MM-DD HH:mm」', () => {
    expect(formatMinute('2026-10-16T07:31:02.123+08:00')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('解析不了的串给空串：Intl 对 Invalid Date 抛 RangeError，不能让它飞上页面', () => {
    expect(formatMinute('not-a-date')).toBe('');
    expect(formatMinute('')).toBe('');
  });
});
