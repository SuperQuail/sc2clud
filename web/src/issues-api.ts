// issue 页的所有网络调用集中在这里（模板不再拼 fetch）

export type IssueKind = 'bug' | 'feature' | 'difficulty' | 'other'
export type IssueState = 'open' | 'closed'

export interface IssueItem {
  id: number
  kind: IssueKind
  kind_label: string
  title: string
  body: string
  state: IssueState
  author: string
  created_at: number
  comment_count: number
}

export interface IssueDetail extends IssueItem {
  comments: IssueComment[]
}

export interface IssueComment {
  id: number
  author: string
  body: string
  created_at: number
}

const base = (postId: number) => `/api/v1/posts/${postId}/issues`

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`请求失败 ${res.status}`)
  return (await res.json()) as T
}

export const listIssues = (postId: number) => fetch(base(postId)).then(json<IssueItem[]>)

export const getIssue = (postId: number, issueId: number) =>
  fetch(`${base(postId)}/${issueId}`).then(json<IssueDetail>)

/** 关闭 / 重新打开：走既有的表单端点（服务端负责权限与留痕）。 */
export async function setIssueState(
  postId: number,
  issueId: number,
  state: IssueState,
  csrf: string,
): Promise<void> {
  const body = new URLSearchParams({ csrf, state })
  const res = await fetch(`/p/${postId}/issues/${issueId}/state`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`操作失败 ${res.status}`)
}

/** 发表评论。 */
export async function addComment(
  postId: number,
  issueId: number,
  bodyText: string,
  csrf: string,
): Promise<void> {
  const body = new URLSearchParams({ csrf, body: bodyText })
  const res = await fetch(`/p/${postId}/issues/${issueId}/comments`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`提交失败 ${res.status}`)
}

/** 发布新反馈。 */
export async function createIssue(
  postId: number,
  input: { kind: IssueKind; title: string; body: string; csrf: string },
): Promise<void> {
  const body = new URLSearchParams(input)
  const res = await fetch(`/p/${postId}/issues`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) throw new Error(`发布失败 ${res.status}`)
}
