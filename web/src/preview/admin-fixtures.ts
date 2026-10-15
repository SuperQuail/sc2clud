// 管理后台的出图桩（`web/product.html?stub=1&route=/admin/<屏>`）。
//
// 单独一个文件而不是塞进 product-fixture.ts：那一份已经被「信息中心 / 问题反馈」的桩占满了
//（交接单 §2 规则 6：单文件 ≤ 500 行），而管理后台的 12 屏各有一组数据。
//
// **字段名照 @/lib/api/admin 的类型抄**（那些类型照 forum/internal/** 的 DTO）——
// 桩的字段名一旦与真接口不一致，出出来的图就是一张假图（交接单 §5.1）。
// 这里**故意不给 `GET /admin/users`**：那条路由后端还不存在（C1，W-D1 在补），
// 出图时要能看见「用户列表没能加载（HTTP 404）」这个真实状态，而不是一张示例表。
type Reply = { status?: number; body?: unknown };

const RB = (slug: string, name: string) => ({ slug, name });
const BRIEF = (handle: string, nickname: string) => ({ handle, nickname, avatar: '', avatar_small: '' });

const ROLE = (id: number, key: string, name: string, color: string, isSuper = false) => ({
  id, key, name, description: key, depth: 0, badge_color: color, is_system: true,
  is_super: isSuper, priority: id * 10, perm_keys: ROLE_PERMS[key] ?? [], user_count: 3,
});

export const ME_ADMIN = {
  id: 'u-1', handle: 'demo-admin', nickname: '示范管理员', avatar: null,
  email_verified: true, activated: true, is_super: false,
  perms: ['post.review', 'report.handle', 'reward.verify', 'role.edit', 'role.assign', 'title.grant', 'title.manage', 'board.manage', 'mail.manage', 'site.setting', 'audit.view', 'audit.export', 'user.ban', 'permission.grant', 'topic.create'],
  role: { key: 'admin', name: '管理员' },
  extra: [{ key: 'audit.view', expires_at: '2026-12-31T15:59:59Z' }],
  board_ids: [1],
};

const REVIEW = [
  {
    id: 't-1', board: RB('custom-campaign', '自制战役'), author: BRIEF('demo-voidray', '虚空辉光舰'),
    kind: 'resource', title: '第三章「余烬」发布：隐藏结局与平衡性改动',
    excerpt: '这一章加了七张图、一条隐藏结局线，改动说明与下载都在正文里。',
    review_state: 'pending', review_note: '拿不准是否有外站导流', review_source: 'ai',
    reviewer: null, reviewed_at: '2026-10-12T11:00:00Z', review_verdict: 'review',
    created_at: '2026-10-12T09:20:00Z', updated_at: '2026-10-12T10:05:00Z',
  },
  {
    id: 't-2', board: RB('tool-dev', '工具与开发'), author: BRIEF('demo-marine', '陆战队员'),
    kind: 'discussion', title: '触发器里 Wait 之后变量被清空，是我写法不对吗',
    excerpt: '每次 Wait 完局部变量就没了，想确认是不是要用静态参数。',
    review_state: 'pending', review_note: null, review_source: null,
    reviewer: null, reviewed_at: null, review_verdict: null,
    created_at: '2026-10-12T08:00:00Z', updated_at: '2026-10-12T08:00:00Z',
  },
  {
    id: 't-3', board: RB('announcement', '公告'), author: BRIEF('demo-roach', '蟑螂'),
    kind: 'repost', title: '【转载】SC2 编辑器常见坑位整理（2024 版）',
    excerpt: '整理自社区帖，标注了原作者与出处。',
    review_state: 'rejected', review_note: '未标注原作者与出处链接，补齐后可重新提交', review_source: 'manual',
    reviewer: BRIEF('demo-admin', '示范管理员'), reviewed_at: '2026-10-11T03:00:00Z', review_verdict: 'reject',
    created_at: '2026-10-10T21:00:00Z', updated_at: '2026-10-11T03:00:00Z',
  },
  // 06.2 的两档（K2-C 出图用）：打回修改（第四态）与「已发布 + 有改动等着替换上线」。
  // 后者的 review_state 就是 approved —— 线上还挂着旧版，改动在待审槽里（topic_revisions.pending_md），
  // 所以这一档**不能**按状态名去查（队列 SQL 的 state=draft）。
  {
    id: 't-4', board: RB('tool-dev', '工具与开发'), author: BRIEF('demo-voidray', '虚空辉光舰'),
    kind: 'discussion', title: '触发器里 Wait 之后变量被清空（已按意见补了完整的复现步骤）',
    excerpt: '补了最小复现工程与两张截图，第三节按审核意见重写了。',
    review_state: 'revision_requested', review_note: '第三节请补一个最小复现工程，现在看不出是引擎行为还是写法问题',
    review_source: 'manual', reviewer: BRIEF('demo-admin', '示范管理员'),
    reviewed_at: '2026-10-12T12:00:00Z', review_verdict: 'revision_requested',
    created_at: '2026-10-12T07:30:00Z', updated_at: '2026-10-12T13:10:00Z',
  },
  {
    id: 't-5', board: RB('custom-campaign', '自制战役'), author: BRIEF('demo-marine', '陆战队员'),
    kind: 'resource', title: '第三章「余烬」下载与改动说明（改了一版：修好第二章的存档继承）',
    excerpt: '已发布的那一版还在线上；这一版修了存档继承，等替换上线。',
    review_state: 'approved', review_note: null, review_source: 'manual',
    reviewer: BRIEF('demo-admin', '示范管理员'), reviewed_at: '2026-10-12T06:00:00Z', review_verdict: 'approve',
    created_at: '2026-10-10T09:00:00Z', updated_at: '2026-10-12T14:20:00Z',
  },
];

