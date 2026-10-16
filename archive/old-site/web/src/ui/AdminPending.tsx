import { useState } from 'react'
import { adminUrl, approvePost, rejectPost, requestRevision, type AdminPendingItem } from '../lib/admin'

export interface AdminPendingProps {
  csrf: string
  items: AdminPendingItem[]
}

const errText = (e: unknown) => (e instanceof Error ? e.message : '请求失败')

/**
 * 待审核：过审 / 打回修改 / 拒绝（意见可选）。
 * 处理成功后该行就地消失（等价老实现的区域刷新）；失败显示在面板顶部，不静默。
 */
export function AdminPending({ csrf, items }: AdminPendingProps) {
  const [rows, setRows] = useState(items)
  const [notes, setNotes] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState('')

  async function act(id: number, action: () => Promise<string>) {
    setError('')
    setBusy(id)
    try {
      await action()
      setRows((prev) => prev.filter((row) => row.id !== id))
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(0)
    }
  }

  return (
    <>
      <h2>待审核 <span className="count">{rows.length}</span></h2>
      <p className="hint">审核机判为「审核中」的帖子只有作者与管理员可见，这里人工过审或拒绝。</p>
      {error && <p className="alert" role="alert">{error}</p>}
      <div className="review-list">
        {rows.length === 0 && <p className="empty">没有待审的帖子了。</p>}
        {rows.map((post) => (
          <article className="review-row" key={post.id}>
            <div className="review-main">
              <div className="chips"><span className="chip">{post.sectionLabel}</span><span className="chip">{post.kindLabel}</span></div>
              <h3><a href={adminUrl(`/p/${post.id}`)}>{post.title}</a></h3>
              <p className="row-preview">{post.preview}</p>
              <p className="meta byline">{post.author} · {post.timeAgo}</p>
            </div>
            <div className="review-actions">
              <button
                className="btn ok sm"
                type="button"
                disabled={busy === post.id}
                onClick={() => void act(post.id, () => approvePost(post.id, csrf))}
              >通过</button>
              <div className="inline-form">
                <button
                  className="btn ghost sm"
                  type="button"
                  disabled={busy === post.id}
                  onClick={() => void act(post.id, () => requestRevision(post.id, csrf, notes[post.id] ?? ''))}
                >打回修改</button>
                <input
                  type="text"
                  placeholder="修改意见（可选）"
                  maxLength={80}
                  aria-label="修改意见"
                  value={notes[post.id] ?? ''}
                  onChange={(event) => setNotes((prev) => ({ ...prev, [post.id]: event.target.value }))}
                />
              </div>
              <div className="inline-form">
                <button
                  className="btn ghost danger sm"
                  type="button"
                  disabled={busy === post.id}
                  onClick={() => void act(post.id, () => rejectPost(post.id, csrf, notes[post.id] ?? ''))}
                >拒绝</button>
                <input
                  type="text"
                  placeholder="拒绝理由（可选）"
                  maxLength={80}
                  aria-label="拒绝理由"
                  value={notes[post.id] ?? ''}
                  onChange={(event) => setNotes((prev) => ({ ...prev, [post.id]: event.target.value }))}
                />
              </div>
            </div>
          </article>
        ))}
      </div>
    </>
  )
}
