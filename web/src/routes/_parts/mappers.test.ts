import { describe, expect, it } from 'vitest';
import type { Post } from '@/lib/api/forum';
import { toComments } from './mappers';

// 输入照实测的线格式造（created_at 带「毫秒 + +08:00」，正是 D74 报的那种串）。
function post(over: Partial<Post>): Post {
  return {
    id: 'p-1',
    parent_id: null,
    author: { handle: 'tang', nickname: '唐' },
    content_html: '<p>正文</p>',
    like_count: 0,
    my_vote: 0,
    created_at: '2026-10-16T07:31:02.123+08:00',
    ...over,
  } as Post;
}

describe('toComments', () => {
  it('D74：createdAt 是分钟精度的展示串，不是 RFC3339 原样透传', () => {
    const [c] = toComments([post({ created_at: '2026-10-16T07:31:02.123+08:00' })]);
    expect(c).toBeTruthy();
    expect(c!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('解析不了的 created_at 给空串，映射不能抛', () => {
    const [c] = toComments([post({ created_at: 'not-a-date' })]);
    expect(c!.createdAt).toBe('');
  });

  it('D71：floor=1 的主楼不进评论列表，正文区该有的那层不复读；没带 floor 的老响应也不被误伤', () => {
    const list = toComments([
      post({ id: 'p-1', floor: 1 }),
      post({ id: 'p-2', floor: 2 }),
      post({ id: 'p-3', floor: 3, parent_id: 'p-2' }),
      post({ id: 'p-4' }),
    ]);
    expect(list.map((c) => c.id)).toEqual(['p-2', 'p-4']);
    expect(list[0]!.replies?.total).toBe(1);
  });
});
