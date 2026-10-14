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
  notifications: () => ['notifications', 'list'] as const,
  unread: () => ['notifications', 'unread'] as const,
  unreadMessages: () => ['messages', 'unread'] as const,
  conversations: () => ['messages', 'conversations'] as const,
  thread: (handle: string) => ['messages', 'thread', handle] as const,
  releases: () => ['launcher', 'releases'] as const,
  releaseLatest: (channel: string) => ['launcher', 'latest', channel] as const,
  /** 管理后台（routes/admin.tsx）：筛选参数进 key，换一档就是另一次查询 */
  adminUsers: (f: unknown) => ['admin', 'users', f] as const,
  adminRoles: () => ['admin', 'roles'] as const,
  adminPermissions: () => ['admin', 'permissions'] as const,
  adminReview: (f: unknown) => ['admin', 'review', f] as const,
  adminReports: (f: unknown) => ['admin', 'reports', f] as const,
  adminRewards: (f: unknown) => ['admin', 'rewards', f] as const,
  adminRewardStats: () => ['admin', 'rewards', 'stats'] as const,
  adminNoticeDefaults: () => ['admin', 'rewards', 'notice-defaults'] as const,
  adminTitles: () => ['admin', 'titles'] as const,
  adminMail: () => ['admin', 'mail'] as const,
  adminSiteSettings: () => ['admin', 'site-settings'] as const,
  adminDomains: () => ['admin', 'site-domains'] as const,
  adminAnnouncements: () => ['admin', 'announcements'] as const,
  adminBanners: () => ['admin', 'banners'] as const,
  adminAudit: (f: unknown) => ['admin', 'audit', f] as const,
  adminAiConfig: () => ['admin', 'ai-config'] as const,
  /** 搜索：type 与 q 都在 key 里 —— 换一个词就是另一次查询，不能互相覆盖 */
  search: (type: string, q: string) => ['search', type, q] as const,
};
