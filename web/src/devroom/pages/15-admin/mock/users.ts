import type { AdminRole, AdminUser } from './core';
import { ROLES } from './roles';
import { CURRENT_ADMIN } from './perms';
import type { UserTitle } from '@/ui/user/title-badge';

// 头衔目录（DB §4.11：titles.key/name/color/description/archived_at；归档不删）
export type AdminTitle = {
  id: string;
  key: string;
  name: string;
  color: string;
  description: string;
  archived_at: string | null;
  holders: number;
};

export const TITLES: AdminTitle[] = [
  { id: 't_1', key: 'campaign_author', name: '战役作者', color: '#2563eb', description: '发布过完整战役的认证作者', archived_at: null, holders: 12 },
  { id: 't_2', key: 'map_artisan', name: '地图工匠', color: '#7c3aed', description: '长期维护对战/合作地图', archived_at: null, holders: 8 },
  { id: 't_3', key: 'veteran', name: '元老', color: '#f97316', description: '旧站迁移过来的创始成员', archived_at: null, holders: 23 },
  { id: 't_4', key: 'beta_tester', name: '测试先锋', color: '#0891b2', description: '参与过启动器内测', archived_at: null, holders: 5 },
  { id: 't_5', key: 'essence_star', name: '精华贡献者', color: '#16a34a', description: '旧站时期的头衔，已并入「战役作者」', archived_at: '2026-08-01T00:00:00Z', holders: 3 },
];

function role(key: string): AdminRole {
  const r = ROLES.find((x) => x.key === key);
  if (!r) throw new Error('unknown role ' + key);
  return r;
}

function title(key: string): UserTitle | null {
  const t = TITLES.find((x) => x.key === key);
  return t ? { key: t.key, name: t.name, color: t.color, description: t.description } : null;
}

type Seed = Omit<AdminUser, 'role' | 'title' | 'extra_permissions'> & {
  role_key: string;
  title_key?: string;
  extra_permissions?: AdminUser['extra_permissions'];
};

