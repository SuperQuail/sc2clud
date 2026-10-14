import type { AdminUser, Donation, DonationStats, NoticeDefault, Report, ReviewQueueItem, Role, Title } from '@/lib/api/admin';

// DevRoom 15-admin 的演示数据（**只给房间用**；产品路由由 ./admin-screens.tsx 的容器喂真端点）。
//
// 为什么还要留着它：屏改成 prop 驱动之后，房间与真站渲染的是**同一个组件**（照 topic-view 的分工），
// 房间给本地演示、真站给 lib/api。删掉它房间就渲染不出东西了，而不是「少一份重复实现」。
//
// 字段名照 @/lib/api/admin 的类型（那些类型照 forum/internal 的 DTO）——房间的数据也必须与契约同形，
// 否则出图看到的版式会在真数据下崩掉。

export const DEMO_ROLES: Role[] = [
  { id: 1, key: 'user', name: '普通用户', description: '注册即得的基线角色', depth: 0, badge_color: '', is_system: true, is_super: false, priority: 10, perm_keys: ['topic.create'], user_count: 1284 },
  { id: 2, key: 'creator', name: '认证创作者', description: '认证过战役/地图作者的账号', depth: 1, badge_color: '#2563eb', is_system: true, is_super: false, priority: 20, perm_keys: ['topic.create', 'resource.publish'], user_count: 63 },
  { id: 3, key: 'admin', name: '管理员', description: '用户、内容、分区与运营队列', depth: 2, badge_color: '#7c3aed', is_system: true, is_super: false, priority: 40, perm_keys: ['topic.create', 'post.review', 'user.ban'], user_count: 4 },
  { id: 4, key: 'superadmin', name: '超级管理员', description: '最高权限；系统里至少保留一个', depth: 3, badge_color: '#f97316', is_system: true, is_super: true, priority: 50, perm_keys: [], user_count: 2 },
];

export const DEMO_TITLES: Title[] = [
  { id: 't1', key: 'campaign_author', name: '战役作者', color: '#2563eb', description: '发布过完整战役的认证作者', archived_at: null },
  { id: 't2', key: 'map_artisan', name: '地图工匠', color: '#7c3aed', description: '长期维护对战/合作地图', archived_at: null },
  { id: 't3', key: 'veteran', name: '元老', color: '#f97316', description: '旧站迁移过来的创始成员', archived_at: null },
  { id: 't4', key: 'essence_star', name: '精华贡献者', color: '#16a34a', description: '旧站时期的头衔，已并入「战役作者」', archived_at: '2026-08-01T00:00:00Z' },
];

const R = (key: string) => DEMO_ROLES.find((r) => r.key === key)!;
const T = (key: string) => DEMO_TITLES.find((t) => t.key === key)!;

type Seed = {
  id: string; username: string; nickname: string; email: string; role: string; status: string;
  ev: string | null; ac: string | null; trusted: boolean; created: string; last: string | null;
  topics: number; replies: number; title: string | null;
  extra: AdminUser['extra_permissions']; sanctions: AdminUser['sanctions'];
};

