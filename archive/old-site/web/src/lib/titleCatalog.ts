import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createTitle,
  fetchTitleCatalog,
  setTitleArchived,
  updateTitle,
  type AdminTitleRow,
} from './admin'

export interface TitleDraft {
  key: string
  name: string
  color: string
  description: string
}

export const EMPTY_DRAFT: TitleDraft = { key: '', name: '', color: '#2563eb', description: '' }

export interface TitleCatalogState {
  titles: AdminTitleRow[]
  loading: boolean
  /** 正在提交的头衔 id；新建时用 creating 单独表示。 */
  pendingId: number
  creating: boolean
  error: string
  notice: string
  create: (draft: TitleDraft) => Promise<boolean>
  save: (id: number, draft: TitleDraft) => Promise<boolean>
  archive: (title: AdminTitleRow, archived: boolean) => void
}

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

/**
 * 头衔目录的数据层：列表 + 三个写操作（新建 / 改名·配色·描述 / 归档）。
 *
 * 写操作成功后再拉一次整表：目录是低频数据、条数少，拿服务端权威的一份
 * （顺带刷新持有者数）比在前端猜合并结果可靠。
 */
export function useTitleCatalog(csrf: string, initial: AdminTitleRow[]): TitleCatalogState {
  const [titles, setTitles] = useState(initial)
  const [loading, setLoading] = useState(false)
  const [pendingId, setPendingId] = useState(0)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const run = useCallback(
    async (action: () => Promise<string>, mark: () => void, clear: () => void) => {
      setError('')
      setNotice('')
      mark()
      setLoading(true)
      try {
        await action()
        const data = await fetchTitleCatalog()
        if (!alive.current) return false
        setTitles(data.titles)
        setNotice(data.message ?? '已保存')
        return true
      } catch (e) {
        if (alive.current) setError(message(e, '操作失败'))
        return false
      } finally {
        if (alive.current) setLoading(false)
        clear()
      }
    },
    [],
  )

  return {
    titles,
    loading,
    pendingId,
    creating,
    error,
    notice,
    create: (draft) =>
      run(
        () => createTitle(csrf, draft),
        () => setCreating(true),
        () => alive.current && setCreating(false),
      ),
    save: (id, draft) =>
      run(
        () => updateTitle(id, csrf, draft),
        () => setPendingId(id),
        () => alive.current && setPendingId(0),
      ),
    archive: (title, archived) => {
      void run(
        () => setTitleArchived(title.id, csrf, archived),
        () => setPendingId(title.id),
        () => alive.current && setPendingId(0),
      )
    },
  }
}
