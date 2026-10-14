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
  is_super: isSuper, priority: id * 10, perm_keys: [], user_count: 3,
});

export const ME_ADMIN = {
  id: 'u-1', handle: 'demo-admin', nickname: '示范管理员', avatar: null,
  email_verified: true, activated: true, is_super: false,
  perms: ['post.review', 'report.handle', 'reward.verify', 'role.edit', 'role.assign', 'title.grant', 'title.manage', 'board.manage', 'mail.manage', 'site.setting', 'audit.view', 'audit.export', 'user.ban', 'permission.grant'],
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

/** 管理后台的桩。返回 undefined = 不拦（交回真实 fetch）——例如 `GET /admin/users`。 */
export function adminFixtureFor(u: string): Reply | undefined {
  const url = new URL(u, 'http://stub');
  const p = url.pathname;
  if (p.endsWith('/api/v1/admin/topics')) {
    const state = url.searchParams.get('state') ?? 'pending';
    const rows = state === 'all' ? REVIEW.filter((r) => r.review_state !== 'approved') : REVIEW.filter((r) => r.review_state === state);
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
  if (p.endsWith('/api/v1/admin/mail/accounts')) return { body: { data: MAIL } };
  if (p.endsWith('/api/v1/admin/site-settings')) return { body: { data: SETTINGS } };
  if (p.endsWith('/api/v1/admin/site-domains')) return { body: { data: [{ domain: 'sc2clud.example' }] } };
  if (p.endsWith('/api/v1/admin/announcements')) return { body: { data: ANNOUNCEMENTS } };
  if (p.endsWith('/api/v1/admin/banners')) return { body: { data: BANNERS } };
  if (p.endsWith('/api/v1/admin/audit-logs')) return { body: { data: AUDIT, next_cursor: null } };
  if (p.endsWith('/api/v1/admin/ai/config')) return { body: { data: AI_CONFIG } };
  if (p.endsWith('/api/v1/admin/ai/test')) {
    return { body: { data: { verdict: 'review', reason: '拿不准是否有外站导流', categories: ['spam'], model: 'deepseek-chat', latency_ms: 812, raw: '{"verdict":"review"}' } } };
  }
  // 其余 /admin/*（/admin/users、/admin/boards*、/admin/diagnostics）后端**还没有这些路由**。
  // 这里照真后端的行为回 404（真后端对 /api/ 下的未知路径就是 404 JSON，见 app/http.go 的 NoRoute）——
  // 出图要看得见那个真实状态（「用户列表没能加载（HTTP 404）」），而不是静默的空表。
  if (p.startsWith('/api/v1/admin/')) {
    return { status: 404, body: { error: { code: 'common.route_not_found', message: '接口不存在' } } };
  }
  return undefined;
}
