import type { UserSummary } from '@/ui/user/user-badge';
import { sum } from './content';
import { USERS } from './users';

function u(username: string) {
  const found = USERS.find((x) => x.username === username);
  if (!found) throw new Error('unknown user ' + username);
  return found;
}

// 发信账号（DB §4.8 mail_accounts）。凭据只显示「已配置/未配置 + 时间」——secret_cipher 只写不回读。
export type MailAccount = {
  id: string;
  name: string;
  provider: 'resend' | 'smtp';
  priority: number;
  daily_limit: number;
  sent_today: number;
  from_address: string;
  from_name: string;
  enabled: boolean;
  status: 'active' | 'archived';
  secret_configured: boolean;
  secret_updated_at: string | null;
  last_ok_at: string | null;
  last_error: string | null;
  last_error_at: string | null;
};

export const MAIL_ACCOUNTS: MailAccount[] = [
  {
    id: 'ma_1', name: 'resend-main', provider: 'resend', priority: 100, daily_limit: 3000, sent_today: 412,
    from_address: 'noreply@example.com', from_name: 'SC2clud', enabled: true, status: 'active',
    secret_configured: true, secret_updated_at: '2026-09-20T02:00:00Z',
    last_ok_at: '2026-10-12T13:20:00Z', last_error: null, last_error_at: null,
  },
  {
    id: 'ma_2', name: 'smtp-backup', provider: 'smtp', priority: 50, daily_limit: 500, sent_today: 0,
    from_address: 'mail@example.com', from_name: 'SC2clud 备用', enabled: true, status: 'active',
    secret_configured: true, secret_updated_at: '2026-08-11T06:30:00Z',
    last_ok_at: '2026-10-01T09:00:00Z',
    last_error: '535 authentication failed（密码已轮换，待更新）', last_error_at: '2026-10-09T18:40:00Z',
  },
  {
    id: 'ma_3', name: 'old-sendgrid', provider: 'smtp', priority: 10, daily_limit: 200, sent_today: 0,
    from_address: 'noreply@mail.example.com', from_name: 'SC2clud 旧通道', enabled: false, status: 'archived',
    secret_configured: false, secret_updated_at: null,
    last_ok_at: '2026-03-02T01:00:00Z', last_error: '供应商已下线', last_error_at: '2026-03-02T01:00:00Z',
  },
];

// 站点设置（DB §4.9 site_settings：key/value/updated_at）。kind 决定用哪个控件编辑。
export type SiteSetting = {
  key: string;
  label: string;
  grp: '站点' | '注册与审核' | '赞赏' | '邮件';
  value: string;
  kind: 'text' | 'multiline' | 'toggle' | 'select';
  options?: string[];
  hint: string;
};

export const SITE_SETTINGS: SiteSetting[] = [
  { key: 'site.name', label: '站点名称', grp: '站点', value: 'SC2clud 战役作者社区', kind: 'text', hint: '出现在顶栏、分享卡片与邮件落款' },
  { key: 'site.tagline', label: '一句话简介', grp: '站点', value: '星际争霸自定义战役的发布、讨论与资源集散地', kind: 'text', hint: '首页与 <meta> 描述' },
  { key: 'site.footer_note', label: '页脚文案', grp: '站点', value: '本站与暴雪娱乐无隶属关系，所有战役版权归作者所有。', kind: 'multiline', hint: '支持纯文本，换行保留' },
  { key: 'registration.open', label: '开放注册', grp: '注册与审核', value: 'on', kind: 'toggle', hint: '关闭后只有管理员能建号' },
  { key: 'registration.require_activation', label: '注册后需要激活', grp: '注册与审核', value: 'on', kind: 'toggle', hint: '激活前可读、不可发帖回复（users.activated_at）' },
  { key: 'post.review_policy', label: '发帖审核策略', grp: '注册与审核', value: 'untrusted', kind: 'select', options: ['untrusted', 'all', 'off'], hint: 'untrusted = 仅未标记 trusted 的作者进人工审核队列' },
  { key: 'donation.notice_default', label: '打赏提示默认文案', grp: '赞赏', value: '如果这份战役帮到了你，可以扫码支持作者。站点不经手资金。', kind: 'multiline', hint: '作者可覆盖；超管在这里配默认值' },
  { key: 'donation.enabled', label: '开放打赏', grp: '赞赏', value: 'on', kind: 'toggle', hint: '关闭后收款码与申报入口全站隐藏' },
  { key: 'mail.enabled', label: '发信总开关', grp: '邮件', value: 'on', kind: 'toggle', hint: '关闭后注册验证与找回密码都不可用（危险）' },
  { key: 'mail.from_name', label: '默认发信人名称', grp: '邮件', value: 'SC2clud', kind: 'text', hint: '账号级配置优先' },
];

