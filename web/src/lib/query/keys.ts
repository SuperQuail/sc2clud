import type { TopicFilter } from '@/lib/api/forum';

// query key 只有这一处定义（前端方案 §5.3）：组件里不许手写字符串数组。
// 分页列表的 key 里带 cursor 是必须的：useInfiniteQuery 每页一次请求，key 不带 cursor 会互相覆盖。
export type { TopicFilter };

export const qk = {
  health: () => ['health'] as const,
  me: () => ['me'] as const,
  site: () => ['site'] as const,
  boards: () => ['boards'] as const,
  board: (slug: string) => ['board', slug] as const,
  topics: (f: TopicFilter) => ['topics', f] as const,
  topicsPage: (f: TopicFilter, cursor: string | null) => ['topics', f, cursor] as const,
  topic: (id: string) => ['topic', id] as const,
  posts: (id: string) => ['topic', id, 'posts'] as const,
  profile: (handle: string) => ['profile', handle] as const,
  userTopics: (handle: string) => ['profile', handle, 'topics'] as const,
  unread: () => ['notifications', 'unread'] as const,
  search: (type: string, q: string) => ['search', type, q] as const,
};