const AUDIT = [
  { id: 412, created_at: '2026-10-12T13:40:00Z', action: 'role.permissions.edit', target_type: 'role', target_id: 'admin', ip: '10.0.0.4', actor: { id: 'u-1', handle: 'demo-admin', nickname: '示范管理员' }, detail: { before: { perms: ['post.review'] }, after: { perms: ['post.review', 'user.ban'] } } },
  { id: 411, created_at: '2026-10-12T11:02:00Z', action: 'user.ban', target_type: 'user', target_id: 'u-9', ip: '10.0.0.4', actor: { id: 'u-1', handle: 'demo-admin', nickname: '示范管理员' }, detail: { after: { reason: '广告机器人' } } },
  { id: 410, created_at: '2026-10-12T09:00:00Z', action: 'permission.expire', target_type: 'user', target_id: 'u-6', ip: '', actor: null, detail: { before: { perm: 'post.review', expires_at: null } } },
];

const REPORTS = [
  { id: 'r-1', target_type: 'topic', target_id: 't-1', target_label: '第三章「余烬」发布：隐藏结局与平衡性改动', board: RB('custom-campaign', '自制战役'), reason: 'spam', detail: '正文里有外站下载链接', reporter: BRIEF('demo-marine', '陆战队员'), state: 'open', handler: null, handled_at: null, handle_note: '', created_at: '2026-10-12T07:00:00Z', open_reports: 2, created: true },
  { id: 'r-2', target_type: 'post', target_id: 'p-9', target_label: '回复 #12（在「触发器里 Wait…」下）', board: RB('tool-dev', '工具与开发'), reason: 'abuse', detail: '人身攻击', reporter: BRIEF('demo-voidray', '虚空辉光舰'), state: 'open', handler: null, handled_at: null, handle_note: '', created_at: '2026-10-11T18:00:00Z', open_reports: 1, created: true },
  { id: 'r-3', target_type: 'user', target_id: 'u-9', target_label: '@demo-roach（蟑螂）', board: null, reason: 'illegal', detail: '发布违规内容', reporter: BRIEF('demo-admin', '示范管理员'), state: 'handled', handler: BRIEF('demo-admin', '示范管理员'), handled_at: '2026-10-11T02:00:00Z', handle_note: '已封号', created_at: '2026-10-10T20:00:00Z', open_reports: 0, created: true },
];

