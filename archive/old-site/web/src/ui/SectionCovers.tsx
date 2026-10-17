import { useEffect, useRef, useState } from 'react'
import { adminUrl, moveSection, uploadSectionCover, type CoverRow, type CoversData } from '../lib/admin'
import { Button } from './Button'
import { FilePicker, type FilePickerHandle } from './FilePicker'

export interface SectionCoversProps {
  csrf: string
  data: CoversData
}

type Phase = 'idle' | 'ready' | 'uploading' | 'success' | 'error'

interface CardState {
  /** 待确认的文件（上传中/失败时保留，可以直接重试） */
  file: File | null
  /** 当前预览图：待确认文件的 blob，或上传成功那张的 blob（服务端不回哈希） */
  blob: string | null
  /** 服务端已有的封面哈希 */
  hash: string | null
  /** 本次会话里上传成功的那张（「取消」时要能回到它） */
  committed: string | null
  phase: Phase
  note: string
}

const EMPTY: CardState = { file: null, blob: null, hash: null, committed: null, phase: 'idle', note: '' }

const BADGE: Record<Phase, string> = {
  idle: '', ready: '待确认', uploading: '上传中', success: '已设置', error: '请检查',
}

function withEnds(rows: CoverRow[]): CoverRow[] {
  return rows.map((row, index) => ({ ...row, first: index === 0, last: index === rows.length - 1 }))
}

/** 按后端回的新顺序重排；顺序里没提到的接在后面（不丢卡片）。 */
function reorder(rows: CoverRow[], order: string[]): CoverRow[] {
  const rest = new Map(rows.map((row) => [row.value, row]))
  const next: CoverRow[] = []
  for (const value of order) {
    const row = rest.get(value)
    if (row) {
      next.push(row)
      rest.delete(value)
    }
  }
  return next.concat([...rest.values()])
}

/**
 * 分区封面与顺序：一格一张卡。
 * 预览层只有「占位」或「图片」两种互斥渲染，不再靠多层绝对定位硬叠 —— 这是叠字 bug 的修法；
 * 悬停浮出的「选择新封面」只在有图时渲染。上传/调序走 lib/admin.ts，失败显示在卡片里（不静默）。
 */