const SEED: Seed[] = [
  {
    "id": "u1",
    "username": "demo-admin",
    "nickname": "示范管理员",
    "email": "demo-admin@example.com",
    "role": "admin",
    "status": "active",
    "ev": "2024-03-02T02:10:00Z",
    "ac": "2024-03-02T02:12:00Z",
    "trusted": true,
    "created": "2024-03-02T02:05:00Z",
    "last": "2026-10-12T09:20:00Z",
    "topics": 31,
    "replies": 402,
    "title": null,
    "extra": [],
    "sanctions": []
  },
  {
    "id": "u2",
    "username": "demo-overseer",
    "nickname": "督察官",
    "email": "demo-overseer@example.com",
    "role": "superadmin",
    "status": "active",
    "ev": "2023-11-11T01:00:00Z",
    "ac": "2023-11-11T01:00:00Z",
    "trusted": true,
    "created": "2023-11-11T00:50:00Z",
    "last": "2026-10-11T16:02:00Z",
    "topics": 8,
    "replies": 77,
    "title": "veteran",
    "extra": [],
    "sanctions": []
  },
  {
    "id": "u3",
    "username": "demo-infestor",
    "nickname": "感染虫",
    "email": "demo-infestor@example.com",
    "role": "user",
    "status": "banned",
    "ev": "2025-01-20T05:00:00Z",
    "ac": "2025-01-20T05:00:00Z",
    "trusted": false,
    "created": "2025-01-20T04:58:00Z",
    "last": "2026-09-30T11:40:00Z",
    "topics": 3,
    "replies": 51,
    "title": null,
    "extra": [],
    "sanctions": [
      {
        "kind": "mute_post",
        "scope": "全局",
        "until": "2026-11-30T15:59:59Z",
        "reason": "刷屏推广外站"
      }
    ]
  },
  {
    "id": "u4",
    "username": "demo-drone",
    "nickname": "工蜂",
    "email": "demo-drone@example.com",
    "role": "user",
    "status": "active",
    "ev": "2026-10-08T03:00:00Z",
    "ac": null,
    "trusted": false,
    "created": "2026-10-08T02:58:00Z",
    "last": "2026-10-12T12:30:00Z",
    "topics": 0,
    "replies": 0,
    "title": null,
    "extra": [],
    "sanctions": []
  },
  {
    "id": "u5",
    "username": "demo-ghost",
    "nickname": "幽灵特工",
    "email": "demo-ghost@example.com",
    "role": "user",
    "status": "active",
    "ev": null,
    "ac": null,
    "trusted": false,
    "created": "2026-10-11T22:10:00Z",
    "last": null,
    "topics": 0,
    "replies": 0,
    "title": null,
    "extra": [],
    "sanctions": []
  },
  {
    "id": "u6",
    "username": "demo-voidray",
    "nickname": "虚空辉光舰",
    "email": "demo-voidray@example.com",
    "role": "creator",
    "status": "active",
    "ev": "2023-12-01T00:00:00Z",
    "ac": "2023-12-01T00:00:00Z",
    "trusted": true,
    "created": "2023-12-01T00:00:00Z",
    "last": "2026-10-09T02:00:00Z",
    "topics": 54,
    "replies": 289,
    "title": "veteran",
    "extra": [
      {
        "key": "post.review",
        "expires_at": "2026-10-31T15:59:59Z"
      },
      {
        "key": "board.moderate",
        "expires_at": "2026-12-01T15:59:59Z"
      }
    ],
    "sanctions": []
  }
];

export const DEMO_USERS: AdminUser[] = SEED.map((s) => ({
  id: s.id, username: s.username, nickname: s.nickname, email: s.email, avatar: null,
  role: R(s.role), extra_permissions: s.extra, status: s.status,
  email_verified_at: s.ev, activated_at: s.ac, trusted: s.trusted,
  created_at: s.created, last_login_at: s.last,
  title: s.title ? { name: T(s.title).name, color: T(s.title).color } : null,
  topic_count: s.topics, reply_count: s.replies, sanctions: s.sanctions,
}));

const RB = (slug: string, name: string) => ({ slug, name });
const RBrief = (handle: string, nickname: string) => ({ handle, nickname, avatar: '', avatar_small: '' });

/** 审核队列的演示数据：字段名照 review_queue.go 的 ReviewQueueItemDTO，
 *  `review_verdict` 一律当真（**不从 review_state 推** —— 交接单 C11）。 */
export const DEMO_REVIEW: ReviewQueueItem[] = [
  {
    id: 't-1', board: RB('custom-campaign', '自制战役'), author: RBrief('demo-voidray', '虚空辉光舰'),
    kind: 'resource', title: '第三章「余烬」发布：隐藏结局与平衡性改动',
    excerpt: '这一章加了七张图、一条隐藏结局线，改动说明与下载都在正文里……',
    review_state: 'pending', review_note: '拿不准是否有外站导流', review_source: 'ai',
    reviewer: null, reviewed_at: '2026-10-12T11:00:00Z', review_verdict: 'review',
    created_at: '2026-10-12T09:20:00Z', updated_at: '2026-10-12T10:05:00Z',
  },
  {
    id: 't-2', board: RB('tool-dev', '工具与开发'), author: RBrief('demo-marine', '陆战队员'),
    kind: 'discussion', title: '触发器里 Wait 之后变量被清空，是我写法不对吗',
    excerpt: '每次 Wait 完局部变量就没了，想确认是不是要用静态参数……',
    review_state: 'approved', review_note: null, review_source: 'manual',
    reviewer: RBrief('demo-admin', '示范管理员'), reviewed_at: '2026-10-12T12:10:00Z', review_verdict: 'approve',
    created_at: '2026-10-12T08:00:00Z', updated_at: '2026-10-12T12:10:00Z',
  },
  {
    id: 't-3', board: RB('announcement', '公告'), author: RBrief('demo-roach', '蟑螂'),
    kind: 'repost', title: '【转载】SC2 编辑器常见坑位整理（2024 版）',
    excerpt: '整理自社区帖，标注了原作者与出处……',
    review_state: 'rejected', review_note: '未标注原作者与出处链接，补齐后可重新提交', review_source: 'manual',
    reviewer: RBrief('demo-admin', '示范管理员'), reviewed_at: '2026-10-11T03:00:00Z', review_verdict: 'reject',
    created_at: '2026-10-10T21:00:00Z', updated_at: '2026-10-11T03:00:00Z',
  },
];

