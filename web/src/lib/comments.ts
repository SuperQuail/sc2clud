// 评论数据层：唯一允许出现 fetch 的地方（AGENTS §6.6）
import { appUrl } from './base'

export interface CommentItem {
  id: number
  author: string
  handle: string
  author_id: number
  avatar?: string | null
  avatar_small?: string | null
  title?: string | null
  title_color?: string | null
  body?: string
  body_html?: string
  created_at: string
  likes: number
  dislikes: number
  my_vote: number
  replies?: CommentItem[]
}

/** 列表：帖子返回数组，issue 详情返回对象里的 comments */
export async function loadComments(url: string): Promise<CommentItem[]> {
  const res = await fetch(appUrl(url))
  if (!res.ok) throw new Error(`加载失败（${res.status}）`)
  const data: unknown = await res.json()
  if (Array.isArray(data)) return data as CommentItem[]
  const boxed = data as { comments?: CommentItem[] }
  return boxed.comments ?? []
}

/** 发表：服务端是表单端点，csrf 走隐藏字段 */
export async function postComment(action: string, csrf: string, body: string, parentId?: number) {
  const form = new URLSearchParams({ csrf, body })
  if (parentId) form.set('parent_id', String(parentId))
  const res = await fetch(appUrl(action), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  })
  if (!res.ok) throw new Error(`发表失败（${res.status}）`)
}

/** 点赞：JSON 体 + x-csrf-token 头（与服务端 comment_vote 一致） */
export async function voteComment(id: number, value: number, csrf: string) {
  const res = await fetch(appUrl(`/api/v1/comments/${id}/vote`), {
    method: 'POST'
    ,
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ value }),
  })
  if (!res.ok) throw new Error(`操作失败（${res.status}）`)
}

export interface MentionUser {
  id: number
  handle: string
  display_name: string
}

export async function searchUsers(keyword: string): Promise<MentionUser[]> {
  const res = await fetch(appUrl(`/api/v1/users/search?q=${encodeURIComponent(keyword)}`))
  if (!res.ok) return []
  const data: unknown = await res.json()
  if (Array.isArray(data)) return data as MentionUser[]
  return ((data as { users?: MentionUser[] }).users ?? [])
}
