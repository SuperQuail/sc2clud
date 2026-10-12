import type { UserRole } from '@/ui/user/role-badge';
import type { UserTitle } from '@/ui/user/title-badge';
import type { UserSummary } from '@/ui/user/user-badge';

// 管理后台的 mock 数据层。字段名一律照契约（§21.1：JSON snake_case、时间 _at、金额 _cents、id 是 public_id）。
// mock 时间基准固定，保证截图与文案稳定（不随运行时间漂移）。
export const NOW = '2026-10-12T13:46:00Z';

export function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

export function relTime(iso: string | null): string {
  if (!iso) return '—';
  const mins = Math.round((new Date(NOW).getTime() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return mins + ' 分钟前';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + ' 小时前';
  const days = Math.round(hours / 24);
  return days < 31 ? days + ' 天前' : fmtDate(iso);
}

/** 金额**只在展示时**除 100（§21.1 金额是整数分）。 */
export function fmtCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const v = Math.abs(cents);
  return sign + '¥' + Math.floor(v / 100) + '.' + String(v % 100).padStart(2, '0');
}

export type AdminRole = UserRole & {
  id: string;
  key: string;
  name: string;
  parent_id: string | null;
  depth: number;
  description: string;
  is_system: boolean;
  /** 只用于后台展示排序；9.8/DB §4.1 明确禁止用它做授权判断 */
  priority: number;
  member_count: number;
};

export type AdminUser = {
  id: string; // public_id
  username: string; // 登录名，注册后不可改（DB §4.1 不变量）
  nickname: string;
  email: string;
  /** 基线角色，**单一**（RBAC权限树设计.md §1：角色之间永不并集） */
  role: AdminRole;
  /** 点对点追加的权限点（只读展示；授予/回收需要 role.assign） */
  extra_permissions: { key: string; reason: string; expires_at: string | null }[];
  /** 封禁轴 */
  status: 'active' | 'banned' | 'deleted';
  /** 邮箱验证轴 */
  email_verified_at: string | null;
  /** 激活轴：NULL = 能登录、不可写 */
  activated_at: string | null;
  /** trusted = 发帖跳过人工审核（DB §4.1） */
  trusted: boolean;
  created_at: string;
  last_login_at: string | null;
  title: UserTitle | null;
  topic_count: number;
  reply_count: number;
  /** 处罚记录（分区级限期禁言） */
  sanctions: { kind: 'mute_post' | 'mute_reply'; scope: string; until: string; reason: string }[];
};

export type Permission = { key: string; grp: string; description: string };

export function asSummary(u: { handle?: string; nickname: string }): UserSummary {
  return { handle: u.handle ?? '', nickname: u.nickname, avatar: null };
}

export function userSummary(u: AdminUser): UserSummary {
  return { handle: u.username, nickname: u.nickname, avatar: null, role: u.role, title: u.title };
}
