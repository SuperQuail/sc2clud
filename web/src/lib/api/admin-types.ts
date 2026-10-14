import type { PageQuery } from './paging';

// 管理后台的**类型**（契约 /api/v1/admin/*）。与 admin.ts 分两个文件纯粹是体量：
// 前端单文件 ≤ 500 行（gate:size），这一份是 DTO，那一份是请求函数。
//
// **字段名一律照 forum/internal/** 的 DTO 抄**，不照 DevRoom 的 mock 抄**（交接单 §2 规则 9）：
// mock 里有 reason / holders / archived 这些后端**不存在的字段**，照它写就又是一次
// 「两侧各写一份、各自的测试都过」。每个类型上都标了真源文件，改字段名前先去那里比一眼。

export type Role = {
  id: number;
  key: string;
  name: string;
  description: string;
  depth: number;
  badge_color: string;
  is_system: boolean;
  is_super: boolean;
  /** 只用于后台展示排序；9.8/DB §4.1 明确禁止用它做授权判断 */
  priority: number;
  /** role_permissions：**已展开的并集**（写穿到子角色，§9.8） */
  perm_keys: string[];
  user_count: number;
};
export type Permission = { key: string; group: string; name: string; description: string };
export type ExtraPerm = { key: string; expires_at: string | null };
export type AdminUser = {
  id: string;
  username: string;
  nickname: string;
  email: string;
  avatar: string | null;
  /** 基线角色，**单一**（RBAC权限树设计.md §1：角色之间永不并集） */
  role: Role;
  /** 点对点追加（user_permissions）；**读接口不给 reason**，只有 key 与到期 */
  extra_permissions: ExtraPerm[];
  /** 封禁轴 */
  status: string;
  /** 邮箱验证轴 */
  email_verified_at: string | null;
  /** 激活轴：NULL = 能登录、不可写 */
  activated_at: string | null;
  /** trusted = 发帖跳过人工审核（DB §4.1） */
  trusted: boolean;
  created_at: string;
  last_login_at: string | null;
  title: { name: string; color: string | null } | null;
  topic_count: number;
  reply_count: number;
  /** 处罚记录（分区级限期禁言） */
  sanctions: { kind: string; scope: string; until: string; reason: string }[];
};
export type AdminUserFilter = { q?: string; status?: string; activated?: string; email_verified?: string; role?: string } & PageQuery;
export type ReviewQueueItem = {
  id: string;
  board: { slug: string; name: string };
  author: { handle: string; nickname: string; avatar: string; avatar_small: string };
  kind: string;
  title: string;
  excerpt: string;
  review_state: string;
  /** 当前生效的那条理由：AI 判的与人工写的都在这一列，谁写的看 review_source */
  review_note: string | null;
  review_source: string | null;
  /** 上一次判定人（AI 判的 → null） */
  reviewer: { handle: string; nickname: string; avatar: string; avatar_small: string } | null;
  reviewed_at: string | null;
  /** **最近一次判定事件**的结论：approve | reject | review(AI 转人工) | null。
   *  取自 review_events，**不能从 review_state 三态推导**（交接单 C11）。 */
  review_verdict: string | null;
  created_at: string;
  /** 内容版本号：判定时必须原样回传（expected_updated_at） */
  updated_at: string;
};
export type ReviewQueueFilter = { state?: string; board?: string; q?: string } & PageQuery;
export type Report = {
  id: string;
  target_type: string;
  target_id: string;
  target_label: string;
  board: { slug: string; name: string } | null;
  reason: string;
  detail: string;
  reporter: UserBrief | null;
  state: string;
  handler: UserBrief | null;
  handled_at: string | null;
  handle_note: string;
  created_at: string;
  /** 同一目标当前的未处理举报数（阈值压力要看得见） */
  open_reports: number;
  created: boolean;
};
export type UserBrief = { handle: string; nickname: string; avatar: string };
export type ReportFilter = { state?: string; target_type?: string } & PageQuery;
export type BatchItem = { id: string; ok: boolean; code?: string };
export type Donation = {
  id: string;
  amount_cents: number;
  txn_id: string;
  state: string;
  note: string;
  post_id: string;
  channel_id: string;
  donor: UserBrief;
  recipient: UserBrief;
  verifier?: UserBrief;
  verified_at?: string;
  created_at: string;
};
export type DonationFilter = { state?: string } & PageQuery;
export type RecipientIncome = { user: UserBrief; total_cents: number; count: number };
/** 管理侧统计。public_* 只算双方都同意公开的，all_* 是全部 approved。 */
export type DonationStats = {
  public_total_cents: number;
  all_total_cents: number;
  public_count: number;
  all_count: number;
  leaderboard: RecipientIncome[];
};
/** 按渠道的默认提示文案（整表替换）：PATCH /admin/donation-notice-defaults {items}。 */
export type NoticeDefault = { channel: string; text: string };
export type Title = {
  id: string;
  key: string;
  name: string;
  color: string;
  description: string;
  archived_at: string | null;
};
export type MailAccount = {
  id: string;
  name: string;
  provider: string;
  priority: number;
  daily_limit: number;
  sent_today: number;
  reset_tz: string;
  from_address: string;
  from_name: string;
  options_json: unknown;
  enabled: boolean;
  status: string;
  secret_configured: boolean;
  secret_updated_at: string | null;
  last_ok_at: string | null;
  last_error: string;
  last_error_at: string | null;
  created_at: string;
  updated_at: string;
};
export type MailAccountInput = {
  name: string;
  provider: string;
  from_address: string;
  from_name?: string;
  priority?: number;
  daily_limit?: number;
  reset_tz?: string;
  options_json?: unknown;
  secret?: unknown;
  enabled?: boolean;
};
export type SettingItem = {
  key: string;
  label: string;
  group: string;
  kind: string;
  options?: string[];
  value: string;
  hint: string;
  updated_at: string | null;
};
export type Domain = { domain: string };
export type Announcement = {
  id: string;
  title: string;
  body_md: string;
  body_html: string;
  enabled: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};
export type Banner = {
  id: string;
  kind: string;
  text: string;
  url: string;
  starts_at: string;
  ends_at: string | null;
  enabled: boolean;
  /** 角色 key；空 = 所有人（拍板 §8.11 U10） */
  roles: string[];
  created_at: string;
  updated_at: string;
};
export type AuditActor = { id: string; handle: string; nickname: string };
export type AuditItem = {
  /** 自增 id（数字）：游标是不透明串，但列表项的这个字段在契约里就是整数 */
  id: number;
  created_at: string;
  action: string;
  target_type: string;
  target_id: string;
  detail: Record<string, unknown> | null;
  ip: string;
  /** CLI 与系统动作为 null */
  actor: AuditActor | null;
};
export type AuditFilter = {
  target_type?: string;
  target_id?: string;
  action?: string;
  actor?: string;
  from?: string;
  to?: string;
} & PageQuery;
export type AiConfig = {
  enabled: boolean;
  provider: string;
  base_url: string;
  model: string;
  thinking: boolean;
  strict_mode: boolean;
  timeout_ms: number;
  max_output_tokens: number;
  temperature: number;
  prompt: string;
  prompt_report: string;
  has_secret: boolean;
  secret_updated_at: string | null;
  last_ok_at: string | null;
  last_error: string;
  last_error_at: string | null;
};
/** 连通测试的回执：耗时、实际模型名、原始 verdict。 */
export type AiTestView = {
  verdict: string;
  reason: string;
  categories: string[];
  model: string;
  latency_ms: number;
  raw: string;
};