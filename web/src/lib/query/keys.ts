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
  /** 消息设置（notice-center-view 的 SettingsPane）——组件里不许手写字符串数组（本文件头那条） */
  noticeSettings: () => ['notifications', 'settings'] as const,
  /** 关注状态（L5）：对象进 key —— 改一个分区的关注不影响另一个 */
  followBoard: (slug: string) => ['follow', 'board', slug] as const,
  followUser: (handle: string) => ['follow', 'user', handle] as const,
  /** 某人**持有**的头衔 + 佩戴中的那一个（lib/api/title.ts）：本人主页的下拉靠它 */
  userTitles: (handle: string) => ['titles', handle] as const,
  unreadMessages: () => ['messages', 'unread'] as const,
  conversations: () => ['messages', 'conversations'] as const,
  thread: (handle: string) => ['messages', 'thread', handle] as const,
  releases: () => ['launcher', 'releases'] as const,
  releaseLatest: (channel: string) => ['launcher', 'latest', channel] as const,
  /** 管理后台（routes/admin.tsx）：筛选参数进 key，换一档就是另一次查询 */
  adminUsers: (f: unknown) => ['admin', 'users', f] as const,
  adminUserDetail: (id: string) => ['admin', 'users', id, 'detail'] as const,
  /** 分区管理（C2）：列表不翻页；ACL 与版主按分区取，所以对象（分区 id）进 key */
  adminBoards: () => ['admin', 'boards'] as const,
  adminBoardAcl: (id: string) => ['admin', 'boards', id, 'acl'] as const,
  adminBoardModerators: (id: string) => ['admin', 'boards', id, 'moderators'] as const,
  adminDiagnostics: () => ['admin', 'diagnostics'] as const,
  adminRoles: () => ['admin', 'roles'] as const,
  adminPermissions: () => ['admin', 'permissions'] as const,
  adminReview: (f: unknown) => ['admin', 'review', f] as const,
  /** Issue 管理屏（归档档位 / 状态 / 类型 / 搜索词 / 游标都在里面） */
  adminIssues: (f: unknown) => ['admin', 'issues', f] as const,
  adminReports: (f: unknown) => ['admin', 'reports', f] as const,
  adminRewards: (f: unknown) => ['admin', 'rewards', f] as const,
  adminRewardStats: () => ['admin', 'rewards', 'stats'] as const,
  adminNoticeDefaults: () => ['admin', 'rewards', 'notice-defaults'] as const,
  adminTitles: () => ['admin', 'titles'] as const,
  adminMail: () => ['admin', 'mail'] as const,
  /** 邮件模板（D37）：列表一次拿四行（含内置源回显），不按 kind 分 key */
  adminMailTemplates: () => ['admin', 'mail-templates'] as const,
  adminSiteSettings: () => ['admin', 'site-settings'] as const,
  adminDomains: () => ['admin', 'site-domains'] as const,
  adminAnnouncements: () => ['admin', 'announcements'] as const,
  adminBanners: () => ['admin', 'banners'] as const,
  adminAudit: (f: unknown) => ['admin', 'audit', f] as const,
  adminAiConfig: () => ['admin', 'ai-config'] as const,
  /** 用户组（D38）：目录不翻页；组员与分区组矩阵按 id 取 */
  adminGroups: () => ['admin', 'groups'] as const,
  adminGroupMembers: (id: string) => ['admin', 'groups', id, 'members'] as const,
  adminBoardGroupAcl: (id: string) => ['admin', 'boards', id, 'group-acl'] as const,
  /** 搜索：type 与 q 都在 key 里 —— 换一个词就是另一次查询，不能互相覆盖 */
  search: (type: string, q: string) => ['search', type, q] as const,
  /** 打赏域（lib/api/rewards.ts）：本人的收款码 / 设置 / 我发出的申报，以及某个人的收款码 */
  paymentChannels: () => ['rewards', 'channels'] as const,
  donationSettings: () => ['rewards', 'settings'] as const,
  myDonations: () => ['rewards', 'mine'] as const,
  userChannels: (handle: string) => ['rewards', 'channels', handle] as const,
};
