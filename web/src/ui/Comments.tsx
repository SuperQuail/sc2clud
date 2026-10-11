import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  loadComments,
  postComment,
  searchUsers,
  voteComment,
  type CommentItem,
  type MentionUser,
} from '../lib/comments'

export interface CommentsProps {
  /** 列表 JSON 地址（帖子数组 / issue 对象都支持） */
  list: string
  /** 发表地址（表单端点） */
  action: string
  csrf: string
  canReply: boolean
  /** 是否显示点赞/回复等动作（issue 评论暂无端点时关掉） */
  showActions: boolean
  loggedIn: boolean
}

function Avatar({ item, small }: { item: CommentItem; small?: boolean }) {
  const hash = small ? item.avatar_small ?? item.avatar : item.avatar ?? item.avatar_small
  const cls = small ? 'avatar c-avatar sm' : 'avatar c-avatar'
  const size = small ? 26 : 40
  return hash
    ? <img className={cls} src={`/avatar/${hash}`} alt="" width={size} height={size} loading="lazy" />
    : <img className={cls} src="/static/art/miyin-chibi-80.webp" alt="" width={size} height={size} loading="lazy" />
}

/** 回复输入：带 @ 补全（输入 @ 后弹出候选，插入 `@昵称#id` 与服务端约定一致）。 */
function ReplyBox({
  action,
  csrf,
  parentId,
  onDone,
  onCancel,
}: {
  action: string
  csrf: string
  parentId?: number
  onDone: () => void
  onCancel?: () => void
}) {
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [users, setUsers] = useState<MentionUser[]>([])
  const area = useRef<HTMLTextAreaElement>(null)

  async function onInput(value: string) {
    setBody(value)
    const caret = area.current?.selectionStart ?? value.length
    const hit = /@([^@\s#]{1,16})$/.exec(value.slice(0, caret))
    if (!hit) { setUsers([]); return }
    setUsers(await searchUsers(hit[1]))
  }

  function pick(user: MentionUser) {
    const caret = area.current?.selectionStart ?? body.length
    const before = body.slice(0, caret).replace(/@([^@\s#]{1,16})$/, `@${user.display_name}#${user.id} `)
    const next = before + body.slice(caret)
    setBody(next)
    setUsers([])
    area.current?.focus()
  }

  async function submit() {
    if (body.trim().length < 2) { setError('至少 2 个字'); return }
    setBusy(true)
    setError('')
    try {
      await postComment(action, csrf, body.trim(), parentId)
      setBody('')
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : '发表失败')
    } finally {
      setBusy(false)
    }
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') { setUsers([]); onCancel?.() }
  }

  return (
    <div className="c-reply-box" style={{ position: 'relative' }}>
      <textarea
        ref={area}
        className="c-reply-input"
        rows={2}
        value={body}
        minLength={2}
        maxLength={2000}
        placeholder={parentId ? '回复这一层… 支持 @ 某人' : '写下你的回复… 支持 @ 某人'}
        onChange={(e) => onInput(e.target.value)}
        onKeyDown={onKey}
      />
      {users.length > 0 && (
        <div className="mention-pop">
          {users.slice(0, 6).map((user) => (
            <div key={user.id} className="mention-item" onClick={() => pick(user)}>
              <b>{user.display_name}</b>
              <span className="mi-handle">@{user.handle}</span>
            </div>
          ))}
        </div>
      )}
      {error && <p className="hint" style={{ color: '#b91c1c' }}>{error}</p>}
      <div className="c-reply-actions">
        <button className="btn sm" type="button" disabled={busy} onClick={submit}>
          {busy ? '发送中…' : parentId ? '回复' : '发布回复'}
        </button>
        {onCancel && <button className="c-act" type="button" onClick={onCancel}>取消</button>}
      </div>
    </div>
  )
}

/**
 * 统一评论控件：帖子评论与 issue 评论共用（控件库内的 React 组件，逻辑不再写在模板里）。
 * 样式沿用站点既有的 .comment/.c-* 类名（static/post.css），因此两边外观完全一致。
 */
export function Comments({ list, action, csrf, canReply, showActions, loggedIn }: CommentsProps) {
  const [items, setItems] = useState<CommentItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [replyTo, setReplyTo] = useState<number | null>(null)
  const [menuFor, setMenuFor] = useState<number | null>(null)

  async function reload() {
    try {
      setItems(await loadComments(list))
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { void reload() }, [list])

  async function vote(item: CommentItem) {
    if (!showActions) return
    await voteComment(item.id, item.my_vote === 1 ? 0 : 1, csrf)
    await reload()
  }

  function copyLink(id: number) {
    const url = `${location.origin}${location.pathname}#c${id}`
    void navigator.clipboard?.writeText(url)
    setMenuFor(null)
  }

  const total = items.reduce((sum, item) => sum + 1 + (item.replies?.length ?? 0), 0)

  return (
    <section className="card" id="comments">
      <h2>回复 <span className="count">{total}</span></h2>
      {loading && <p className="hint">正在加载回复…</p>}
      {error && <p className="hint" style={{ color: '#b91c1c' }}>{error}</p>}
      {!loading && items.length === 0 && (
        <div className="community-empty">
          <img src="/static/art/miyin/smile-160.webp" width={80} height={80} alt="" />
          <p>还没有回复，来说两句吧。</p>
        </div>
      )}
      {items.length > 0 && (
        <div className="comments cui-1">
          {items.map((item) => (
            <div className="comment" id={`c${item.id}`} key={item.id}>
              <Avatar item={item} />
              <div className="c-main">
                <div className="c-head">
                  <span className="c-floor">NO.{item.id}</span>
                  <b className="c-name">{item.author}</b>
                  {item.title && (
                    <span className="c-title" style={{ ['--tc' as string]: item.title_color ?? undefined }}>
                      {item.title}
                    </span>
                  )}
                </div>
                {item.body_html
                  ? <div className="c-body" dangerouslySetInnerHTML={{ __html: item.body_html }} />
                  : <div className="c-body">{item.body}</div>}
                <div className="c-actions">
                  <time className="meta">{item.created_at}</time>
                  {showActions && (
                    <>
                      <button
                        className={`c-act c-like${item.my_vote === 1 ? ' on' : ''}`}
                        type="button"
                        onClick={() => void vote(item)}
                      >
                        👍 <span className="c-like-count">{item.likes}</span>
                      </button>
                      {canReply && (
                        <button className="c-act" type="button" onClick={() => setReplyTo(item.id)}>回复</button>
                      )}
                      <span className="c-more">
                        <button className="c-act c-more-btn" type="button" onClick={() => setMenuFor(menuFor === item.id ? null : item.id)}>⋯</button>
                        {menuFor === item.id && (
                          <span className="c-more-panel">
                            <button className="c-more-item" type="button" onClick={() => copyLink(item.id)}>复制评论链接</button>
                          </span>
                        )}
                      </span>
                    </>
                  )}
                </div>
                {(item.replies?.length ?? 0) > 0 && (
                  <div className="c-subs">
                    {item.replies!.map((sub) => (
                      <div className="c-sub" id={`c${sub.id}`} key={sub.id}>
                        <Avatar item={sub} small />
                        <div className="c-main">
                          <div className="c-head"><b className="c-name">{sub.author}</b></div>
                          {sub.body_html
                            ? <div className="c-body" dangerouslySetInnerHTML={{ __html: sub.body_html }} />
                            : <div className="c-body">{sub.body}</div>}
                          <div className="c-actions">
                            <time className="meta">{sub.created_at}</time>
                            {showActions && (
                              <>
                                <button className={`c-act c-like${sub.my_vote === 1 ? ' on' : ''}`} type="button" onClick={() => void vote(sub)}>
                                  👍 <span className="c-like-count">{sub.likes}</span>
                                </button>
                                {canReply && <button className="c-act" type="button" onClick={() => setReplyTo(item.id)}>回复</button>}
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {canReply && replyTo === item.id && (
                  <ReplyBox action={action} csrf={csrf} parentId={item.id} onDone={() => { setReplyTo(null); void reload() }} onCancel={() => setReplyTo(null)} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {canReply
        ? <ReplyBox action={action} csrf={csrf} onDone={() => void reload()} />
        : <p className="hint" style={{ marginTop: 16 }}>{loggedIn ? '账号激活后才能回复。' : <><a href="/login">登录</a>并激活后可以回复。</>}</p>}
    </section>
  )
}