// 域名（DB §4.9 site_domains；is_primary 部分唯一索引保证只有一个主域名）。§21.2 无端点 → 只读展示。
export type SiteDomain = { domain: string; is_primary: boolean };

export const SITE_DOMAINS: SiteDomain[] = [
  { domain: 'sc2clud.example', is_primary: true },
  { domain: 'www.sc2clud.example', is_primary: false },
  { domain: 'dev.sc2clud.example', is_primary: false },
];

// 审计日志（DB §4.1 audit_logs）。escalation = 提权类，9.8 要求这类操作必须留痕。
export type AuditLog = {
  id: string;
  actor: UserSummary | null;
  action: string;
  target_type: 'user' | 'role' | 'board' | 'mail_account' | 'site' | 'reward' | 'report' | 'title';
  target_id: string;
  detail: string;
  ip: string;
  created_at: string;
};

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  'user.ban': '封号 / 解封',
  'user.role.change': '改基线角色',
  'user.permission.grant': '点对点追加权限',
  'user.permission.revoke': '回收追加权限',
  'role.edit': '改角色权限矩阵',
  'board.acl.update': '改分区 ACL',
  'board.moderate.grant': '任免分区版主',
  'reward.verify': '打赏核验 / 改判',
  'report.handle': '处理举报',
  'mail.account.update': '改发信账号',
  'site.setting.update': '改站点设置',
  'title.grant': '发 / 收头衔',
  'title.update': '改头衔目录',
};

export const ESCALATION_ACTIONS = [
  'user.role.change', 'user.permission.grant', 'user.permission.revoke', 'role.edit', 'board.moderate.grant', 'mail.account.update',
];

export const AUDIT_LOGS: AuditLog[] = [
  { id: 'al_01', actor: sum(u('demo-admin')), action: 'user.ban', target_type: 'user', target_id: 'u_03', detail: 'status: active → banned；原因：刷屏推广外站', ip: '203.0.113.24', created_at: '2026-10-10T14:20:00Z' },
  { id: 'al_02', actor: sum(u('demo-admin')), action: 'reward.verify', target_type: 'reward', target_id: 'rw_05', detail: 'state: pending → approved；amount_cents: 5000', ip: '203.0.113.24', created_at: '2026-10-05T13:00:00Z' },
  { id: 'al_03', actor: sum(u('demo-overseer')), action: 'user.permission.grant', target_type: 'user', target_id: 'u_01', detail: 'permissions: +user.ban, +board.manage；expires_at: null；reason: 值班管理员', ip: '198.51.100.7', created_at: '2026-10-01T02:00:00Z' },
  { id: 'al_04', actor: sum(u('demo-overseer')), action: 'role.edit', target_type: 'role', target_id: 'r_moderator', detail: 'permissions: +post.lock（矩阵变更）', ip: '198.51.100.7', created_at: '2026-09-28T08:12:00Z' },
  { id: 'al_05', actor: sum(u('demo-admin')), action: 'board.acl.update', target_type: 'board', target_id: 'b_5', detail: 'role r_creator: deny_reply false → true', ip: '203.0.113.24', created_at: '2026-09-25T10:40:00Z' },
  { id: 'al_06', actor: sum(u('demo-overseer')), action: 'board.moderate.grant', target_type: 'board', target_id: 'b_1', detail: 'user u_12（虚空辉光舰）granted；expires_at: 2026-12-01', ip: '198.51.100.7', created_at: '2026-09-01T00:00:00Z' },
  { id: 'al_07', actor: sum(u('demo-admin')), action: 'site.setting.update', target_type: 'site', target_id: 'donation.notice_default', detail: 'value: （旧文案） → （新文案）', ip: '203.0.113.24', created_at: '2026-08-30T06:00:00Z' },
  { id: 'al_08', actor: sum(u('demo-overseer')), action: 'mail.account.update', target_type: 'mail_account', target_id: 'ma_2', detail: 'enabled: true；secret 轮换失败（535）', ip: '198.51.100.7', created_at: '2026-08-11T06:30:00Z' },
  { id: 'al_09', actor: sum(u('demo-admin')), action: 'report.handle', target_type: 'report', target_id: 'rp_05', detail: 'state: open → handled；note: 已封号', ip: '203.0.113.24', created_at: '2026-10-10T14:18:00Z' },
  { id: 'al_10', actor: sum(u('demo-admin')), action: 'title.grant', target_type: 'user', target_id: 'u_08', detail: 'title: campaign_author（战役作者）', ip: '203.0.113.24', created_at: '2026-07-02T05:00:00Z' },
  { id: 'al_11', actor: null, action: 'user.permission.revoke', target_type: 'user', target_id: 'u_07', detail: '系统任务：回收已过期追加权限 post.review', ip: '127.0.0.1', created_at: '2026-10-01T00:05:00Z' },
  { id: 'al_12', actor: sum(u('demo-overseer')), action: 'user.role.change', target_type: 'user', target_id: 'u_04', detail: 'role: user → creator（认证通过）', ip: '198.51.100.7', created_at: '2026-06-20T09:00:00Z' },
];

