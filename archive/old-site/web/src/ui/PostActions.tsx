import { useEffect, useRef, useState } from 'react'
import { appUrl } from '../lib/paths'
import { submitAsyncForm, toggleBookmark, toggleLike } from '../lib/post'

export interface PostActionsProps {
  postId: number
  /** 点赞端点（模板给字面量，不在前端拼路径） */
  likeAction: string
  /** 收藏端点 */
  bookmarkAction: string
  csrf: string
  likeCount: number
  liked: boolean
  bookmarked: boolean
  /** 作者本人或管理员：显示「编辑帖子」。与模板里 post.can_edit 同一个判据 */
  canEdit: boolean
  /** 管理员及以上：显示审核动作 */
  isStaff: boolean
  /** 审核状态（approved / pending / rejected…）与显示名 */
  state: string
  stateLabel: string
  archived: boolean
  /** 「⋯」菜单版式（1 紧凑 / 2 分组 / 3 说明卡），由服务端 ui_variant 决定 */
  uiVariant: number
}

/**
 * 帖子页动作区：点赞 / 收藏就地切换（不刷新），右上角「⋯」菜单开合 + 菜单里的审核动作。
 *
 * 菜单的 DOM 由 React 渲染（原先在 templates/post_actions.html）：面板必须活在岛里面，
 * 服务端渲染的那份放在挂载点里会被 React 首次提交清掉（踩过一次，菜单就此消失）。
 * 开合状态交给面板自己的 hidden 属性，React 只管点赞/收藏那两个可变值。
 */
