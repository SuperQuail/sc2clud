import type { AdminUser, AdminUserDetail, AiConfig, AiPayloadView, AiTestView, Announcement, AuditItem, Banner, Permission, Donation, DonationStats, Domain, MailAccount, MailTemplate, MailTemplatePreview, NoticeDefault, Report, ReviewQueueItem, Role, SettingItem, Title } from '@/lib/api/admin';

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
  /** 追加权限与处罚**不在列表项里**：它们进下面的 DEMO_USER_DETAIL（详情接口的三张表）。 */
  extra: { key: string; expires_at: string | null }[];
  sanctions: AdminUserDetail['sanctions'];
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
        "id": 9001,
        "action": "post",
        "board": null,
        "until": "2026-11-30T15:59:59Z",
        "created_at": "2026-10-30T15:59:59Z",
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

// 列表项照 AdminUserDTO **逐字段**（role 只有 key/name/badge_color；avatar、extra_permissions、
// title、sanctions **都不在这一行**里 —— 那是详情接口的三张表，见下面的 DEMO_USER_DETAIL）。
export const DEMO_USERS: AdminUser[] = SEED.map((s) => ({
  id: s.id, username: s.username, nickname: s.nickname, email: s.email,
  role: { key: R(s.role).key, name: R(s.role).name, badge_color: R(s.role).badge_color },
  status: s.status,
  email_verified_at: s.ev, activated_at: s.ac, trusted: s.trusted, level: 1,
  created_at: s.created, last_login_at: s.last,
  topic_count: s.topics, reply_count: s.replies,
}));

/** 详情（GET /admin/users/{id}）的演示数据：列表项 + 三张关联表。 */
export const DEMO_USER_DETAIL: Record<string, AdminUserDetail> = Object.fromEntries(
  SEED.map((s) => [s.id, {
    ...DEMO_USERS.find((u) => u.id === s.id)!,
    sanctions: s.sanctions,
    user_permissions: s.extra.map((x) => ({ key: x.key, name: x.key, reason: '（房间演示）', expires_at: x.expires_at, granted_at: '2026-10-01T00:00:00Z' })),
    user_titles: s.title
      ? [{ id: T(s.title).id, key: T(s.title).key, name: T(s.title).name, color: T(s.title).color, description: T(s.title).description ?? '', granted_at: '2024-01-01T00:00:00Z', archived_at: T(s.title).archived_at }]
      : [],
  } satisfies AdminUserDetail]),
);

const RB = (slug: string, name: string) => ({ slug, name });
const RBrief = (handle: string, nickname: string) => ({ handle, nickname, avatar: '', avatar_small: '' });

/** 审核队列的演示数据：字段名照 review_queue.go 的 ReviewQueueItemDTO，
 *  `review_verdict` 一律当真（**不从 review_state 推** —— 交接单 C11）。 */