// 自检面板（13.12 / §21.2 GET /admin/diagnostics：site.setting 且 debug 开关打开）
export type DiagnosticCheck = { name: string; ok: boolean; detail: string; ms: number };

export const DIAGNOSTICS: { debug_enabled: boolean; version: string; started_at: string; checks: DiagnosticCheck[] } = {
  debug_enabled: true,
  version: 'dev-1c4a9f2',
  started_at: '2026-10-12T02:00:00Z',
  checks: [
    { name: '权限点集合一致性', ok: true, detail: '代码常量 24 个 == permissions 表 24 行', ms: 12 },
    { name: '迁移版本', ok: true, detail: '已应用到 0042_backend_extension', ms: 3 },
    { name: '计数列校准', ok: true, detail: 'topics.reply_count 与 posts 实际差 0 行', ms: 184 },
    { name: '搜索索引延迟', ok: false, detail: 'topic_search 落后 37 条（search:index 任务积压）', ms: 26 },
    { name: '邮件额度账', ok: true, detail: '今日 resend-main 412 / 3000', ms: 8 },
    { name: '过期追加权限清理', ok: true, detail: '最近一次 2026-10-01，回收 2 行', ms: 41 },
    { name: '最近备份', ok: true, detail: '2026-10-12T03:00:00Z（pg_dump + 快照，保留 7 天）', ms: 2 },
    { name: '存储根目录可写', ok: true, detail: '/var/lib/sc2clud/images（只读探针写入 1 字节）', ms: 5 },
  ],
};
// ─────────────────────────────────────────────────────────────────────────────
// D7 AI 帖子审核（唯一真源：完全重构/后端设计/d7-ai-review.md；拍板 §10 钉死四条）
// 权限点沿用 site.setting —— **不新造权限点**（拍板 §10.3）。
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/v1/admin/ai/config。**密钥永不回显**：这里只有 has_secret 与 secret_updated_at。 */
export type AiConfig = {
  enabled: boolean;
  provider: 'deepseek' | 'openai_compatible';
  base_url: string;
  model: string;
  timeout_ms: number;
  max_body_chars: number;
  /** 留空 = 用内置默认提示词（d7 §4） */
  prompt: string;
  has_secret: boolean;
  secret_updated_at: string | null;
  last_ok_at: string | null;
  last_error: string;
  last_error_at: string | null;
};

