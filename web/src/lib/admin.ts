// 管理接口的数据层（只有这里允许出现 fetch）
//
// 路径前缀：dev 实例挂在 /dev/ 下，而 nginx 的 sub_filter 只补 HTML 里的属性；
// lib/paths.ts 的 basePath() 只认 /p/{id}，管理页拿不到前缀。
// 岛产物固定在 <前缀>/static/islands/ 下，从自身 URL 反推最稳。
const base = new URL('.', import.meta.url).pathname.replace(/static\/islands\/$/, '')

/** 岛内所有绝对路径都经它（含 <img src>：那也走不到 nginx 的 sub_filter）。 */
export function adminUrl(path: string): string {
  return base + path.replace(/^\//, '')
}

/** 管理端点的表单式 POST：csrf 走字段、x-requested-with 让后端回 JSON 而不是 302。 */
async function postForm(path: string, csrf: string, fields: [string, string][]): Promise<string> {
  const res = await fetch(adminUrl(path), {
    method: 'POST',
    headers: {
      // 不能发 FormData（multipart 会被 axum 的 Form 提取器 415）
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-requested-with': 'fetch',
    },
    body: new URLSearchParams([['csrf', csrf], ...fields]),
  })
  const data = (await res.json().catch(() => null)) as { message?: string } | null
  if (!res.ok) throw new Error(data?.message || `请求失败（${res.status}）`)
  return data?.message ?? '已保存'
}

// ------------------------------------------------------------ 分区发言权限（SectionAcl）

export interface AclRole {
  value: string
  label: string
}

export interface AclGroup {
  id: number
  name: string
}

export interface AclRow {
  value: string
  label: string
  post: string
  reply: string
  /** 0 不启用 / 1 白名单 / 2 黑名单 */
  mode: number
  /** 当前生效的用户组 id（由组的规则反推） */
  groupIds: number[]
}

export interface AclData {
  sections: AclRow[]
  groups: AclGroup[]
  roles: AclRole[]
}

/** 保存一个分区的发言权限（JSON + x-csrf-token，与后端 SectionAclForm 对齐）。 */
export async function saveSectionAcl(
  section: string,
  input: { csrf: string; post: string; reply: string; mode: number; groupIds: number[] },
): Promise<void> {
  const res = await fetch(adminUrl(`/admin/sections/${encodeURIComponent(section)}/acl`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': input.csrf },
    body: JSON.stringify({
      csrf: input.csrf,
      post_min_role: input.post,
      reply_min_role: input.reply,
      group_mode: String(input.mode),
      groups: input.groupIds.join(','),
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`保存失败（${res.status}）${text ? '：' + text.slice(0, 120) : ''}`)
  }
}

// ------------------------------------------------------------ 用户列表面板

export interface AdminUserRow {
  id: number
  handle: string
  displayName: string
  /** 无头像时圆形底上显示的首字符。 */
  initial: string
  /** 无头像时的配色序号（0..5，对应 CSS 的 c0..c5）。 */
  colorIndex: number
  avatar: string | null
  activated: boolean
  online: boolean
  trusted: boolean
  /** 限期禁言的显示文案（空串 = 没被禁）。 */
  banLabel: string
  isSelf: boolean
  role: string
  roleLabel: string
  email: string
  /** 预算（GB，表单回填用）。 */
  quotaGb: string
  lastSeen: string
  createdAt: string
  /** 生效中的处罚，编码成 kind:section:until 分号分隔。 */
  sanctions: string
  /** 所属用户组 id。 */
  groups: number[]
}

export interface AdminUsersData {
  users: AdminUserRow[]
  roles: AclRole[]
  groups: AclGroup[]
  sections: { value: string; label: string }[]
  banOptions: AclRole[]
}

export interface UpdateUserInput {
  csrf: string
  role: string
  displayName: string
  quotaGb: string
  trusted: boolean
  activated: boolean
  newPassword: string
}

/** 弹窗保存：一次把资料改完（等级、预算、信任、激活、密码）。 */
export function updateUser(id: number, input: UpdateUserInput): Promise<string> {
  const fields: [string, string][] = [
    ['display_name', input.displayName],
    ['role', input.role],
    ['quota_gb', input.quotaGb],
  ]
  if (input.trusted) fields.push(['trusted', '1'])
  if (input.activated) fields.push(['activated', '1'])
  if (input.newPassword) fields.push(['new_password', input.newPassword])
  return postForm(`/admin/users/${id}/update`, input.csrf, fields)
}

export function setUserRole(id: number, csrf: string, role: string): Promise<string> {
  return postForm(`/admin/users/${id}/role`, csrf, [['role', role]])
}

export function setUserTrusted(id: number, csrf: string, trusted: boolean): Promise<string> {
  return postForm(`/admin/users/${id}/trusted`, csrf, [['trusted', trusted ? '1' : '0']])
}

export function setUserActivated(id: number, csrf: string, activated: boolean): Promise<string> {
  return postForm(`/admin/users/${id}/${activated ? 'activate' : 'deactivate'}`, csrf, [])
}

/** 限期禁言：hours = "0" 解禁。 */
export function banUser(id: number, csrf: string, hours: string): Promise<string> {
  return postForm(`/admin/users/${id}/ban`, csrf, [['hours', hours]])
}

export function setUserGroups(id: number, csrf: string, groups: number[]): Promise<string> {
  return postForm(`/admin/users/${id}/groups`, csrf, groups.map((g) => ['groups', String(g)] as [string, string]))
}

/** 设置或解除一条处罚：until 留空 = 撤销同类同范围的处罚。 */
export function setSanction(
  id: number,
  csrf: string,
  input: { kind: string; section: string; until: string },
): Promise<string> {
  return postForm(`/admin/users/${id}/sanction`, csrf, [
    ['kind', input.kind],
    ['section', input.section],
    ['until', input.until],
  ])
}

// ------------------------------------------------------------ 待审核面板

export interface AdminPendingItem {
  id: number
  title: string
  sectionLabel: string
  kindLabel: string
  preview: string
  author: string
  timeAgo: string
}

export function approvePost(id: number, csrf: string): Promise<string> {
  return postForm(`/admin/posts/${id}/approve`, csrf, [])
}

export function rejectPost(id: number, csrf: string, note: string): Promise<string> {
  return postForm(`/admin/posts/${id}/reject`, csrf, [['note', note]])
}

/** 打回：状态置为 revision，并通知作者。 */
export function requestRevision(id: number, csrf: string, note: string): Promise<string> {
  return postForm(`/admin/posts/${id}/revision`, csrf, [['note', note]])
}

// ------------------------------------------------------------ 社区开关面板

export interface AdminCommunityData {
  blockReplyEnforced: boolean
}

export function setBlockReply(csrf: string, enabled: boolean): Promise<string> {
  return postForm('/admin/settings/block-reply', csrf, [['enabled', enabled ? '1' : '0']])
}
