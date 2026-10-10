// issue 数据层：只有这里允许出现 fetch（见 AGENTS §6.6）

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

export interface IssueComment {
  id: number
  author: string
  body: string
  created_at: number
}

export interface IssueDetail extends IssueItem {
  comments: IssueComment[]
}

export const ISSUE_KINDS: { value: IssueKind; label: string; hint: string }[] = [
  { value: 'bug', label: '报告 Bug', hint: '打不开、崩溃、闪退、卡关' },
  { value: 'feature', label: '改进意见', hint: '希望新增或调整的功能' },
  { value: 'difficulty', label: '难度建议', hint: '太简单 / 太难 / 想要难度选项' },
  { value: 'other', label: '其它', hint: '不属于上面三类的问题' },
]

async function request<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`请求失败（${res.status}）`)
  return (await res.json()) as T
}

const post = (postId: number) => `/p/${postId}/issues`

export const listIssues = (postId: number) =>
  fetch(`/api/v1/posts/${postId}/issues`).then(request<IssueItem[]>)

export const getIssue = (postId: number, issueId: number) =>
  fetch(`/api/v1/posts/${postId}/issues/${issueId}`).then(request<IssueDetail>)

async function submit(url: string, data: Record<string, string>): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(data),
  })
  if (!res.ok) throw new Error(`提交失败（${res.status}）`)
}

export function createIssue(
  postId: number,
  input: { kind: IssueKind; title: string; body: string; csrf: string },
) {
  return submit(post(postId), { ...input })
}

export function setIssueState(postId: number, issueId: number, state: IssueState, csrf: string) {
  return submit(`${post(postId)}/${issueId}/state`, { csrf, state })
}

export function addComment(postId: number, issueId: number, body: string, csrf: string) {
  return submit(`${post(postId)}/${issueId}/comments`, { csrf, body })
}