const SEED: Seed[] = [
  {
    id: 'u_01', username: 'tangtian', nickname: '唐恬', email: 'tangtian@sc2clud.cn', role_key: 'admin',
    status: 'active', email_verified_at: '2024-03-02T02:10:00Z', activated_at: '2024-03-02T02:12:00Z', trusted: true,
    created_at: '2024-03-02T02:05:00Z', last_login_at: '2026-10-12T09:20:00Z',
    topic_count: 31, reply_count: 402, sanctions: [],
    extra_permissions: CURRENT_ADMIN.extra_permissions.map((p) => ({ ...p })),
  },
  {
    id: 'u_02', username: 'linkai', nickname: '林凯', email: 'linkai@sc2clud.cn', role_key: 'superadmin',
    status: 'active', email_verified_at: '2023-11-11T01:00:00Z', activated_at: '2023-11-11T01:00:00Z', trusted: true,
    created_at: '2023-11-11T00:50:00Z', last_login_at: '2026-10-11T16:02:00Z',
    topic_count: 8, reply_count: 77, sanctions: [], title_key: 'veteran',
  },
  {
    id: 'u_03', username: 'zergling', nickname: '小狗快跑', email: 'zergling@qq.com', role_key: 'user',
    status: 'banned', email_verified_at: '2025-01-20T05:00:00Z', activated_at: '2025-01-20T05:00:00Z', trusted: false,
    created_at: '2025-01-20T04:58:00Z', last_login_at: '2026-09-30T11:40:00Z',
    topic_count: 3, reply_count: 51,
    sanctions: [{ kind: 'mute_post', scope: '全局', until: '2026-11-30T15:59:59Z', reason: '刷屏推广外站' }],
  },
  {
    id: 'u_04', username: 'mapmaker', nickname: '地图工坊', email: 'mapmaker@163.com', role_key: 'creator',
    status: 'active', email_verified_at: '2025-02-14T09:00:00Z', activated_at: '2025-02-14T09:01:00Z', trusted: true,
    created_at: '2025-02-14T08:55:00Z', last_login_at: '2026-10-12T07:12:00Z',
    topic_count: 46, reply_count: 218, sanctions: [], title_key: 'map_artisan',
  },
  {
    id: 'u_05', username: 'rookie', nickname: '新兵蛋子', email: 'rookie@gmail.com', role_key: 'user',
    status: 'active', email_verified_at: '2026-10-08T03:00:00Z', activated_at: null, trusted: false,
    created_at: '2026-10-08T02:58:00Z', last_login_at: '2026-10-12T12:30:00Z',
    topic_count: 0, reply_count: 0, sanctions: [],
  },
  {
    id: 'u_06', username: 'silentsheep', nickname: '沉默的绵羊', email: 'silent@outlook.com', role_key: 'user',
    status: 'active', email_verified_at: null, activated_at: null, trusted: false,
    created_at: '2026-10-11T22:10:00Z', last_login_at: null,
    topic_count: 0, reply_count: 0, sanctions: [],
  },
  {
    id: 'u_07', username: 'zhangwei', nickname: '张伟', email: 'zhangwei@126.com', role_key: 'user',
    status: 'active', email_verified_at: '2025-06-01T02:00:00Z', activated_at: '2025-06-01T02:00:00Z', trusted: false,
    created_at: '2025-06-01T01:50:00Z', last_login_at: '2026-10-12T10:02:00Z',
    topic_count: 12, reply_count: 96,
    sanctions: [{ kind: 'mute_reply', scope: '自制战役', until: '2026-10-20T15:59:59Z', reason: '在资源帖下反复争吵' }],
  },
  {
    id: 'u_08', username: 'artofwar', nickname: '战术大师', email: 'artofwar@foxmail.com', role_key: 'creator',
    status: 'active', email_verified_at: '2024-09-09T09:09:00Z', activated_at: '2024-09-09T09:09:00Z', trusted: true,
    created_at: '2024-09-09T09:00:00Z', last_login_at: '2026-10-12T11:45:00Z',
    topic_count: 88, reply_count: 640, sanctions: [], title_key: 'campaign_author',
  },
  {
    id: 'u_09', username: 'helper', nickname: '版主小助手', email: 'helper@sc2clud.cn', role_key: 'moderator',
    status: 'active', email_verified_at: '2025-04-04T04:04:00Z', activated_at: '2025-04-04T04:04:00Z', trusted: true,
    created_at: '2025-04-04T04:00:00Z', last_login_at: '2026-10-12T08:00:00Z',
    topic_count: 6, reply_count: 311, sanctions: [],
  },
  {
    id: 'u_10', username: 'adbot9000', nickname: '优惠券bot', email: 'adbot@temp-mail.org', role_key: 'user',
    status: 'banned', email_verified_at: null, activated_at: null, trusted: false,
    created_at: '2026-10-05T19:20:00Z', last_login_at: '2026-10-05T19:25:00Z',
    topic_count: 14, reply_count: 0,
    sanctions: [{ kind: 'mute_post', scope: '全局', until: '2030-01-01T00:00:00Z', reason: '广告机器人，已封号' }],
  },
  {
    id: 'u_11', username: 'chenxi', nickname: '晨曦', email: 'chenxi@sc2clud.cn', role_key: 'user',
    status: 'active', email_verified_at: '2026-03-03T03:00:00Z', activated_at: '2026-03-03T03:00:00Z', trusted: false,
    created_at: '2026-03-03T02:50:00Z', last_login_at: '2026-10-12T13:10:00Z',
    topic_count: 9, reply_count: 143, sanctions: [],
  },
  {
    id: 'u_12', username: 'oldfriend', nickname: '老友记', email: 'oldfriend@sc2clud.cn', role_key: 'creator',
    status: 'active', email_verified_at: '2023-12-01T00:00:00Z', activated_at: '2023-12-01T00:00:00Z', trusted: true,
    created_at: '2023-12-01T00:00:00Z', last_login_at: '2026-10-09T02:00:00Z',
    topic_count: 54, reply_count: 289, sanctions: [], title_key: 'veteran',
    // 点对点追加：带 reason 与 expires_at（RBAC权限树设计.md §1.2），只读展示
    extra_permissions: [
      { key: 'post.review', reason: '临时代管审核队列', expires_at: '2026-10-31T15:59:59Z' },
      { key: 'board.moderate', reason: '自制战役版主（试用）', expires_at: '2026-12-01T15:59:59Z' },
    ],
  },
];

export const USERS: AdminUser[] = SEED.map((s) => ({
  ...s,
  role: role(s.role_key),
  title: s.title_key ? title(s.title_key) : null,
  extra_permissions: s.extra_permissions ?? [],
}));

export const CURRENT_ADMIN_USER = USERS[0]!;

/** 当前登录态（/api/v1/me 的形状：role 是基线角色、extra 是追加、is_super 是超管短路位）。 */
export const ME = {
  handle: CURRENT_ADMIN.handle,
  nickname: CURRENT_ADMIN.nickname,
  role_key: CURRENT_ADMIN.role_key,
  is_super: CURRENT_ADMIN.is_super,
  extra: CURRENT_ADMIN.extra_permissions,
};