export function SectionCovers({ csrf, data }: SectionCoversProps) {
  const [rows, setRows] = useState<CoverRow[]>(data.sections)
  const [cards, setCards] = useState<Record<string, CardState>>({})
  const [moving, setMoving] = useState(false)
  const [orderNote, setOrderNote] = useState('')
  const pickers = useRef<Record<string, FilePickerHandle | null>>({})
  const urls = useRef(new Set<string>())

  // blob URL 不撤就一直占内存：卸载时全撤
  useEffect(() => () => {
    urls.current.forEach((url) => URL.revokeObjectURL(url))
    urls.current.clear()
  }, [])

  const cardOf = (value: string): CardState => cards[value] ?? EMPTY
  const patch = (value: string, next: Partial<CardState>) =>
    setCards((prev) => ({ ...prev, [value]: { ...(prev[value] ?? EMPTY), ...next } }))
  const release = (url: string | null) => {
    if (url && urls.current.delete(url)) URL.revokeObjectURL(url)
  }

  function pick(row: CoverRow, file: File | null) {
    if (!file) return
    const card = cardOf(row.value)
    if (card.blob && card.blob !== card.committed) release(card.blob)
    const url = URL.createObjectURL(file)
    urls.current.add(url)
    patch(row.value, {
      file,
      blob: url,
      phase: 'ready',
      note: file.name + ' · ' + Math.ceil(file.size / 1024) + ' KB，点「确认更换」上传。',
    })
  }

  function cancel(row: CoverRow) {
    const card = cardOf(row.value)
    if (card.blob && card.blob !== card.committed) release(card.blob)
    patch(row.value, {
      file: null,
      blob: card.committed,
      phase: card.committed ? 'success' : 'idle',
      note: '',
    })
  }

  async function confirm(row: CoverRow) {
    const card = cardOf(row.value)
    if (!card.file || card.phase === 'uploading') return
    patch(row.value, { phase: 'uploading', note: '正在上传，请稍候…' })
    try {
      const message = await uploadSectionCover(row.value, csrf, card.file)
      patch(row.value, { file: null, committed: card.blob, phase: 'success', note: message })
    } catch (error) {
      patch(row.value, {
        phase: 'error',
        note: error instanceof Error ? error.message : '上传失败，请检查图片或稍后重试。',
      })
    }
  }

  async function move(row: CoverRow, dir: 'up' | 'down') {
    if (moving) return
    setMoving(true)
    setOrderNote('正在调整顺序…')
    try {
      const order = await moveSection(row.value, csrf, dir)
      setRows((prev) => withEnds(reorder(prev, order)))
      setOrderNote('分区顺序已更新')
    } catch (error) {
      setOrderNote(error instanceof Error ? error.message : '调序失败，请稍后重试。')
    } finally {
      setMoving(false)
    }
  }

  return (
    <>
      <p className="hint cover-order-note" role="status" aria-live="polite">{orderNote}</p>
      <div className="cover-grid">
        {rows.map((row) => {
          const card = cardOf(row.value)
          const image = card.blob ?? (card.hash ? adminUrl('/img/' + card.hash) : null)
          const badge = card.phase === 'idle' ? (image ? '已设置' : '待设置') : BADGE[card.phase]
          const noteId = 'cover-note-' + row.value
          return (
            <article
              key={row.value}
              className="cover-cell"
              data-section={row.value}
              data-state={card.phase}
              data-has-cover={image ? 'true' : 'false'}
              aria-label={row.label + '封面管理'}
            >
              <button
                className="cover-preview"
                type="button"
                disabled={card.phase === 'uploading'}
                onClick={() => pickers.current[row.value]?.open()}
                aria-label={'为' + row.label + '选择封面'}
                aria-describedby={noteId}
              >
                {image
                  ? <img data-cover-image src={image} alt={row.label + '当前封面'} />
                  : <span className="cover-placeholder">
                      <img src={adminUrl('/static/art/starcraft/nav-' + row.value + '.webp')} alt="" />
                      <span>暂无封面</span>
                    </span>}
                {image
                  ? <span className="cover-hover" aria-hidden="true">{card.phase === 'ready' ? '待确认 ↗' : '选择新封面 ↗'}</span>
                  : null}
              </button>
              <div className="cover-body">
                <div className="cover-title">
                  <h3>{row.label}</h3>
                  <FilePicker
                    ref={(handle) => { pickers.current[row.value] = handle }}
                    label={row.label + '封面图片'}
                    hideLabel
                    buttonLabel="更换"
                    file={card.file}
                    disabled={card.phase === 'uploading'}
                    onPick={(file) => pick(row, file)}
                  />
                </div>
                <span className="cover-badge" hidden={!badge}>{badge}</span>
                <p className="cover-note" id={noteId} role="status" aria-live="polite" hidden={!card.note}>{card.note}</p>
                <div className="cover-order">
                  <Button
                    type="button" variant="ghost" size="sm" title="上移" aria-label={'把' + row.label + '上移'}
                    disabled={row.first || moving} onClick={() => void move(row, 'up')}
                  >
                    <ArrowIcon dir="up" />
                  </Button>
                  <Button
                    type="button" variant="ghost" size="sm" title="下移" aria-label={'把' + row.label + '下移'}
                    disabled={row.last || moving} onClick={() => void move(row, 'down')}
                  >
                    <ArrowIcon dir="down" />
                  </Button>
                </div>
                {card.phase === 'ready' || card.phase === 'error' ? (
                  <div className="cover-actions">
                    <Button type="button" size="sm" disabled={!card.file} onClick={() => void confirm(row)}>确认更换</Button>
                    <Button type="button" variant="subtle" size="sm" onClick={() => cancel(row)}>取消</Button>
                  </div>
                ) : null}
              </div>
            </article>
          )
        })}
      </div>
    </>
  )
}

/** Heroicons 的箭头（MIT），内联 SVG，靠 aria-label 出可访问名。 */
function ArrowIcon({ dir }: { dir: 'up' | 'down' }) {
  return (
    <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      {dir === 'up'
        ? <path fillRule="evenodd" d="M10 17a.75.75 0 0 1-.75-.75V5.612L5.29 9.77a.75.75 0 0 1-1.08-1.04l5.25-5.5a.75.75 0 0 1 1.08 0l5.25 5.5a.75.75 0 1 1-1.08 1.04L10.75 5.612V16.25A.75.75 0 0 1 10 17Z" clipRule="evenodd" />
        : <path fillRule="evenodd" d="M10 3a.75.75 0 0 1 .75.75v10.638l3.96-4.158a.75.75 0 1 1 1.08 1.04l-5.25 5.5a.75.75 0 0 1-1.08 0l-5.25-5.5a.75.75 0 1 1 1.08-1.04l3.96 4.158V3.75A.75.75 0 0 1 10 3Z" clipRule="evenodd" />}
    </svg>
  )
}
