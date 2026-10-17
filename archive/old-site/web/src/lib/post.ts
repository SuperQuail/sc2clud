// 帖子页数据层：点赞 / 收藏 / 「⋯」菜单（AGENTS §6.6：fetch 只住在 lib/）
import { appUrl } from './paths'

/** 服务端 toggle_like / toggle_bookmark 的返回（成功时 ok=true） */
interface ToggleReply {
  ok?: boolean
  message?: string
  liked?: boolean
  count?: number
  bookmarked?: boolean
}

async function toggle(action: string, csrf: string): Promise<ToggleReply> {
  const res = await fetch(appUrl(action), {
    method: 'POST',
    headers: {
      'x-requested-with': 'fetch',
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    credentials: 'same-origin',
    body: new URLSearchParams({ csrf }),
  })
  // 未登录会被 require_user 302 到登录页，fetch 会跟过去拿到一张 HTML
  if (res.redirected) throw new Error('登录后才能点赞或收藏')
  const data = (await res.json().catch(() => ({}))) as ToggleReply
  if (!res.ok || !data.ok) throw new Error(data.message || `操作失败（${res.status}）`)
  return data
}

export function toggleLike(action: string, csrf: string) {
  return toggle(action, csrf)
}

export function toggleBookmark(action: string, csrf: string) {
  return toggle(action, csrf)
}

/**
 * 「⋯」菜单里的审核动作（templates/post_actions.html 的 form[data-async]）。
 * 地址与 csrf 都在表单里；服务端认 x-requested-with: fetch 才回 JSON。
 * 成功后整页重载——菜单里的动作会改审核状态，页面上的文案得跟着变。
 */
export async function submitAsyncForm(form: HTMLFormElement) {
  // 不能直接发 FormData：那是 multipart/form-data，axum 的 Form 提取器只吃 urlencoded（415）
  const payload = new URLSearchParams()
  new FormData(form).forEach((value, key) => {
    if (typeof value === 'string') payload.append(key, value)
  })
  const res = await fetch(appUrl(form.getAttribute('action') ?? ''), {
    method: 'POST',
    body: payload,
    headers: {
      'x-requested-with': 'fetch',
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    credentials: 'same-origin',
  })
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string }
  if (!res.ok || !data.ok) throw new Error(data.message || `操作失败（${res.status}）`)
  location.reload()
}
