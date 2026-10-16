import { useMemo, useState, type CSSProperties } from 'react'
import { Button } from './Button'
import { Input } from './Input'
import { TitleBadge } from './UserTitles'
import { EMPTY_DRAFT, useTitleCatalog, type TitleDraft } from '../lib/titleCatalog'
import type { AdminTitleRow } from '../lib/admin'
import './admin-titles.css'

export interface TitleAdminProps {
  csrf: string
  data: { titles: AdminTitleRow[] }
}

const ordered = (rows: AdminTitleRow[]) => [...rows].sort((a, b) => Number(a.archived) - Number(b.archived) || a.id - b.id)

/** 管理面板「头衔管理」：目录的增改与归档（发放/收回在用户编辑弹窗里）。 */
export function TitleAdmin({ csrf, data }: TitleAdminProps) {
  const state = useTitleCatalog(csrf, data.titles)
  const [draft, setDraft] = useState<TitleDraft>(EMPTY_DRAFT)
  const [editing, setEditing] = useState<number | null>(null)
  const [edit, setEdit] = useState<TitleDraft>(EMPTY_DRAFT)

  const rows = useMemo(() => ordered(state.titles), [state.titles])
  const busy = state.creating || state.pendingId !== 0

  async function submitCreate() {
    if (!draft.key.trim() || !draft.name.trim()) return
    if (await state.create(draft)) setDraft(EMPTY_DRAFT)
  }

  async function submitEdit(id: number) {
    if (!edit.name.trim()) return
    if (await state.save(id, edit)) setEditing(null)
  }

  return (
    <div className="title-admin">
      <form
        className="title-create"
        onSubmit={(event) => {
          event.preventDefault()
          void submitCreate()
        }}
      >
        <span className="title-create-title">新建头衔</span>
        <label>
          标识
          <Input
            value={draft.key}
            placeholder="localization"
            maxLength={32}
            required
            onChange={(event) => setDraft({ ...draft, key: event.target.value })}
          />
        </label>
        <label>
          名称
          <Input value={draft.name} placeholder="汉化组" maxLength={20} required onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
        </label>
        <label className="title-color-field">
          配色
          <span className="title-color-row">
            <input
              type="color"
              aria-label="选择配色"
              value={/^#[0-9a-f]{6}$/i.test(draft.color) ? draft.color : '#2563eb'}
              onChange={(event) => setDraft({ ...draft, color: event.target.value })}
            />
            <Input value={draft.color} maxLength={32} placeholder="#f97316" onChange={(event) => setDraft({ ...draft, color: event.target.value })} />
          </span>
        </label>
        <label className="title-desc-field">
          描述
          <Input value={draft.description} maxLength={60} placeholder="发给谁、什么条件（可空）" onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
        </label>
        <span className="title-preview">
          预览
          <TitleBadge title={{ id: 0, name: draft.name || '头衔', color: draft.color, description: draft.description, archived: false }} held />
        </span>
        <Button type="submit" size="sm" loading={state.creating} disabled={busy || !draft.key.trim() || !draft.name.trim()}>
          新建
        </Button>
      </form>

      <p className="title-catalog-note" role="status" aria-live="polite">
        {state.notice || (state.loading ? '正在同步…' : `共 ${state.titles.length} 个头衔`)}
      </p>
      {state.error ? <p className="alert" role="alert">{state.error}</p> : null}

      {rows.length === 0 ? (
        <p className="empty">还没有头衔：先用上面的表单建一个。</p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table titles">
            <thead>
              <tr>
                <th>头衔</th>
                <th>标识</th>
                <th>描述</th>
                <th>持有者</th>
                <th>状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((title) =>
                editing === title.id ? (
                  <tr key={title.id} className="title-edit-row">
                    <td colSpan={6}>
                      <div className="title-edit">
                        <Input value={edit.name} maxLength={20} aria-label="名称" onChange={(event) => setEdit({ ...edit, name: event.target.value })} />
                        <span className="title-color-row">
                          <input
                            type="color"
                            aria-label="选择配色"
                            value={/^#[0-9a-f]{6}$/i.test(edit.color) ? edit.color : '#2563eb'}
                            onChange={(event) => setEdit({ ...edit, color: event.target.value })}
                          />
                          <Input value={edit.color} maxLength={32} aria-label="配色" onChange={(event) => setEdit({ ...edit, color: event.target.value })} />
                        </span>
                        <Input value={edit.description} maxLength={60} aria-label="描述" placeholder="描述（可空）" onChange={(event) => setEdit({ ...edit, description: event.target.value })} />
                        <span className="title-actions">
                          <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>取消</Button>
                          <Button size="sm" loading={state.pendingId === title.id} onClick={() => void submitEdit(title.id)}>保存</Button>
                        </span>
                      </div>
                    </td>
                  </tr>
                ) : (
                  <tr key={title.id} className={title.archived ? 'is-archived' : undefined}>
                    <td>
                      <TitleBadge title={title} held={!title.archived} />
                    </td>
                    <td className="muted"><code>{title.key}</code></td>
                    <td className="muted title-catalog-desc">{title.description}</td>
                    <td className="muted">{title.holders}</td>
                    <td>{title.archived ? <span className="tag gray">已归档</span> : <span className="tag ok">可发放</span>}</td>
                    <td className="row-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy || title.archived}
                        title={title.archived ? '已归档：先取消归档再改' : '改名 / 换配色 / 改描述'}
                        onClick={() => {
                          setEditing(title.id)
                          setEdit({ key: title.key, name: title.name, color: title.color, description: title.description })
                        }}
                      >
                        编辑
                      </Button>
                      <Button
                        size="sm"
                        variant={title.archived ? 'subtle' : 'ghost'}
                        loading={state.pendingId === title.id}
                        disabled={busy && state.pendingId !== title.id}
                        onClick={() => state.archive(title, !title.archived)}
                      >
                        {title.archived ? '取消归档' : '归档'}
                      </Button>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">
        归档只影响「以后还能不能发」：已持有的用户仍会保留，必要时在用户弹窗里逐个收回。
      </p>
    </div>
  )
}