const DONATIONS = [
  { id: 'd-1', amount_cents: 5000, txn_id: '2026101200001', state: 'pending', note: '第三章加油', post_id: 't-1', channel_id: 'c-1', donor: BRIEF('demo-marine', '陆战队员'), recipient: BRIEF('demo-voidray', '虚空辉光舰'), created_at: '2026-10-12T06:00:00Z' },
  { id: 'd-2', amount_cents: 2000, txn_id: '2026101100007', state: 'pending', note: '', post_id: 't-1', channel_id: 'c-2', donor: BRIEF('demo-thor', '雷神'), recipient: BRIEF('demo-voidray', '虚空辉光舰'), created_at: '2026-10-11T05:00:00Z' },
  { id: 'd-3', amount_cents: 10000, txn_id: '2026100900003', state: 'approved', note: '地图包月支持', post_id: '', channel_id: 'c-1', donor: BRIEF('demo-admin', '示范管理员'), recipient: BRIEF('demo-thor', '雷神'), verifier: BRIEF('demo-admin', '示范管理员'), verified_at: '2026-10-09T08:00:00Z', created_at: '2026-10-09T03:00:00Z' },
];

const STATS = {
  public_total_cents: 150000, all_total_cents: 320000, public_count: 12, all_count: 26,
  leaderboard: [
    { user: BRIEF('demo-voidray', '虚空辉光舰'), total_cents: 210000, count: 14 },
    { user: BRIEF('demo-thor', '雷神'), total_cents: 110000, count: 12 },
  ],
};

/** role_permissions 是**已展开的并集**（§9.8），所以这里每个角色给的是它的全量。 */
const ROLE_PERMS: Record<string, string[]> = {
  user: ["topic.create","topic.edit.own"],
  creator: ["topic.create","topic.edit.own","resource.publish","topic.pin"],
  admin: ["topic.create","topic.edit.own","topic.delete.any","topic.lock","topic.pin","topic.move","resource.publish","post.review","user.ban","user.mute","report.handle","reward.verify"],
  superadmin: [],
};

const ROLES = [ROLE(1, 'user', '普通用户', ''), ROLE(2, 'creator', '认证创作者', '#2563eb'), ROLE(3, 'admin', '管理员', '#7c3aed'), ROLE(4, 'superadmin', '超级管理员', '#f97316', true)];
const PERMISSIONS = [
  { key: 'topic.create', group: '内容', name: '发主题', description: '发主题、发回复、发 issue' },
  { key: 'post.review', group: '内容', name: '人工审核', description: '人工审核队列：通过 / 拒绝' },
  { key: 'user.ban', group: '用户', name: '封号', description: '封号 / 解封（users.status）' },
  { key: 'role.assign', group: '授权', name: '分配角色', description: '给用户分配基线角色' },
  { key: 'site.setting', group: '系统', name: '站点设置', description: '站点设置、文案、公告与横幅' },
];

const TITLES = [
  { id: 't-1', key: 'campaign_author', name: '战役作者', color: '#2563eb', description: '发布过完整战役的认证作者', archived_at: null },
  { id: 't-2', key: 'veteran', name: '元老', color: '#f97316', description: '旧站迁移过来的创始成员', archived_at: null },
  { id: 't-3', key: 'essence_star', name: '精华贡献者', color: '#16a34a', description: '已并入「战役作者」', archived_at: '2026-08-01T00:00:00Z' },
];