export const DEMO_REVIEW: ReviewQueueItem[] = [
  {
    id: 't-1', board: RB('custom-campaign', '自制战役'), author: RBrief('demo-voidray', '虚空辉光舰'),
    kind: 'resource', title: '第三章「余烬」发布：隐藏结局与平衡性改动',
    excerpt: '这一章加了七张图、一条隐藏结局线，改动说明与下载都在正文里……',
    // D25① 的就地预览读的是**全文**（不是上面那句摘要）。演示数据也要带图，
    // 因为「图片只以 Markdown 原文出现」正是审核员与模型共同看到的那一份。
    body_md: [
      '## 第三章「余烬」',
      '',
      '这一章重做了后半段的关卡节奏，加了**七张新图**与一条隐藏结局线（触发条件写在下面）。',
      '',
      '![第三章新场景](/img/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef)',
      '',
      '### 平衡性改动',
      '',
      '1. 余烬卫士的护甲从 3 降到 2；',
      '2. 火焰喷吐的冷却时间 8s → 11s；',
      '3. 隐藏结局线需要在前两章各找到一处「熄灭的火盆」。',
      '',
      '下载与完整改动清单：[外站网盘](https://example.invalid/abc) 提取码 1234。',
    ].join('\n'),
    body_truncated: false,
    review_state: 'pending', review_note: '拿不准是否有外站导流', review_source: 'ai',
    reviewer: null, reviewed_at: '2026-10-12T11:00:00Z', review_verdict: 'review',
    created_at: '2026-10-12T09:20:00Z', updated_at: '2026-10-12T10:05:00Z',
  },
  {
    id: 't-2', board: RB('tool-dev', '工具与开发'), author: RBrief('demo-marine', '陆战队员'),
    kind: 'discussion', title: '触发器里 Wait 之后变量被清空，是我写法不对吗',
    excerpt: '每次 Wait 完局部变量就没了，想确认是不是要用静态参数……',
    body_md: [
      '在触发器里这样写：',
      '',
      '```galaxy',
      'void Test () {',
      '    int x = 1;',
      '    Wait(2.0, c_timeGame);',
      '    DisplayMessage(x);   // x 到这里就没了',
      '}',
      '```',
      '',
      '想确认是不是必须把 x 提成静态变量（static parameter 那套写法）。',
    ].join('\n'),
    body_truncated: false,
    review_state: 'approved', review_note: null, review_source: 'manual',
    reviewer: RBrief('demo-admin', '示范管理员'), reviewed_at: '2026-10-12T12:10:00Z', review_verdict: 'approve',
    created_at: '2026-10-12T08:00:00Z', updated_at: '2026-10-12T12:10:00Z',
  },
  {
    id: 't-3', board: RB('announcement', '公告'), author: RBrief('demo-roach', '蟑螂'),
    kind: 'repost', title: '【转载】SC2 编辑器常见坑位整理（2024 版）',
    excerpt: '整理自社区帖，标注了原作者与出处……',
    body_md: '整理自社区帖，来源见文末。\n\n（正文较长，这里只演示被截断的那一态。）',
    // 演示「截断了必须说出来」那一态：屏幕不能把半篇当全文
    body_truncated: true,
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

/** 发信账号的演示数据：字段名照 mail/dto.go 的 AdminAccount（密钥只有「已配置 + 更新时间」）。 */
export const DEMO_MAIL: MailAccount[] = [
  {
    id: 'm-1', name: '主发信', provider: 'resend', priority: 10, daily_limit: 2000, sent_today: 143,
    reset_tz: 'Asia/Shanghai', from_address: 'noreply@sc2clud.example', from_name: 'SC2clud',
    options_json: null, enabled: true, status: 'ok', secret_configured: true,
    secret_updated_at: '2026-10-01T00:00:00Z', last_ok_at: '2026-10-12T13:00:00Z',
    last_error: '', last_error_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  },
  {
    id: 'm-2', name: '备用 SMTP', provider: 'smtp', priority: 20, daily_limit: 500, sent_today: 0,
    reset_tz: 'Asia/Shanghai', from_address: 'backup@sc2clud.example', from_name: '',
    options_json: null, enabled: false, status: 'disabled', secret_configured: false,
    secret_updated_at: null, last_ok_at: null, last_error: '连接超时', last_error_at: '2026-09-20T00:00:00Z',
    created_at: '2026-02-01T00:00:00Z', updated_at: '2026-09-20T00:00:00Z',
  },
];

/** 站点设置：`SettingItem` 自带 label / kind / options / value / hint（键值目录是后端给的）。 */
export const DEMO_SETTINGS: SettingItem[] = [
  { key: 'site.tagline', label: '副标题', group: '站点', kind: 'text', value: '星际争霸 II 战役与地图社区', hint: '首页标题下的一行', updated_at: '2026-10-01T00:00:00Z' },
  { key: 'site.footer_note', label: '页脚说明', group: '站点', kind: 'multiline', value: '本站与暴雪娱乐无关。', hint: '支持多行', updated_at: null },
  { key: 'review.auto_approve_trusted', label: 'trusted 作者免审', group: '审核', kind: 'toggle', options: ['on', 'off'], value: 'on', hint: '关掉后所有人都进人工队列', updated_at: null },
  { key: 'review.mode', label: '审核模式', group: '审核', kind: 'select', options: ['auto', 'manual', 'off'], value: 'auto', hint: 'auto = AI 判定 + 人工兜底', updated_at: null },
  { key: 'topic.min_post_level', label: '发帖最低等级', group: '审核', kind: 'text', value: '1', hint: '0 = 不限', updated_at: null },
];

export const DEMO_DOMAINS: Domain[] = [{ domain: 'sc2clud.example' }, { domain: 'www.sc2clud.example' }];

export const DEMO_ANNOUNCEMENTS: Announcement[] = [
  { id: 'a-1', title: '第三章「余烬」已上线', body_md: '## 章节更新', body_html: '<h2>章节更新</h2>', enabled: true, published_at: '2026-10-12T00:00:00Z', created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z' },
  { id: 'a-2', title: '维护通知（草稿）', body_md: '本周日凌晨维护', body_html: '<p>本周日凌晨维护</p>', enabled: false, published_at: null, created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z' },
];

export const DEMO_BANNERS: Banner[] = [
  { id: 'b-1', kind: 'info', text: '编辑器 5.0.14 兼容性说明已更新', url: '/t/t-2', starts_at: '2026-10-10T00:00:00Z', ends_at: null, enabled: true, roles: [], created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z' },
  { id: 'b-2', kind: 'warning', text: '资源区下载链接失效请点「反馈」', url: '', starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z', enabled: true, roles: ['creator'], created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
];

/** 审计日志的演示数据：**动作名照后端常量**（auth/audit.go 等），`id` 是数字、`detail` 是 jsonb、
 *  `actor` 可为 null（CLI / 系统任务）。 */
export const DEMO_AUDIT: AuditItem[] = [
  { id: 412, created_at: '2026-10-12T13:40:00Z', action: 'role.permissions.edit', target_type: 'role', target_id: 'moderator', ip: '203.0.113.24', actor: { id: 'u-1', handle: 'demo-admin', nickname: '示范管理员' }, detail: { before: { perms: ['topic.create'] }, after: { perms: ['topic.create', 'topic.lock'] } } },
  { id: 411, created_at: '2026-10-12T11:02:00Z', action: 'user.ban', target_type: 'user', target_id: 'u-9', ip: '203.0.113.24', actor: { id: 'u-1', handle: 'demo-admin', nickname: '示范管理员' }, detail: { after: { reason: '广告机器人' } } },
  { id: 410, created_at: '2026-10-12T09:00:00Z', action: 'permission.expire', target_type: 'user', target_id: 'u-6', ip: '', actor: null, detail: { before: { perm: 'post.review', expires_at: null } } },
  { id: 409, created_at: '2026-10-11T03:20:00Z', action: 'topic.review', target_type: 'topic', target_id: 't-3', ip: '203.0.113.24', actor: { id: 'u-1', handle: 'demo-admin', nickname: '示范管理员' }, detail: { action: 'reject', state: 'rejected', note: '未标注原作者与出处链接', from: 'pending' } },
  { id: 408, created_at: '2026-10-10T00:05:00Z', action: 'permission.revoke', target_type: 'user', target_id: 'u-7', ip: '127.0.0.1', actor: null, detail: { before: { perm: 'post.review' } } },
];

/** 权限点目录的演示数据：字段名照 auth/service.go 的 PermItem（key/group/name/description）。 */
export const DEMO_PERMISSIONS: Permission[] = [
  { key: 'topic.create', group: '内容', name: '发主题', description: '发主题、发回复、发 issue、发 issue 评论' },
  { key: 'topic.edit.own', group: '内容', name: '编辑自己的内容', description: '' },
  { key: 'topic.delete.any', group: '内容', name: '删任何人的内容', description: '' },
  { key: 'topic.lock', group: '内容', name: '锁定 / 解锁', description: '' },
  { key: 'topic.pin', group: '内容', name: '置顶与精华', description: '两个端点同一个点' },
  { key: 'topic.move', group: '内容', name: '移动主题', description: '' },
  { key: 'resource.publish', group: '内容', name: '发资源帖', description: 'kind=resource 时额外要它' },
  { key: 'post.review', group: '内容', name: '人工审核', description: '人工审核队列：通过 / 拒绝' },
  { key: 'user.ban', group: '用户', name: '封号', description: '封号 / 解封（users.status）' },
  { key: 'user.mute', group: '用户', name: '禁言', description: '全局 / 指定分区，带到期时间' },
  { key: 'role.edit', group: '授权', name: '改角色矩阵', description: '改角色的权限矩阵' },
  { key: 'role.assign', group: '授权', name: '分配角色', description: '给用户分配基线角色' },
  { key: 'permission.grant', group: '授权', name: '追加权限', description: '点对点追加 / 回收' },
  { key: 'title.grant', group: '授权', name: '发头衔', description: '' },
  { key: 'title.manage', group: '运营', name: '头衔目录维护', description: '归档而非删除' },
  { key: 'board.manage', group: '分区', name: '分区管理', description: '增删改、排序、封面、ACL' },
  { key: 'board.moderate', group: '分区', name: '分区内治理', description: '只在命中的分区' },
  { key: 'report.handle', group: '运营', name: '处理举报', description: '' },
  { key: 'reward.verify', group: '运营', name: '核验打赏', description: '' },
  { key: 'mail.manage', group: '系统', name: '发信账号', description: '' },
  { key: 'site.setting', group: '系统', name: '站点设置', description: '文案、公告与横幅' },
  { key: 'audit.view', group: '系统', name: '查审计', description: '' },
  { key: 'audit.export', group: '系统', name: '导出审计', description: '与 audit.view 分开' },
];

/** AI 审核配置的演示数据：字段名照 aireview/dto.go 的 ConfigView（密钥只有 has_secret）。 */
export const DEMO_AI_CONFIG: AiConfig = {
  enabled: true,
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  thinking: false,
  strict_mode: true,
  timeout_ms: 20000,
  max_output_tokens: 1024,
  temperature: 0,
  prompt: '你是社区内容审核员。判定下面这篇帖子是否合规。\n只回 JSON：{"verdict":"approve|reject|review","reason":"中文理由","categories":[]}\n拿不准就用 review（转人工），不要猜。',
  prompt_report: '你是社区举报复核员。这条帖子已被举报若干次，请判定举报是否成立。\n只回 JSON：{"verdict":"approve|reject|review","reason":"中文理由","categories":[]}',
  // 连通测试的样例：界面要能看见、能改（D33②③）。**由服务端给**（ConfigView.probe_sample），
  // 前端不写死第二份 —— 所以这份演示数据就是 D33 的默认值本身。
  probe_sample: '标题：连通性测试\n\n正文：这是一次连接测试，用来确认密钥与地址可用。',
  has_secret: true,
  secret_updated_at: '2026-10-01T03:20:00Z',
  last_ok_at: '2026-10-12T13:20:00Z',
  last_error: '超时 20000ms（POST https://api.deepseek.com/v1/chat/completions）',
  last_error_at: '2026-10-11T22:10:00Z',
};

/** 演示：连通测试样例那一路（topic_id=0，没有图）。 */
export const DEMO_AI_TEST: AiTestView = {
  verdict: 'review',
  reason: '拿不准是否有外站导流：正文提到了网盘但没给链接。',
  categories: ['spam'],
  model: 'deepseek-chat',
  latency_ms: 812,
  raw: '{"verdict":"review","reason":"拿不准是否有外站导流","categories":["spam"]}',
  topic_id: 0,
  image_count: 0,
  image_skipped: 0,
  images: [],
};
/** AI 审核屏的演示 payload（D33①）：**真站这一块来自 POST /admin/ai/payload**（服务端组装，dry-run 不外呼）；
 *  房间里没有后端，所以这里给一份「那条端点会回什么」的投影 —— 字段名逐字照 aireview/dto.go 的 PayloadView。
 *  刻意造满四档：两张发出去、一张超字节没发（note 说清为什么）、正文里还有一句图片 Markdown 字面量。 */
export const DEMO_AI_PAYLOAD: AiPayloadView = {
  source: 'topic',
  topic_id: 3,
  title: '第三章「余烬」发布：隐藏结局与平衡性改动（附七张实机截图）',
  trigger: 'create',
  open_reports: 0,
  system: DEMO_AI_CONFIG.prompt,
  user_prefix: '',
  user_title: '标题：第三章「余烬」发布：隐藏结局与平衡性改动（附七张实机截图）',
  user_body: '正文：\n这一章加了七张图、一条隐藏结局线。\n\n![余烬 1](/img/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef)\n\n改动说明与下载都在下面。',
  user_text: '',
  has_image_markdown: true,
  image_attachment_count: 3,
  images: [
    { position: 0, floor: 1, hash: '1111111111111111111111111111111111111111111111111111111111111111', mime: 'image/webp', bytes: 184320, sent: true, note: '' },
    { position: 1, floor: 1, hash: '2222222222222222222222222222222222222222222222222222222222222222', mime: 'image/webp', bytes: 262144, sent: true, note: '' },
    { position: 2, floor: 1, hash: '3333333333333333333333333333333333333333333333333333333333333333', mime: 'image/png', bytes: 3407872, sent: false, note: '单张 3.3 MB 超过上限 2.0 MB，没发给模型（截图请压缩后再传）' },
  ],
  image_count: 2,
  image_skipped: 1,
  image_bytes: 446464,
  image_limit: 4,
  image_max_bytes: 2097152,
  image_read_failed: false,
  model: DEMO_AI_CONFIG.model,
  max_output_tokens: DEMO_AI_CONFIG.max_output_tokens,
  strict_mode: DEMO_AI_CONFIG.strict_mode,
  tool_name: 'submit_review',
  categories: ['spam', 'ad', 'abuse', 'off_topic', 'illegal', 'other'],
};


/** 邮件模板的演示数据（D37）：字段名照 mail/templates.go 的 TemplateView —— custom=false 的三段源就是内置的。 */
export const DEMO_MAIL_TPL: MailTemplate[] = [
  {
    kind: 'verify_email', custom: false, subject: '邮箱验证码',
    html_body: '<p>{{if .Nickname}}{{.Nickname}}，你好：{{else}}你好：{{end}}</p>\n<p>你的邮箱验证码是：</p>\n<p style="font-size:28px;font-weight:700;letter-spacing:6px">{{.Code}}</p>\n<p>验证码 {{.ExpiresIn}} 内有效，只能使用一次。不是你本人操作就忽略这封邮件。</p>',
    text_body: '{{if .Nickname}}{{.Nickname}}，你好：{{else}}你好：{{end}}\n\n你的邮箱验证码是：{{.Code}}\n\n验证码 {{.ExpiresIn}} 内有效，只能使用一次。不是你本人操作就忽略这封邮件。\n\n-- {{.SiteName}}',
    updated_at: null, updated_by: null,
  },
  {
    kind: 'reset_password', custom: true, subject: '重置你的密码 {{.Code}}',
    html_body: '<p>你正在重置密码，验证码是：</p>\n<p style="font-size:28px;font-weight:700">{{.Code}}</p>',
    text_body: '自定义重置 {{.Code}}',
    updated_at: '2026-10-15T12:00:00Z', updated_by: 4,
  },
  {
    kind: 'test', custom: false, subject: '发信测试',
    html_body: '<p>这是一封测试邮件，用来验证这个发信账号配置正确。</p>\n<p>发件人：{{.From}}<br>时间：{{.Now}}</p>',
    text_body: '这是一封测试邮件，用来验证这个发信账号配置正确。\n\n发件人：{{.From}}\n时间：{{.Now}}\n\n-- {{.SiteName}}',
    updated_at: null, updated_by: null,
  },
  {
    kind: 'notice', custom: true, subject: '《SC2CLUD》{{.Title}}',
    html_body: '<p>{{if .Nickname}}{{.Nickname}}，你好：{{else}}你好：{{end}}</p>\n<p>{{.Body}}</p>{{if .Link}}<p><a href="{{.Link}}">查看详情</a></p>{{end}}',
    text_body: '{{if .Nickname}}{{.Nickname}}，你好：{{else}}你好：{{end}}\n\n{{.Body}}\n{{if .Link}}\n查看详情：{{.Link}}\n{{end}}\n\n-- {{.SiteName}}',
    updated_at: '2026-10-14T09:00:00Z', updated_by: 4,
  },
];

/** 房间预览是「这条端点会回什么」的投影（与 AiPayloadView 同一策略）：样本昵称带 <script>，HTML 里是转义后的字面量。 */
export const DEMO_MAILTPL_PREVIEW: MailTemplatePreview = {
  subject: '重置你的密码 123456',
  text: '自定义重置 123456\n\n爱<>(如:<script>alert(1)</script>',
  html: '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>重置你的密码 123456</title></head>'
    + '<body style="margin:0;background:#f5f5f5"><div style="max-width:560px;margin:0 auto;padding:32px 16px">'
    + '<div style="font-size:16px;font-weight:600">测试站</div>'
    + '<div style="background:#fff;border:1px solid #e5e5e5;border-radius:8px;padding:24px;font-size:14px">'
    + '<p>你正在重置密码，验证码是：</p><p style="font-size:28px;font-weight:700">123456</p>'
    + '<p>收件人：爱&lt;&gt;(如:&lt;script&gt;alert(1)&lt;/script&gt;</p></div>'
    + '<p style="font-size:12px;color:#888">这封邮件由 测试站 系统自动发出，请勿直接回复。</p>'
    + '</div></body></html>',
};


/** 内置模板的三段源（真站由 GET /admin/mail-templates 对缺行返回；房间用它展示「恢复内置后的回显」）。 */
export const DEMO_MAILTPL_BUILTIN: Record<string, { subject: string; html_body: string; text_body: string }> = {
  reset_password: {
    subject: '重置密码验证码',
    html_body: '<p>{{if .Nickname}}{{.Nickname}}，你好：{{else}}你好：{{end}}</p>\n<p>你正在重置密码，验证码是：</p>\n<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">{{.Code}}</p>\n<p>验证码 {{.ExpiresIn}} 内有效，只能使用一次。不是你本人操作就忽略这封邮件，你的密码没有被改动。</p>',
    text_body: '{{if .Nickname}}{{.Nickname}}，你好：{{else}}你好：{{end}}\n\n你正在重置密码，验证码是：{{.Code}}\n\n验证码 {{.ExpiresIn}} 内有效，只能使用一次。不是你本人操作就忽略这封邮件，你的密码没有被改动。\n\n-- {{.SiteName}}',
  },
  notice: {
    subject: '站内通知',
    html_body: '<p>{{if .Nickname}}{{.Nickname}}，你好：{{else}}你好：{{end}}</p>\n<p>{{.Body}}</p>\n{{if .Link}}<p><a href="{{.Link}}">查看详情</a></p>{{end}}',
    text_body: '{{if .Nickname}}{{.Nickname}}，你好：{{else}}你好：{{end}}\n\n{{.Body}}\n{{if .Link}}\n查看详情：{{.Link}}\n{{end}}\n\n-- {{.SiteName}}',
  },
  verify_email: {
    subject: '邮箱验证码',
    html_body: '<p>{{if .Nickname}}{{.Nickname}}，你好：{{else}}你好：{{end}}</p>\n<p>你的邮箱验证码是：</p>\n<p style="font-size:28px;font-weight:700;letter-spacing:6px;margin:16px 0">{{.Code}}</p>\n<p>验证码 {{.ExpiresIn}} 内有效，只能使用一次。不是你本人操作就忽略这封邮件。</p>',
    text_body: '{{if .Nickname}}{{.Nickname}}，你好：{{else}}你好：{{end}}\n\n你的邮箱验证码是：{{.Code}}\n\n验证码 {{.ExpiresIn}} 内有效，只能使用一次。不是你本人操作就忽略这封邮件。\n\n-- {{.SiteName}}',
  },
  test: {
    subject: '发信测试',
    html_body: '<p>这是一封测试邮件，用来验证这个发信账号配置正确。</p>\n<p>发件人：{{.From}}<br>时间：{{.Now}}</p>',
    text_body: '这是一封测试邮件，用来验证这个发信账号配置正确。\n\n发件人：{{.From}}\n时间：{{.Now}}\n\n-- {{.SiteName}}',
  },
};
