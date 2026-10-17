import { api } from './client';

// 用户组（D38）的客户端。字段名照 forum/internal/forum 的 DTO 抄
//（groups_admin.go 的 AdminGroupDTO / AdminGroupMember / AdminGroupACLItem），不照 DevRoom mock 抄。
// 类型独成一份而不是进 admin-types.ts：admin-types.ts 同期有另一个包在改，这里自洽成一个小文件。

/** forum/groups_admin.go 的 AdminGroupDTO。member_count 现算（组是几十个的小表）。 */
export type AdminGroup = {
  id: string;
  key: string;
  name: string;
  description: string;
  member_count: number;
  created_at: string;
  updated_at: string;
};

/** forum/groups_admin.go 的 AdminGroupMember。user_id 是对外 uuid。 */
export type AdminGroupMember = { user_id: string; handle: string; nickname: string; added_at: string };

/** forum/groups_admin.go 的 AdminGroupACLItem —— 行以 group_key 为标识（id 不出 API 的拍板同款）。 */
export type AdminGroupACLItem = {
  group_key: string;
  can_post: boolean;
  can_reply: boolean;
  deny_post: boolean;
  deny_reply: boolean;
};

// ── 组 CRUD ─────────────────────────────────────────────────────
// 这个组走 user.ban（动「谁在哪个组」）；分区的组矩阵走 board.manage —— 与角色矩阵同闸。

export function fetchGroups(signal?: AbortSignal): Promise<AdminGroup[]> {
  return api<AdminGroup[]>('admin/groups', { signal });
}

/** 建组。key 建后不可改（slug 同一条纪律），只有这里能传；重复 / 非法 key 是 400 挂 key。 */
export function createGroup(b: { key: string; name: string; description: string }): Promise<AdminGroup> {
  return api<AdminGroup>('admin/groups', { method: 'POST', body: b });
}

/** 改组：只发改动过的字段（后端指针输入，空 body 400）。没有 key —— 改不了。 */
export function updateGroup(id: string, b: { name: string; description: string }): Promise<AdminGroup> {
  return api<AdminGroup>('admin/groups/' + encodeURIComponent(id), { method: 'PATCH', body: b });
}

/** 删组：成员与分区组行为随组级联清空（权限立即收回）。 */
export function deleteGroup(id: string): Promise<void> {
  return api<void>('admin/groups/' + encodeURIComponent(id), { method: 'DELETE' });
}

// ── 组员 ───────────────────────────────────────────────────────

export function fetchGroupMembers(id: string, signal?: AbortSignal): Promise<AdminGroupMember[]> {
  return api<AdminGroupMember[]>('admin/groups/' + encodeURIComponent(id) + '/members', { signal });
}

export function addGroupMember(id: string, userId: string): Promise<AdminGroupMember[]> {
  return api<AdminGroupMember[]>('admin/groups/' + encodeURIComponent(id) + '/members', {
    method: 'POST',
    body: { user_id: userId },
  });
}

export function removeGroupMember(id: string, userId: string): Promise<AdminGroupMember[]> {
  return api<AdminGroupMember[]>('admin/groups/' + encodeURIComponent(id) + '/members/' + encodeURIComponent(userId), {
    method: 'DELETE',
  });
}

// ── 分区 × 组矩阵 ────────────────────────────────────────────────

export function fetchBoardGroupAcl(boardId: string, signal?: AbortSignal): Promise<AdminGroupACLItem[]> {
  return api<AdminGroupACLItem[]>('admin/boards/' + encodeURIComponent(boardId) + '/group-acl', { signal });
}

/** 分区 × 组矩阵**全量替换**（照角色矩阵：少给一行就真删掉；矛盾 / 重复 / 组不存在 400）。 */
export function replaceBoardGroupAcl(boardId: string, acls: AdminGroupACLItem[]): Promise<AdminGroupACLItem[]> {
  return api<AdminGroupACLItem[]>('admin/boards/' + encodeURIComponent(boardId) + '/group-acl', {
    method: 'PUT',
    body: { acls },
  });
}