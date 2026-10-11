import { useState } from 'react'
import { appUrl } from '../lib/base'
import { Uploader } from './Uploader'

export interface PostImage {
  id: number
  number: number
  href: string
  url: string
  is_first: boolean
  is_last: boolean
}

export interface PostImagesProps {
  postId: number
  csrf: string
  images: PostImage[]
  max: number
  /** 排序/删除端点前缀：/p/{id}/images */
  base: string
}

/**
 * 帖子配图管理：排序、删除、上传集中在控件里（编辑页不再写这些 HTML 与内联 JS）。
 * 排序与删除沿用服务端的表单端点（无 JS 也能用），这里只做无刷新提交。
 */
export function PostImages({ postId, csrf, images: initial, max, base }: PostImagesProps) {
  const [images, setImages] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function act(action: 'move' | 'delete', imageId: number, dir?: 'forward' | 'back') {
    setBusy(true)
    setError('')
    try {
      const form = new URLSearchParams({ csrf })
      if (dir) form.set('dir', dir)
      const url = action === 'move' ? `${base}/${imageId}/move` : `${base}/${imageId}/delete`
      const res = await fetch(appUrl(url), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
      })
      if (!res.ok) throw new Error(`操作失败（${res.status}）`)
      // 顺序与列表由服务端裁定，重新载入当前页最稳（避免客户端与服务端不一致）
      location.reload()
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
      setBusy(false)
    }
  }

  return (
    <div className="image-manager-ui">
      {images.length > 0 && (
        <div className="image-manager">
          {images.map((image) => (
            <figure className="image-cell" key={image.id}>
              <a href={image.href} target="_blank" rel="noopener">
                <img data-post-image src={image.url} alt="" />
              </a>
              <figcaption>
                <span className="meta">#{image.number}</span>
                <span className="image-actions">
                  <button className="icon-btn" type="button" title="往前挪一位" disabled={image.is_first || busy} onClick={() => void act('move', image.id, 'forward')}>←</button>
                  <button className="icon-btn" type="button" title="往后挪一位" disabled={image.is_last || busy} onClick={() => void act('move', image.id, 'back')}>→</button>
                  <button className="icon-btn danger" type="button" title="删除这张配图" disabled={busy} onClick={() => void act('delete', image.id)}>✕</button>
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      <p className="hint">用 ← / → 调整顺序，✕ 删除；顺序就是帖子页里的展示顺序。</p>
      <Uploader endpoint={`/api/v1/posts/${postId}/images`} csrf={csrf} max={max} existing={images.length} />
      {error && <p className="hint" style={{ color: '#b91c1c' }}>{error}</p>}
    </div>
  )
}
