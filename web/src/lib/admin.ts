// 管理接口的数据层（只有这里允许出现 fetch）
import { appUrl } from './paths'

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
  const res = await fetch(appUrl(`/admin/sections/${encodeURIComponent(section)}/acl`), {
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
