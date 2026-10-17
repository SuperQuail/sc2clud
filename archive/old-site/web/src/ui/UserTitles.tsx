import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Button } from './Button'
import { useUserTitles } from '../lib/titles'
import type { AdminTitle } from '../lib/admin'
import './admin-titles.css'

/** 一枚头衔徽章：颜色走 --tc，与个人主页/帖子上的头衔同一种视觉语言。 */
export function TitleBadge({ title, held }: { title: AdminTitle; held: boolean }) {
  return (
    <span className={`title-chip${held ? ' is-held' : ''}`} style={{ '--tc': title.color || '#2563eb' } as CSSProperties}>
      <span className="title-chip-dot" aria-hidden="true" />
      <span className="title-chip-name">{title.name}</span>
      {title.archived ? <span className="title-chip-flag">已归档</span> : null}
    </span>
  )
}

type Filter = 'all' | 'held' | 'free'

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'held', label: '已持有' },
  { value: 'free', label: '可发放' },
]

export interface UserTitlesProps {
  userId: number
  csrf: string
  /** 列表里已持有的头衔 id（打开弹窗时的初值）。 */
  initialHeld: number[]
  /** 目录（面板下发；打开后再与服务端对齐一次）。 */
  catalog: AdminTitle[]
  /** 发放/收回成功后回调，父组件据此更新列表行。 */
  onChanged: (held: number[]) => void
  /** 当前持有集合（父组件持有，作为唯一事实来源）。 */
  titleIds: number[]
}

/** 管理弹窗里的「头衔」区：发放 / 收回，改完就地更新（不整页刷新）。 */
export function UserTitles(props: UserTitlesProps) {
  const { userId, csrf, initialHeld, catalog, titleIds, onChanged } = props
  const state = useUserTitles(userId, csrf, initialHeld, catalog)
  const [filter, setFilter] = useState<Filter>('all')
  const heldSet = useMemo(() => new Set(state.held), [state.held])
  const rows = useMemo(
    () =>
      state.titles.filter((title) =>
        filter === 'all' ? true : filter === 'held' ? heldSet.has(title.id) : !heldSet.has(title.id),
      ),
    [filter, heldSet, state.titles],
  )


  // 单向数据流：持有集合由父组件持有，这里只在集合真的变了之后回报一次
  useEffect(() => {
    if (state.held.join(',') !== titleIds.join(',')) onChanged(state.held)
  }, [state.held, titleIds, onChanged])

  if (state.loading) return <p className="hint">正在加载头衔…</p>
  if (state.titles.length === 0) return <p className="hint">还没有可发放的头衔（先在头衔表里建）。</p>

  return (
    <div className="title-panel">
      <div className="title-filters" role="tablist" aria-label="头衔筛选">
        {FILTERS.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={filter === item.value}
            className={`title-filter${filter === item.value ? ' is-on' : ''}`}
            onClick={() => setFilter(item.value)}
          >
            {item.label}
          </button>
        ))}
        <span className="title-count">{state.held.length} / {state.titles.length}</span>
      </div>
      {rows.length === 0 ? <p className="hint">这个筛选下没有头衔。</p> : null}
      <div className="title-grid">
        {rows.map((title) => {
          const owned = heldSet.has(title.id)
          const busy = state.pendingId === title.id
          return (
            <div key={title.id} className={`title-row${owned ? ' is-held' : ''}`}>
              <TitleBadge title={title} held={owned} />
              {title.description ? <span className="title-desc">{title.description}</span> : null}
              <span className="title-actions">
                {owned ? (
                  <Button size="sm" variant="ghost" loading={busy} disabled={state.pendingId !== 0} onClick={() => state.revoke(title)}>
                    收回
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={title.archived || state.pendingId !== 0}
                    loading={busy}
                    title={title.archived ? '已归档的头衔不能再发放' : `发放「${title.name}」`}
                    onClick={() => state.grant(title)}
                  >
                    发放
                  </Button>
                )}
              </span>
            </div>
          )
        })}
      </div>
      <p className="hint" role="status" aria-live="polite">{state.notice}</p>
      {state.error ? <p className="alert" role="alert">{state.error}</p> : null}
    </div>
  )
}