export function PostActions(props: PostActionsProps) {
  const [liked, setLiked] = useState(props.liked)
  const [count, setCount] = useState(props.likeCount)
  const [marked, setMarked] = useState(props.bookmarked)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(new URLSearchParams(location.search).get('menu') === '1')
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onOutside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('click', onOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('click', onOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  /**
   * 菜单里的审核动作（form[data-async]）：拦下原生提交走 fetch，成功后整页重载
   * （审核状态一变，页面上的文案得跟着变）。React 会换掉这些 form 节点，
   * 所以每次重渲染后重新绑——先解绑旧的就不怕重复提交。
   */
  const bound = useRef<HTMLFormElement[]>([])
  useEffect(() => {
    for (const form of bound.current) form.removeEventListener('submit', onSubmit)
    const forms = [...(menu.current?.querySelectorAll<HTMLFormElement>('form[data-async]') ?? [])]
    function onSubmit(event: SubmitEvent) {
      event.preventDefault()
      setOpen(false)
      setError('')
      void submitAsyncForm(event.currentTarget as HTMLFormElement)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : '操作失败'))
    }
    for (const form of forms) form.addEventListener('submit', onSubmit)
    bound.current = forms
  })

  async function onLike() {
    setError('')
    try {
      const data = await toggleLike(props.likeAction, props.csrf)
      setLiked(Boolean(data.liked))
      if (typeof data.count === 'number') setCount(data.count)
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    }
  }

  async function onMark() {
    setError('')
    try {
      setMarked(Boolean((await toggleBookmark(props.bookmarkAction, props.csrf)).bookmarked))
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    }
  }

  const { postId, csrf, canEdit, isStaff, state, stateLabel, archived } = props
  const admin = (action: string, tone: string, label: string) => (
    <form method="post" action={`/admin/posts/${postId}/${action}`} data-async data-after="refresh">
      <input type="hidden" name="csrf" value={csrf} />
      <button className={`pa-item${tone ? ' ' + tone : ''}`} type="submit">{label}</button>
    </form>
  )
  const adminCard = (action: string, tone: string, title: string, hint: string) => (
    <form method="post" action={`/admin/posts/${postId}/${action}`} data-async data-after="refresh">
      <input type="hidden" name="csrf" value={csrf} />
      <button className={`pa-card ${tone}`} type="submit"><b>{title}</b><span>{hint}</span></button>
    </form>
  )
  const revision = (cls: string) => (
    <form method="post" action={`/admin/posts/${postId}/revision`} data-async data-after="refresh">
      <input type="hidden" name="csrf" value={csrf} />
      <button className={cls} type="submit">打回修改</button>
      <input className="pa-input" type="text" name="note" placeholder="修改意见" maxLength={80} />
    </form>
  )
  const archive = (cls: string) =>
    archived
      ? <form method="post" action={`/admin/posts/${postId}/unarchive`} data-async data-after="refresh"><input type="hidden" name="csrf" value={csrf} /><button className={`${cls} ok`} type="submit">取消归档</button></form>
      : <form method="post" action={`/admin/posts/${postId}/archive`} data-async data-after="refresh"><input type="hidden" name="csrf" value={csrf} /><button className={`${cls} danger`} type="submit">归档</button></form>

  return (
    <>
      <button className={`btn ${liked ? 'liked' : 'ghost'}`} type="button" onClick={() => void onLike()}>
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
          <path d="M6 9.4l3.6-6.2c.6-1 2.2-.6 2.2.6v4h3.1c1.1 0 1.9 1 1.7 2.1l-1 5c-.2.9-.9 1.5-1.7 1.5H6z" />
          <path d="M6 9.4H3v8h3z" />
        </svg>
        <span>{count}</span>
      </button>
      <button className={`btn ${marked ? 'marked' : 'ghost'}`} type="button" onClick={() => void onMark()}>
        <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
          <path d="M5.5 3h9v14l-4.5-3.4L5.5 17z" />
        </svg>
        <span>{marked ? '已收藏' : '收藏'}</span>
      </button>
      <span className="hint">{error}</span>
      {(canEdit || isStaff) && (
        <div className="post-menu" ref={menu}>
          <button type="button" className="post-menu-btn" aria-haspopup="true" aria-expanded={open} aria-label="更多操作" title="更多操作" onClick={() => setOpen(!open)}>
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" fill="currentColor"><circle cx="10" cy="4" r="1.7" /><circle cx="10" cy="10" r="1.7" /><circle cx="10" cy="16" r="1.7" /></svg>
          </button>
          <div className={`post-menu-panel variant-${props.uiVariant}`} hidden={!open}>
            {props.uiVariant === 1 && (
              <>
                {canEdit && <a className="pa-item" href={appUrl(`/p/${postId}/edit`)}>编辑帖子</a>}
                {isStaff && state !== 'approved' && admin('approve', 'ok', '通过审核')}
                {isStaff && revision('pa-item')}
                {isStaff && state !== 'approved' && admin('reject', 'danger', '拒绝')}
                {isStaff && archive('pa-item')}
              </>
            )}
            {props.uiVariant === 2 && (
              <>
                {canEdit && <p className="pa-group">内容</p>}
                {canEdit && <a className="pa-item" href={appUrl(`/p/${postId}/edit`)}>编辑帖子</a>}
                {isStaff && (
                  <>
                    <p className="pa-group">审核</p>
                    <p className="pa-status">当前状态：{stateLabel}{archived ? '（已归档）' : ''}</p>
                    {state !== 'approved' && admin('approve', 'ok', '通过审核')}
                    {revision('pa-item')}
                    {state !== 'approved' && admin('reject', 'danger', '拒绝')}
                    {archive('pa-item')}
                  </>
                )}
              </>
            )}
            {props.uiVariant === 3 && (
              <div className="pa-grid">
                {canEdit && <a className="pa-card" href={appUrl(`/p/${postId}/edit`)}><b>编辑帖子</b><span>改标题、正文、下载来源</span></a>}
                {isStaff && (
                  <>
                    {state !== 'approved' && adminCard('approve', 'ok', '通过审核', '立即对所有人可见')}
                    {revision('pa-card')}
                    {state !== 'approved' && adminCard('reject', 'danger', '拒绝', '作者与管理员可见')}
                    {archived
                      ? adminCard('unarchive', 'ok', '取消归档', '回到列表可见')
                      : adminCard('archive', 'danger', '归档', '列表不再展示')}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}