export const AI_CONFIG: AiConfig = {
  enabled: true,
  provider: 'deepseek',
  base_url: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  timeout_ms: 15000,
  max_body_chars: 4000,
  prompt: '',
  has_secret: true,
  secret_updated_at: '2026-10-01T03:20:00Z',
  last_ok_at: '2026-10-12T13:20:00Z',
  last_error: '超时 15000ms（POST https://api.deepseek.com/chat/completions）',
  last_error_at: '2026-10-11T22:10:00Z',
};

export const AI_PROVIDERS: { key: AiConfig['provider']; label: string }[] = [
  { key: 'deepseek', label: 'deepseek（默认）' },
  { key: 'openai_compatible', label: 'openai_compatible（任何兼容 /chat/completions 的服务）' },
];

/** d7 §4 的内置默认提示词（ai_config.prompt 留空时用它）。集中放一份，界面只读展示要点。 */
export const AI_BUILTIN_PROMPT = [
  '你是中文社区（星际争霸战役作者社区）的内容审核员。判断下面这篇帖子是否适合公开发布。',
  '拒绝（reject）—— 只在这些情况：广告/引流/站外交易；辱骂、人身攻击、歧视、色情、暴力威胁；违法违规；与本站主题完全无关的刷屏。',
  '拿不准（review）—— 必须交人工：不确定是否违规；涉及争议话题、指控某人或真实身份；正文为空/噪声/机器乱码；任何无法判断的情境。',
  '其余一律通过（approve）。宁可放过，不可错杀——误杀一篇正常帖子的代价远大于放过一篇边缘内容。',
  '只输出 JSON：{"verdict":"...","reason":"...","categories":[...]}，不要输出任何其它文字。',
].join('\n');

/** GET /api/v1/admin/ai/stats：来自 review_events（source='ai'）与 ai_config.last_error。 */
export type AiStats = {
  window: '24h' | '7d';
  calls: number;
  approve: number;
  reject: number;
  /** 转人工（verdict=review） */
  review: number;
  avg_latency_ms: number;
  failures: number;
};

export const AI_STATS: AiStats[] = [
  { window: '24h', calls: 128, approve: 109, reject: 6, review: 13, avg_latency_ms: 1120, failures: 3 },
  { window: '7d', calls: 862, approve: 742, reject: 41, review: 79, avg_latency_ms: 1180, failures: 17 },
];

/** 阈值放 site_settings（d7 §2.2），管理员可改、不用发版。 */
export type AiThreshold = { key: string; label: string; value: number; min: number; max: number; hint: string };

export const AI_THRESHOLDS: AiThreshold[] = [
  { key: 'ai.review.report_threshold_1', label: '举报 → AI 复审阈值', value: 3, min: 1, max: 50, hint: '未处理举报累计到这么多条 → 用同一套提示词复审一次' },
  { key: 'ai.review.report_threshold_2', label: '举报 → 直接转人工阈值', value: 5, min: 2, max: 100, hint: '累计到这么多条 → 直接进人工队列，不再调 AI（防举报风暴打爆额度）' },
  { key: 'ai.review.daily_limit_per_topic', label: '单帖每日 AI 调用上限', value: 3, min: 1, max: 20, hint: '同一篇主题一天最多调几次，防刷（d7 §1 硬规则 3）' },
];

/** POST /api/v1/admin/ai/test 的三种回执。
 *  mock：界面上「测试连通」连点会依次走 成功 → 401 → 超时，方便一次看全三种形态（真实实现只返回真结果）。 */
export type AiTestResult =
  | { kind: 'ok'; latency_ms: number; model: string; raw: string }
  | { kind: 'auth'; status: number; message: string }
  | { kind: 'net'; message: string; timeout_ms: number };

export const AI_TEST_SEQUENCE: AiTestResult[] = [
  { kind: 'ok', latency_ms: 842, model: 'deepseek-chat', raw: '{"verdict":"review","reason":"这是一次连通性测试，判为转人工以示返回可解析","categories":["other"]}' },
  { kind: 'auth', status: 401, message: 'authentication_error: Invalid API key provided（Key 可能已撤销或粘贴时带了空格）' },
  { kind: 'net', message: '请求超时：POST https://api.deepseek.com/chat/completions 在 15000ms 内没有响应', timeout_ms: 15000 },
];