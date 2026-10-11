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
  /** 已持有的头衔 id（列表徽章 + 弹窗初值）。 */
  titleIds: number[]
}

export interface AdminUsersData {
  users: AdminUserRow[]
  roles: AclRole[]
  groups: AclGroup[]
  sections: { value: string; label: string }[]
  banOptions: AclRole[]
  /** 头衔目录（量小，随面板一次下发；发放/收回失败时前端也能提示）。 */
  titles: AdminTitle[]
}

/** 可发放的头衔（来自 titles 表）。 */
export interface AdminTitle {
  id: number
  name: string
  /** 展示色：CSS 颜色，徽章用 --tc 承接。 */
  color: string
  description: string
  /** 已归档：不能再发，但已持有的仍可收回（界面置灰）。 */
  archived: boolean
}

/** 某人持有的头衔 + 最新目录（弹窗打开时取一次，避免列表里 200 个用户各带一份）。 */
export interface UserTitlesData {
  titles: AdminTitle[]
  held: number[]
}

export async function fetchUserTitles(id: number): Promise<UserTitlesData> {
  const res = await fetch(adminUrl(`/admin/users/${id}/titles`), {
    headers: { 'x-requested-with': 'fetch' },
  })
  const data = (await res.json().catch(() => null)) as (UserTitlesData & { message?: string }) | null
  if (!res.ok) throw new Error(data?.message || `加载头衔失败（${res.status}）`)
  return { titles: data?.titles ?? [], held: data?.held ?? [] }
}

/** 发放 / 收回头衔；回最新的持有集合，界面就地更新。 */
export async function setUserTitle(
  id: number,
  csrf: string,
  titleId: number,
  action: 'grant' | 'revoke',
): Promise<UserTitlesData & { message: string }> {
  const message = await postForm(`/admin/users/${id}/titles`, csrf, [
    ['title_id', String(titleId)],
    ['action', action],
  ])
  // POST 已经回了最新持有集合；再拉一次是多余的，这里只补目录（改名/归档后保持最新）
  const data = await fetchUserTitles(id)
  return { ...data, message }
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

// ------------------------------------------------------------ 头衔目录管理

/** 目录里的一条头衔（管理面板用，比弹窗那份多 key 与持有者数）。 */
export interface AdminTitleRow extends AdminTitle {
  /** 英文标识：代码引用它，建成后不可改。 */
  key: string
  /** 持有这个头衔的用户数。 */
  holders: number
}

export interface TitleCatalogData {
  titles: AdminTitleRow[]
  message?: string
}

/** 目录 + 每个头衔的持有者数（面板挂载时取一次）。 */
export async function fetchTitleCatalog(): Promise<TitleCatalogData> {
  const res = await fetch(adminUrl('/admin/titles'), { headers: { 'x-requested-with': 'fetch' } })
  const data = (await res.json().catch(() => null)) as (TitleCatalogData & { message?: string }) | null
  if (!res.ok) throw new Error(data?.message || `加载头衔目录失败（${res.status}）`)
  return { titles: data?.titles ?? [] }
}

/** 新建头衔；key 重复时后端按「复用已有那条」处理。 */
export function createTitle(
  csrf: string,
  input: { key: string; name: string; color: string; description: string },
): Promise<string> {
  return postForm('/admin/titles', csrf, [
    ['key', input.key],
    ['name', input.name],
    ['color', input.color],
    ['description', input.description],
  ])
}

/** 改名 / 换配色 / 改描述（key 不可改）。 */
export function updateTitle(
  id: number,
  csrf: string,
  input: { name: string; color: string; description: string },
): Promise<string> {
  return postForm(`/admin/titles/${id}`, csrf, [
    ['name', input.name],
    ['color', input.color],
    ['description', input.description],
  ])
}

export function setTitleArchived(id: number, csrf: string, archived: boolean): Promise<string> {
  return postForm(`/admin/titles/${id}/archive`, csrf, [['archived', archived ? '1' : '0']])
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

// ------------------------------------------------------------ 分区封面与顺序（SectionCovers）

/** 一个分区的封面卡片初值（数组顺序＝当前分区顺序）。 */
export interface CoverRow {
  value: string
  label: string
  /** 已有封面的内容哈希（没有则 null） */
  cover: string | null
  /** 是否首位 / 末位：用来禁用对应的 ↑ / ↓ */
  first: boolean
  last: boolean
}

export interface CoversData {
  sections: CoverRow[]
}

/** ↑↓ 调序：后端回最新的分区 key 顺序，界面按它就地重排（不刷新）。 */
export async function moveSection(
  section: string,
  csrf: string,
  dir: 'up' | 'down',
): Promise<string[]> {
  const res = await fetch(adminUrl(`/admin/sections/${encodeURIComponent(section)}/move`), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      'x-requested-with': 'fetch',
    },
    body: new URLSearchParams([['csrf', csrf], ['dir', dir]]),
  })
  const data = (await res.json().catch(() => null)) as { order?: string[]; message?: string } | null
  if (!res.ok) throw new Error(data?.message || `调序失败（${res.status}）`)
  if (!Array.isArray(data?.order)) throw new Error('调序失败：后端没有回新的顺序')
  return data.order
}

/** 上传分区封面：原始图片字节 + header 里的 CSRF（与后端 set_section_cover 对齐）。 */
export async function uploadSectionCover(
  section: string,
  csrf: string,
  file: File,
): Promise<string> {
  const res = await fetch(adminUrl(`/admin/sections/${encodeURIComponent(section)}/cover`), {
    method: 'POST',
    headers: { 'x-csrf-token': csrf, 'x-requested-with': 'fetch', accept: 'application/json' },
    body: file,
  })
  const data = (await res.json().catch(() => null)) as { message?: string } | null
  if (!res.ok || res.redirected) {
    throw new Error(data?.message || `上传失败（${res.status}），请检查图片或稍后重试。`)
  }
  return data?.message ?? '封面已更新'
}
