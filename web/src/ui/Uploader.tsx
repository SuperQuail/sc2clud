import { useRef, useState, type ChangeEvent } from 'react'
import { appUrl } from '../lib/base'

export type UploadMode = 'compressed' | 'original'

export interface UploaderProps {
  /** 服务端上传端点（相对路径，会自动补 dev 前缀） */
  endpoint: string
  csrf: string
  /** 一次最多几张 */
  max?: number
  /** 压缩目标（字节），超过就降质量/降尺寸 */
  targetBytes?: number
  /** 已存在的图片（可选，用于展示当前张数） */
  existing?: number
}

interface Item {
  key: string
  name: string
  originalBytes: number
  bytes: number
  mode: UploadMode
  preview: string
  blob: Blob
}

/** 浏览器端压缩：先在 2560 内限制最长边，再按质量阶梯试，直到达标（复用头像那套思路）。 */
async function compress(file: File, targetBytes: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 2560 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  let out = file
  for (const quality of [0.85, 0.75, 0.65, 0.55, 0.45]) {
    out = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b ?? file), 'image/webp', quality))
    if (out.size <= targetBytes) break
  }
  return out
}

/**
 * 统一的图片上传控件：选原图或压缩、看到压缩后体积、逐张上传。
 * 帖子配图、issue 配图、将来任何地方都用它 —— 不要再各写一份上传 JS。
 */
export function Uploader({ endpoint, csrf, max = 10, targetBytes = 512 * 1024, existing = 0 }: UploaderProps) {
  const [mode, setMode] = useState<UploadMode>('compressed')
  const [items, setItems] = useState<Item[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const input = useRef<HTMLInputElement>(null)

  async function onPick(event: ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(event.target.files ?? [])
    if (!picked.length) return
    if (existing + items.length + picked.length > max) {
      setMsg(`最多 ${max} 张`)
      return
    }
    setBusy(true)
    setMsg('')
    const next: Item[] = []
    for (const file of picked) {
      const blob = mode === 'original' ? file : await compress(file, targetBytes)
      next.push({
        key: `${file.name}-${file.size}-${next.length}`,
        name: file.name,
        originalBytes: file.size,
        bytes: blob.size,
        mode,
        preview: URL.createObjectURL(blob),
        blob,
      })
    }
    setItems((prev) => [...prev, ...next])
    setBusy(false)
    if (input.current) input.current.value = ''
  }

  async function upload() {
    setBusy(true)
    setMsg('')
    try {
      for (const item of items) {
        const form = new FormData()
        form.append('csrf', csrf)
        form.append('file', item.blob, item.name.replace(/\.[^.]+$/, '.webp'))
        const res = await fetch(appUrl(endpoint), { method: 'POST', body: form })
        if (!res.ok) throw new Error(`上传失败（${res.status}）`)
      }
      setMsg(`已上传 ${items.length} 张，刷新后可见`)
      setItems([])
    } catch (e) {
      setMsg(e instanceof Error ? e.message : '上传失败')
    } finally {
      setBusy(false)
    }
  }

  const kb = (n: number) => `${Math.round(n / 1024)} KB`

  return (
    <div className="uploader-ui">
      <div className="uploader-modes" role="radiogroup" aria-label="上传方式">
        <label className={mode === 'compressed' ? 'on' : ''}>
          <input type="radio" name="upload-mode" checked={mode === 'compressed'} onChange={() => setMode('compressed')} />
          压缩后上传<span>省流量，画质够看</span>
        </label>
        <label className={mode === 'original' ? 'on' : ''}>
          <input type="radio" name="upload-mode" checked={mode === 'original'} onChange={() => setMode('original')} />
          上传原图<span>保留原始画质，体积大</span>
        </label>
      </div>

      <div className="uploader-actions">
        <button className="ui-btn ui-btn-sm" type="button" disabled={busy} onClick={() => input.current?.click()}>
          选择图片
        </button>
        <input ref={input} type="file" accept="image/*" multiple hidden onChange={onPick} />
        <span className="uploader-count">{existing + items.length} / {max} 张</span>
        {items.length > 0 && (
          <button className="ui-btn ui-btn-sm" type="button" disabled={busy} onClick={upload}>
            {busy ? '上传中…' : `上传 ${items.length} 张`}
          </button>
        )}
      </div>

      {items.length > 0 && (
        <ul className="uploader-list">
          {items.map((item) => (
            <li key={item.key}>
              <img src={item.preview} alt="" />
              <span className="uploader-meta">
                {item.mode === 'compressed' ? `压缩 ${kb(item.originalBytes)} → ${kb(item.bytes)}` : `原图 ${kb(item.bytes)}`}
              </span>
              <button className="ui-btn ui-btn-sm" type="button" onClick={() => setItems((prev) => prev.filter((one) => one.key !== item.key))}>移除</button>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="uploader-msg">{msg}</p>}
    </div>
  )
}