/** 举报队列的演示数据：字段名照 report/dto.go 的 Report（**target_label**，不是 target_title）。 */
export const DEMO_REPORTS: Report[] = [
  {
    id: 'r-1', target_type: 'topic', target_id: 't-1',
    target_label: '第三章「余烬」发布：隐藏结局与平衡性改动',
    board: RB('custom-campaign', '自制战役'), reason: 'spam', detail: '正文里有外站下载链接，怀疑是导流。',
    reporter: RBrief('demo-marine', '陆战队员'), state: 'open', handler: null, handled_at: null,
    handle_note: '', created_at: '2026-10-12T07:00:00Z', open_reports: 2, created: true,
  },
  {
    id: 'r-2', target_type: 'post', target_id: 'p-9',
    target_label: '回复 #12（在「触发器里 Wait 之后变量被清空」下）',
    board: RB('tool-dev', '工具与开发'), reason: 'abuse', detail: '人身攻击。',
    reporter: RBrief('demo-voidray', '虚空辉光舰'), state: 'open', handler: null, handled_at: null,
    handle_note: '', created_at: '2026-10-11T18:00:00Z', open_reports: 1, created: true,
  },
  {
    id: 'r-3', target_type: 'user', target_id: 'u-9', target_label: '@demo-roach（蟑螂）',
    board: null, reason: 'illegal', detail: '发布违规内容。',
    reporter: RBrief('demo-admin', '示范管理员'), state: 'handled',
    handler: RBrief('demo-admin', '示范管理员'), handled_at: '2026-10-11T02:00:00Z',
    handle_note: '已封号', created_at: '2026-10-10T20:00:00Z', open_reports: 0, created: true,
  },
];

/** 打赏核验队列的演示数据：字段名照 reward/dto.go 的 Donation（**amount_cents 是整数分**）。 */
export const DEMO_DONATIONS: Donation[] = [
  {
    id: 'd-1', amount_cents: 5000, txn_id: '2026101200001', state: 'pending', note: '第三章加油',
    post_id: 't-1', channel_id: 'c-1',
    donor: RBrief('demo-marine', '陆战队员'), recipient: RBrief('demo-voidray', '虚空辉光舰'),
    created_at: '2026-10-12T06:00:00Z',
  },
  {
    id: 'd-2', amount_cents: 2000, txn_id: '2026101100007', state: 'pending', note: '',
    post_id: 't-1', channel_id: 'c-2',
    donor: RBrief('demo-thor', '雷神'), recipient: RBrief('demo-voidray', '虚空辉光舰'),
    created_at: '2026-10-11T05:00:00Z',
  },
  {
    id: 'd-3', amount_cents: 10000, txn_id: '2026100900003', state: 'approved', note: '地图包月支持',
    post_id: '', channel_id: 'c-1',
    donor: RBrief('demo-admin', '示范管理员'), recipient: RBrief('demo-thor', '雷神'),
    verifier: RBrief('demo-admin', '示范管理员'), verified_at: '2026-10-09T08:00:00Z',
    created_at: '2026-10-09T03:00:00Z',
  },
];

/** DonationStats：public_* 只算双方都同意公开的，all_* 是全部 approved。 */
export const DEMO_DONATION_STATS: DonationStats = {
  public_total_cents: 150000,
  all_total_cents: 320000,
  public_count: 12,
  all_count: 26,
  leaderboard: [
    { user: RBrief('demo-voidray', '虚空辉光舰'), total_cents: 210000, count: 14 },
    { user: RBrief('demo-thor', '雷神'), total_cents: 110000, count: 12 },
  ],
};

/** 按渠道的默认提示文案（channel 值域 default|wechat|alipay|other）。 */
export const DEMO_NOTICE_DEFAULTS: NoticeDefault[] = [
  { channel: 'default', text: '感谢支持，我会继续更新。' },
  { channel: 'wechat', text: '微信收款码已更新，打赏后请回来申报单号。' },
  { channel: 'alipay', text: '支付宝收款码同上。' },
  { channel: 'other', text: '' },
];