const MAIL = [
  { id: 'm-1', name: '主发信', provider: 'resend', priority: 10, daily_limit: 2000, sent_today: 143, reset_tz: 'Asia/Shanghai', from_address: 'noreply@sc2clud.example', from_name: 'SC2clud', options_json: null, enabled: true, status: 'ok', secret_configured: true, secret_updated_at: '2026-10-01T00:00:00Z', last_ok_at: '2026-10-12T13:00:00Z', last_error: '', last_error_at: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
  { id: 'm-2', name: '备用 SMTP', provider: 'smtp', priority: 20, daily_limit: 500, sent_today: 0, reset_tz: 'Asia/Shanghai', from_address: 'backup@sc2clud.example', from_name: '', options_json: null, enabled: false, status: 'disabled', secret_configured: false, secret_updated_at: null, last_ok_at: null, last_error: '连接超时', last_error_at: '2026-09-20T00:00:00Z', created_at: '2026-02-01T00:00:00Z', updated_at: '2026-09-20T00:00:00Z' },
];

const SETTINGS = {
  items: [
    { key: 'site.tagline', label: '副标题', group: '站点', kind: 'text', value: '星际争霸 II 战役与地图社区', hint: '首页标题下的一行', updated_at: '2026-10-01T00:00:00Z' },
    { key: 'review.auto_approve_trusted', label: 'trusted 作者免审', group: '审核', kind: 'toggle', options: ['on', 'off'], value: 'on', hint: '关掉后所有人都进人工队列', updated_at: null },
    { key: 'review.mode', label: '审核模式', group: '审核', kind: 'select', options: ['auto', 'manual', 'off'], value: 'auto', hint: 'auto = AI 判定 + 人工兜底', updated_at: null },
    { key: 'topic.min_post_level', label: '发帖最低等级', group: '审核', kind: 'int', value: '1', hint: '0 = 不限', updated_at: null },
  ],
};

const ANNOUNCEMENTS = [
  { id: 'a-1', title: '第三章「余烬」已上线', body_md: '## 章节更新', body_html: '<h2>章节更新</h2>', enabled: true, published_at: '2026-10-12T00:00:00Z', created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z' },
  { id: 'a-2', title: '维护通知（草稿）', body_md: '本周日凌晨维护', body_html: '<p>本周日凌晨维护</p>', enabled: false, published_at: null, created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z' },
];

const BANNERS = [
  { id: 'b-1', kind: 'info', text: '编辑器 5.0.14 兼容性说明已更新', url: '/t/t-2', starts_at: '2026-10-10T00:00:00Z', ends_at: null, enabled: true, roles: [], created_at: '2026-10-10T00:00:00Z', updated_at: '2026-10-10T00:00:00Z' },
  { id: 'b-2', kind: 'warning', text: '资源区下载链接失效请点「反馈」', url: '', starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z', enabled: true, roles: ['creator'], created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' },
];

const AI_CONFIG = {
  enabled: true, provider: 'deepseek', base_url: 'https://api.deepseek.com', model: 'deepseek-chat',
  thinking: false, strict_mode: true, timeout_ms: 20000, max_output_tokens: 1024, temperature: 0,
  prompt: '你是社区内容审核员。判定下面这篇帖子是否合规，只回 JSON：{"verdict":"approve|reject|review","reason":"中文理由","categories":[]}',
  prompt_report: '你是社区举报复核员。判定这条举报是否成立，只回 JSON：{"verdict":"approve|reject|review","reason":"中文理由"}',
  has_secret: true, secret_updated_at: '2026-10-01T00:00:00Z', last_ok_at: '2026-10-12T13:00:00Z',
  last_error: '', last_error_at: null,
};

// ── C1/C2/C3 三组的桩数据（字段名逐个照 forum/internal/** 的 DTO）──────────
// users 是**列表项**那一份（role 只有三列、没有 avatar/extra_permissions/title/sanctions）；
// 那三张表在 USER_DETAIL 里，对应 GET /admin/users/{id}。

const U_ROLE = (key: string) => {
  const r = ROLES.find((x) => x.key === key)!;
  return { key: r.key, name: r.name, badge_color: r.badge_color };
};

const USERS = [
  { id: '11111111-1111-4111-8111-111111111111', username: 'demo-admin', nickname: '示范管理员', email: 'demo-admin@example.com', role: U_ROLE('admin'), status: 'active', email_verified_at: '2024-03-02T02:10:00Z', activated_at: '2024-03-02T02:12:00Z', trusted: true, level: 5, created_at: '2024-03-02T02:05:00Z', last_login_at: '2026-10-12T09:20:00Z', topic_count: 31, reply_count: 402 },
  { id: '22222222-2222-4222-8222-222222222222', username: 'demo-overseer', nickname: '督察官', email: 'demo-overseer@example.com', role: U_ROLE('superadmin'), status: 'active', email_verified_at: '2023-11-11T01:00:00Z', activated_at: '2023-11-11T01:00:00Z', trusted: true, level: 9, created_at: '2023-11-11T00:50:00Z', last_login_at: '2026-10-11T16:02:00Z', topic_count: 8, reply_count: 77 },
  { id: '33333333-3333-4333-8333-333333333333', username: 'demo-infestor', nickname: '感染虫', email: 'demo-infestor@example.com', role: U_ROLE('user'), status: 'banned', email_verified_at: '2025-01-20T05:00:00Z', activated_at: '2025-01-20T05:00:00Z', trusted: false, level: 1, created_at: '2025-01-20T04:58:00Z', last_login_at: '2026-09-30T11:40:00Z', topic_count: 3, reply_count: 51 },
  { id: '44444444-4444-4444-8444-444444444444', username: 'demo-drone', nickname: '工蜂', email: 'demo-drone@example.com', role: U_ROLE('user'), status: 'active', email_verified_at: '2026-10-08T03:00:00Z', activated_at: null, trusted: false, level: 1, created_at: '2026-10-08T02:58:00Z', last_login_at: '2026-10-12T12:30:00Z', topic_count: 0, reply_count: 0 },
  { id: '55555555-5555-4555-8555-555555555555', username: 'demo-ghost', nickname: '幽灵特工', email: 'demo-ghost@example.com', role: U_ROLE('creator'), status: 'active', email_verified_at: null, activated_at: null, trusted: false, level: 1, created_at: '2026-10-11T22:10:00Z', last_login_at: null, topic_count: 0, reply_count: 0 },
];

const USER_DETAIL: Record<string, unknown> = {
  '11111111-1111-4111-8111-111111111111': {
    user_permissions: [{ key: 'audit.view', name: '查看审计日志', reason: '季度审计', expires_at: '2026-12-31T15:59:59Z', granted_at: '2026-10-01T00:00:00Z' }],
    user_titles: [],
    sanctions: [],
  },
  '33333333-3333-4333-8333-333333333333': {
    user_permissions: [],
    user_titles: [],
    sanctions: [
      { id: 9001, action: 'post', board: null, reason: '刷屏推广外站', until: '2026-11-30T15:59:59Z', created_at: '2026-10-30T15:59:59Z' },
      { id: 9002, action: 'reply', board: { slug: 'custom-campaign', name: '自制战役' }, reason: '在分区里引战', until: null, created_at: '2026-09-01T00:00:00Z' },
    ],
  },
  '22222222-2222-4222-8222-222222222222': {
    user_permissions: [],
    user_titles: [{ id: 't-2', key: 'veteran', name: '元老', color: '#f97316', description: '旧站迁移过来的创始成员', granted_at: '2024-01-01T00:00:00Z', archived_at: null }],
    sanctions: [],
  },
};

// 后台分区列表里「已经有封面」的那一行用它 —— 出图要看得见**换与清两颗按钮都在**，
// 而 cover_hash 为空时按设计不画「清空封面」（没有可清的）。
// 这个 hash 对应 public/img/<hash>（1x1 占位图，只为让 <img> 不裂）。
export const COVER_HASH = 'c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0';

/** 后台分区列表：**含归档**，position 是行号（1 起），moderators 只有在任的。 */
const BOARDS2 = [
  { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', slug: 'custom-campaign', name: '自制战役', description: '战役作者发布与讨论', cover_hash: COVER_HASH, status: 'active', acl_enabled: true, min_post_level: 0, position: 1, topic_count: 812, post_count: 9421, today_count: 17, moderators: [] },
  { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', slug: 'tool-dev', name: '工具与开发', description: '模型、纹理、音效与工具链', cover_hash: '', status: 'active', acl_enabled: false, min_post_level: 0, position: 2, topic_count: 431, post_count: 3802, today_count: 9, moderators: [] },
  { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', slug: 'announcement', name: '公告与活动', description: '站点公告、赛事与活动', cover_hash: '', status: 'active', acl_enabled: true, min_post_level: 3, position: 3, topic_count: 24, post_count: 308, today_count: 2, moderators: [] },
  { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', slug: 'archive', name: '旧版存档', description: '旧站迁移时的历史分区，只读', cover_hash: '', status: 'archived', acl_enabled: false, min_post_level: 0, position: 4, topic_count: 1204, post_count: 8890, today_count: 0, moderators: [] },
];

/** 自检（C3）：三态 ok / fail / skipped，debug 打开。 */
const DIAG = {
  debug_enabled: true, version: 'dev-1c4a9f2', started_at: '2026-10-12T02:00:00Z', readonly: true, total: 4, failed: 1,
  checks: [
    { name: '权限点集合一致性', status: 'ok', ok: true, detail: '代码常量 24 个 == permissions 表 24 行', ms: 12 },
    { name: '枚举值域与代码常量', status: 'ok', ok: true, detail: '全部枚举与 DDL 的 CHECK 一致', ms: 9 },
    { name: '数据库迁移版本', status: 'fail', ok: false, detail: '迁移处于 dirty 状态：修好 SQL 后先 forum migrate force 再重跑', ms: 3 },
    { name: '外键索引完备', status: 'skipped', ok: false, detail: '', ms: 0 },
  ],
};

/** 管理后台的桩。返回 undefined = 不拦（交回真实 fetch）——例如 `GET /admin/users`。 */
export function adminFixtureFor(u: string): Reply | undefined {
  const url = new URL(u, 'http://stub');
  const p = url.pathname;
  // 两个只给出图用的开关（非默认态要看得见）：
  //  · ?empty=1 —— 三组新端点的 data 一律给空数组（空态：空表 + 「还没有分区」这类文案）
  //  · ?fail=1  —— 三组新端点一律 500（错误态：界面要把「哪一步没加载 + 状态码」说出来，不是一张空表）
  // 开关读**页面**的查询串（location.search），不读这一条请求的 URL：它们是「这一次出图」的属性，
  // 不是端点的属性。早先写成从 u 里读，结果是每次请求都拿到空查询串，开关永远不生效。
  const page = new URLSearchParams(typeof location === 'undefined' ? '' : location.search);
  const empty = page.get('empty') === '1';
  const fail = page.get('fail') === '1';
  const newGroup = p.endsWith('/api/v1/admin/users') || p.includes('/api/v1/admin/boards') || p.endsWith('/api/v1/admin/diagnostics');
  if (fail && newGroup) {
    return { status: 500, body: { error: { code: 'common.internal', message: '服务端内部错误（出图桩：?fail=1）', request_id: 'req-shot' } } };
  }
  if (p.endsWith('/api/v1/admin/topics')) {
    const state = url.searchParams.get('state') ?? 'pending';
    // 'draft' 是**服务端的作用域名**，不是 review_state 的值（拍板 08 第二轮 · 6.2）：
    // 它筛的是「已发布 + 有未过审改动」。桩照着做，否则再点一次这一档又会是空的。
    const rows = state === 'all' ? REVIEW.filter((r) => r.review_state !== 'approved')
      : state === 'draft' ? REVIEW.filter((r) => r.review_state === 'approved')
        : REVIEW.filter((r) => r.review_state === state);
    return { body: { data: rows, next_cursor: null } };
  }
  if (p.includes('/api/v1/admin/topics/') && p.endsWith('/review')) {
    const id = p.split('/api/v1/admin/topics/')[1]!.replace('/review', '');
    const row = REVIEW.find((r) => r.id === id);
    return { body: { data: row ? { ...row, review_state: 'approved', review_note: null, review_source: 'manual' } : null } };
  }
  if (p.endsWith('/api/v1/admin/reports')) {
    const state = url.searchParams.get('state') ?? 'open';
    return { body: { data: REPORTS.filter((r) => r.state === state), next_cursor: null } };
  }
  if (p.endsWith('/api/v1/admin/reports/batch')) return { body: { data: { results: [] } } };
  if (p.includes('/api/v1/admin/reports/')) return { body: { data: { ...REPORTS[0], state: 'handled' } } };
  if (p.endsWith('/api/v1/admin/rewards/stats')) return { body: { data: STATS } };
  if (p.endsWith('/api/v1/admin/rewards')) {
    const state = url.searchParams.get('state') ?? 'pending';
    return { body: { data: DONATIONS.filter((r) => r.state === state), next_cursor: null } };
  }
  if (p.endsWith('/api/v1/admin/rewards/batch')) return { body: { data: { results: [] } } };
  if (p.includes('/api/v1/admin/rewards/') && p.endsWith('/verify')) return { body: { data: { ...DONATIONS[0], state: 'approved' } } };
  if (p.endsWith('/api/v1/admin/donation-notice-defaults')) return { body: { data: [{ channel: 'default', text: '感谢支持，我会继续更新。' }] } };
  if (p.endsWith('/api/v1/admin/roles')) return { body: { data: ROLES } };
  if (p.endsWith('/api/v1/admin/permissions')) return { body: { data: PERMISSIONS } };
  if (p.endsWith('/api/v1/admin/titles')) return { body: { data: TITLES } };
  if (p.endsWith('/api/v1/admin/mail/accounts')) {
    // ?mailNoSecret=1 演「迁移过来的账号」（密文被置 NULL → 一封都发不出去）那一态，见 mail.tsx 的 mail-no-usable
    const rows = page.get('mailNoSecret') === '1'
      ? MAIL.map((a) => ({ ...a, secret_configured: false, secret_updated_at: null }))
      : MAIL;
    return { body: { data: rows } };
  }
  if (p.endsWith('/api/v1/admin/site-settings')) return { body: { data: SETTINGS } };
  if (p.endsWith('/api/v1/admin/site-domains')) return { body: { data: [{ domain: 'sc2clud.example' }] } };
  if (p.endsWith('/api/v1/admin/announcements')) return { body: { data: ANNOUNCEMENTS } };
  if (p.endsWith('/api/v1/admin/banners')) return { body: { data: BANNERS } };
  // ── C1 / C2 / C3 落地的三组（W-D1）────────────────────────────────────
  // 字段名逐个照 auth/admin_users.go、forum/admin_boards.go、auth/admin_diagnostics.go 的 DTO 抄。
  if (p.endsWith('/api/v1/admin/users')) {
    const role = url.searchParams.get('role');
    const status = url.searchParams.get('status');
    let rows = USERS;
    if (role) rows = rows.filter((u) => u.role.key === role);
    if (status) rows = rows.filter((u) => u.status === status);
    return { body: { data: empty ? [] : rows, next_cursor: null } };
  }
  if (/\/api\/v1\/admin\/users\/[0-9a-f-]+$/.test(p)) {
    const id = p.split('/api/v1/admin/users/')[1]!;
    const row = USERS.find((u) => u.id === id);
    // 详情 = 列表项 + 三张关联表（sanctions / user_permissions / user_titles）
    return { body: { data: row ? { ...row, ...(USER_DETAIL[id] ?? { sanctions: [], user_permissions: [], user_titles: [] }) } : null } };
  }
  // 顺序敏感：/boards/reorder 与 /boards/{id}/... 都要写在 /boards 那条**前面**
  if (p.endsWith('/api/v1/admin/boards/reorder')) return { body: { data: { ok: true } } };
  if (p.endsWith('/acl')) {
    // 选中哪个分区就回哪个分区的矩阵：给 4 个角色各一行，user 那一行按 acl_enabled 决定 deny
    const b = BOARDS2.find((x) => p.includes(x.id)) ?? BOARDS2[0]!;
    return {
      body: {
        data: ROLES.map((r) => ({
          role_id: r.id, role_key: r.key,
          can_post: r.key !== 'user' || !b.acl_enabled,
          can_reply: true,
          deny_post: r.key === 'user' && b.acl_enabled,
          deny_reply: false,
        })),
      },
    };
  }
  if (p.endsWith('/moderators')) {
    // 版主读口**含已卸任的历史行**（grown_at 非空）—— 这一行是刻意造的，屏上要看得见「已卸任」那一档
    return { body: { data: [
      { user_id: USERS[0]!.id, handle: USERS[0]!.username, nickname: USERS[0]!.nickname, granted_at: '2026-04-01T00:00:00Z', expires_at: null, grown_at: null },
      { user_id: USERS[1]!.id, handle: USERS[1]!.username, nickname: USERS[1]!.nickname, granted_at: '2026-01-01T00:00:00Z', expires_at: '2026-12-01T15:59:59Z', grown_at: null },
      { user_id: USERS[4]!.id, handle: USERS[4]!.username, nickname: USERS[4]!.nickname, granted_at: '2026-01-01T00:00:00Z', expires_at: null, grown_at: '2026-08-01T00:00:00Z' },
    ] } };
  }
  if (p.endsWith('/api/v1/admin/boards')) return { body: { data: empty ? [] : BOARDS2 } };
  if (/\/api\/v1\/admin\/boards\/[0-9a-f-]+$/.test(p)) return { body: { data: BOARDS2.find((x) => p.endsWith(x.id)) ?? BOARDS2[0] } };
  // ?debug=0 —— debug 关闭那一档（D13）：后端回 404 common.not_found，**不是空 200**。
  // 桩必须照这个形状给，否则出图看到的是「有数据的自检面板」，验不到「只留一句说明」。
  if (p.endsWith('/api/v1/admin/diagnostics')) {
    if (page.get('debug') === '0') {
      return { status: 404, body: { error: { code: 'common.not_found', message: '内容不存在', request_id: 'req-shot' } } };
    }
    return { body: { data: DIAG } };
  }
  if (p.endsWith('/api/v1/admin/audit-logs')) return { body: { data: AUDIT, next_cursor: null } };
  if (p.endsWith('/api/v1/admin/ai/config')) {
    // ?aitest=nokey 换一份**没配密钥**的配置：那一档必须不点外呼、就地说明（D12）
    if (page.get('aitest') === 'nokey') {
      return { body: { data: { ...AI_CONFIG, has_secret: false, secret_updated_at: null, last_ok_at: null } } };
    }
    return { body: { data: AI_CONFIG } };
  }
  // 连通测试（D12）：默认成功；?aitest=nokey|401|timeout|500 出四档失败态（每一种都要出一张图）。
  // 桩要照后端**真实的**形状给：没 key 时后端回的是 500 common.internal（不是 400），所以 nokey 那一档
  // 前端必须靠配置里的 has_secret 判掉它，而不是靠错误码 —— 桩照实给，图才不会骗人。
  if (p.endsWith('/api/v1/admin/ai/test')) {
    const postal = page.get('aitest');
    if (postal === '401') return { status: 401, body: { error: { code: 'common.unauthorized', message: '鉴权失败：上游拒绝了这把 key', request_id: 'req-shot' } } };
    if (postal === 'timeout') return { status: 408, body: { error: { code: 'common.timeout', message: '请求超时', request_id: 'req-shot' } } };
    if (postal === '500') return { status: 500, body: { error: { code: 'common.internal', message: '服务端内部错误', request_id: 'req-shot' } } };
    return { body: { data: { verdict: 'review', reason: '拿不准是否有外站导流', categories: ['spam'], model: 'deepseek-chat', latency_ms: 812, raw: '{"verdict":"review"}' } } };
  }
  // 其余 /admin/* 照真后端的行为回 404（未知路径就是 404 JSON，见 app/http.go 的 NoRoute）。
  // 2026-10-14：C1/C2/C3 落地后，users / boards* / diagnostics 三组已经走到上面那几条桩里了，
  // 这一条现在只兜「真的没有的路径」。
  if (p.startsWith('/api/v1/admin/')) {
    return { status: 404, body: { error: { code: 'common.route_not_found', message: '接口不存在' } } };
  }
  return undefined;
}
