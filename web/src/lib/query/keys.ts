// query key 只有这一处定义（前端方案 §5.3）：组件里不许手写字符串数组
export type TopicFilter = { board?: string; kind?: string; sort?: string; q?: string };

export const qk = {
  health: () => ['health'] as const,
  me: () => ['me'] as const,
  site: () => ['site'] as const,
  boards: () => ['boards'] as const,
  topics: (f: TopicFilter) => ['topics', f] as const,
  topic: (id: string) => ['topic', id] as const,
  posts: (id: string) => ['topic', id, 'posts'] as const,
  profile: (handle: string) => ['profile', handle] as const,
  unread: () => ['notifications', 'unread'] as const,
  search: (type: string, q: string) => ['search', type, q] as const,
};
