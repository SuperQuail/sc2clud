import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchUserTitles, setUserTitle, type AdminTitle } from './admin'

type Action = 'grant' | 'revoke'

export interface UserTitlesState {
  /** 目录（初始来自面板下发，打开后再与服务端对齐一次）。 */
  titles: AdminTitle[]
  held: number[]
  loading: boolean
  /** 正在请求的头衔 id（按行禁用，避免同一行重复点）。 */
  pendingId: number
  error: string
  notice: string
  grant: (title: AdminTitle) => void
  revoke: (title: AdminTitle) => void
}

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

/**
 * 头衔区的数据层：持有集合的读写 + 乐观更新。
 *
 * 乐观更新：先改界面再发请求，失败回滚并显示错误——按钮点下去是即时的，
 * 但错误绝不静默（管理端一次误操作就是发错头衔）。
 */
export function useUserTitles(userId: number, csrf: string, initialHeld: number[], catalog: AdminTitle[]): UserTitlesState {
  const [titles, setTitles] = useState(catalog)
  const [held, setHeld] = useState(initialHeld)
  const [loading, setLoading] = useState(true)
  const [pendingId, setPendingId] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    fetchUserTitles(userId)
      .then((data) => {
        if (!alive.current) return
        setHeld(data.held)
        if (data.titles.length > 0) setTitles(data.titles)
      })
      .catch((e: unknown) => alive.current && setError(message(e, '加载头衔失败')))
      .finally(() => alive.current && setLoading(false))
    return () => {
      alive.current = false
    }
  }, [userId])

  const mutate = useCallback(
    async (title: AdminTitle, action: Action) => {
      setError('')
      setNotice('')
      setPendingId(title.id)
      const before = held
      const next = action === 'grant' ? [...held, title.id] : held.filter((id) => id !== title.id)
      setHeld(next)
      try {
        const data = await setUserTitle(userId, csrf, title.id, action)
        if (!alive.current) return
        setHeld(data.held)
        setNotice(data.message)
      } catch (e) {
        if (!alive.current) return
        setHeld(before) // 回滚：界面不能显示成已发放
        setError(message(e, '操作失败'))
      } finally {
        if (alive.current) setPendingId(0)
      }
    },
    [csrf, held, userId],
  )

  return {
    titles,
    held,
    loading,
    pendingId,
    error,
    notice,
    grant: (title) => void mutate(title, 'grant'),
    revoke: (title) => void mutate(title, 'revoke'),
  }
}
