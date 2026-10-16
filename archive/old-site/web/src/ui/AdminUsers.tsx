import { useEffect, useRef, useState } from 'react'
import {
  adminUrl,
  banUser,
  setSanction,
  setUserActivated,
  setUserGroups,
  setUserRole,
  setUserTrusted,
  updateUser,
  type AclGroup,
  type AclRole,
  type AdminTitle,
  type AdminUserRow,
  type AdminUsersData,
} from '../lib/admin'
import { TitleBadge, UserTitles } from './UserTitles'

export interface AdminUsersProps {
  csrf: string
  data: AdminUsersData
}

const errText = (e: unknown) => (e instanceof Error ? e.message : '请求失败')

const IconEdit = () => (
  <svg viewBox="0 0 16 16" width="15" height="15"><path d="M3 13h3l7-7-3-3-7 7v3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
)
const IconEye = () => (
  <svg viewBox="0 0 16 16" width="15" height="15"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="8" cy="8" r="1.8" fill="currentColor" /></svg>
)
const IconMore = () => (
  <svg viewBox="0 0 16 16" width="15" height="15"><path d="M3 8h10M8 3v10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
)
const IconStar = () => (
  <svg viewBox="0 0 16 16" width="15" height="15"><path d="M8 2l1.8 3.9 4.2.5-3.1 2.9.8 4.2L8 11.6 4.3 13.5l.8-4.2L2 6.4l4.2-.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
)
const IconPower = () => (
  <svg viewBox="0 0 16 16" width="15" height="15"><path d="M8 2v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M4.6 4.4a5 5 0 106.8 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
)
const IconClose = () => (
  <svg viewBox="0 0 16 16" width="15" height="15"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
)

/** 后端把处罚编码成 kind:section:until 分号分隔（见 AdminUserView.sanctions）。 */
function parseSanctions(raw: string): { kind: string; section: string; until: string }[] {
  return raw
    .split(';')
    .filter(Boolean)
    .map((item) => {
      const [kind, section, until] = item.split(':')
      return { kind, section, until }
    })
}

function sanctionLabel(item: { kind: string; section: string; until: string }): string {
  const when = new Date(Number(item.until) * 1000).toISOString().slice(0, 16).replace('T', ' ')
  return (
    (item.kind === 'reply' ? '禁止评论' : '禁止发帖') +
    (item.section ? ' @ ' + item.section : '（全站）') +
    ' 至 ' +
    when +
    ' UTC '
  )
}

/**
 * 用户列表：表格 + 角色菜单（点徽章就地改等级）+ 编辑弹窗（资料 / 处罚 / 禁言 / 用户组）。
 * 所有动作都是 JSON/表单 POST，不刷新页面；失败显示在面板顶部或弹窗里，不静默。
 */
export function AdminUsers({ csrf, data }: AdminUsersProps) {
  const [users, setUsers] = useState(data.users)
  const [editing, setEditing] = useState<AdminUserRow | null>(null)
  const [openRole, setOpenRole] = useState<number | null>(null)
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // 预览脚本读它做断言（只读、无副作用；见 scripts/preview.mjs 的 --title-test）
  ;(window as unknown as { __adminUsersProbe?: () => string }).__adminUsersProbe = () =>
    JSON.stringify({ titleIds: users.find((u) => u.id === editing?.id)?.titleIds ?? [] })

  const patch = (id: number, next: Partial<AdminUserRow>) =>
    setUsers((prev) => prev.map((row) => (row.id === id ? { ...row, ...next } : row)))

  async function run(id: number, action: () => Promise<string>) {
    setError('')
    setNotice('')
    setBusy(id)
    try {
      setNotice(await action())
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(0)
    }
  }

  const roleLabel = (value: string) => data.roles.find((role) => role.value === value)?.label ?? value

  const changeRole = (row: AdminUserRow, role: string) => {
    setOpenRole(null)
    if (role === row.role) return
    void run(row.id, async () => {
      const message = await setUserRole(row.id, csrf, role)
      patch(row.id, { role, roleLabel: roleLabel(role) })
      return message
    })
  }

  return (
    <>
      {error && <p className="alert" role="alert">{error}</p>}
      {notice && <p className="hint" role="status">{notice}</p>}
      {users.length === 0 ? (
        <p className="empty">没有匹配的用户。</p>
      ) : (
        <div className="table-wrap">
          <table className="admin-table users">
            <thead>
              <tr><th>名称</th><th>角色</th><th>电子邮箱</th><th>最后在线时间</th><th>创建于</th><th></th></tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td className="name-cell">
                    <span className="name-wrap">
                      {user.avatar
                        ? <img className="avatar avatar-sm" src={adminUrl(`/avatar/${user.avatar}`)} alt="" width={28} height={28} loading="lazy" />
                        : <span className={`avatar-initial c${user.colorIndex}`} aria-hidden="true">{user.initial}</span>}
                      <span className="user-name" title={user.displayName}>{user.displayName}</span>
                      {user.activated
                        ? <span className="tag ok" title="可以登录、发帖与上传">已激活</span>
                        : <span className="tag warn" title="未激活：不能发帖与上传，需要管理员激活">未激活</span>}
                      {user.online && <span className="dot on" title="最近 5 分钟有活动" />}
                      {user.trusted && <span className="tag ok" title="发帖只走自动审核">信任</span>}
                      {user.banLabel && <span className="tag ban">{user.banLabel}</span>}
                      {user.isSelf && <span className="tag">我</span>}
                      {user.titleIds.map((id) => {
                        const title = data.titles.find((item) => item.id === id)
                        return title ? <TitleBadge key={id} title={title} held /> : null
                      })}
                    </span>
                  </td>
                  <td className="role-cell">
                    <details
                      className="role-menu"
                      open={openRole === user.id}
                      onToggle={(event) => setOpenRole(event.currentTarget.open ? user.id : null)}
                    >
                      <summary className={`role-badge role-${user.role}`}>{user.roleLabel}</summary>
                      <div className="role-menu-panel">
                        {data.roles.map((role) => (
                          <button
                            key={role.value}
                            type="button"
                            disabled={busy === user.id}
                            className={`role-option${role.value === user.role ? ' active' : ''}`}
                            onClick={() => changeRole(user, role.value)}
                          >{role.label}</button>
                        ))}
                      </div>
                    </details>
                  </td>
                  <td className="muted email-cell">{user.email}</td>
                  <td className="muted">{user.lastSeen}</td>
                  <td className="muted">{user.createdAt}</td>
                  <td className="row-actions">
                    <button className="icon-btn" type="button" title="编辑用户" onClick={() => setEditing(user)}><IconEdit /></button>
                    <button className="icon-btn" type="button" title="设置用户组" aria-label="设置用户组" onClick={() => setEditing(user)}>组</button>
                    <a className="icon-btn" href={adminUrl(`/u/${user.handle}`)} title="查看主页" aria-label="查看主页"><IconEye /></a>
                    <a className="icon-btn" href={adminUrl(`/admin/users/${user.id}`)} title="更多设置" aria-label="更多设置"><IconMore /></a>
                    <button
                      className={`icon-btn ${user.trusted ? 'danger' : 'ok'}`}
                      type="button"
                      disabled={busy === user.id}
                      title={user.trusted ? '取消信任（红色＝撤销）' : '设为信任（绿色＝授予）'}
                      onClick={() => void run(user.id, async () => {
                        const message = await setUserTrusted(user.id, csrf, !user.trusted)
                        patch(user.id, { trusted: !user.trusted })
                        return message
                      })}
                    ><IconStar /></button>
                    {!user.isSelf && (
                      <button
                        className={`icon-btn ${user.activated ? 'danger' : 'ok'}`}
                        type="button"
                        disabled={busy === user.id}
                        title={user.activated ? '停用账号（危险操作，按钮为红色）' : '激活账号'}
                        onClick={() => void run(user.id, async () => {
                          const message = await setUserActivated(user.id, csrf, !user.activated)
                          patch(user.id, { activated: !user.activated })
                          return message
                        })}
                      ><IconPower /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <UserDialog
          key={editing.id}
          csrf={csrf}
          user={editing}
          titles={data.titles}
          roles={data.roles}
          groups={data.groups}
          sections={data.sections}
          banOptions={data.banOptions}
          onClose={() => setEditing(null)}
          onSaved={(message, next, warning) => {
            patch(editing.id, next)
            setEditing(null)
            setError(warning)
            setNotice(warning ? '' : message)
          }}
        />
      )}
    </>
  )
}

interface UserDialogProps {
  csrf: string
  user: AdminUserRow
  titles: AdminTitle[]
  roles: AclRole[]
  groups: AclGroup[]
  sections: { value: string; label: string }[]
  banOptions: AclRole[]
  onClose: () => void
  /** 保存成功；warning 非空表示资料已存但禁言/用户组那两份请求失败了 */
  onSaved: (message: string, next: Partial<AdminUserRow>, warning: string) => void
}

/** 编辑用户弹窗（原生 <dialog>：焦点陷阱/ESC 由浏览器负责）。 */
function UserDialog({ csrf, user, titles, roles, groups, sections, banOptions, onClose, onSaved }: UserDialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const [role, setRole] = useState(user.role)
  const [displayName, setDisplayName] = useState(user.displayName)
  const [quota, setQuota] = useState(user.quotaGb)
  const [trusted, setTrusted] = useState(user.trusted)
  const [activated, setActivated] = useState(user.activated)
  const [password, setPassword] = useState('')
  const [hours, setHours] = useState('0')
  const [picked, setPicked] = useState(user.groups)
  const [sanctions, setSanctions] = useState(() => parseSanctions(user.sanctions))
  const [titleIds, setTitleIds] = useState(user.titleIds)
  const [kind, setKind] = useState('post')
  const [section, setSection] = useState('')
  const [until, setUntil] = useState('')
  const [sanctionNote, setSanctionNote] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    ref.current?.showModal()
  }, [])

  const toggleGroup = (id: number) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  async function save() {
    setSaving(true)
    setError('')
    try {
      const message = await updateUser(user.id, {
        csrf,
        role,
        displayName,
        quotaGb: quota,
        trusted,
        activated: user.isSelf || activated,
        newPassword: password,
      })
      // 禁言与用户组老实现里与保存并发发出：任一失败都要看得见
      const extra = await Promise.allSettled([
        setUserGroups(user.id, csrf, picked),
        banUser(user.id, csrf, hours),
      ])
      const failed = extra.find((result) => result.status === 'rejected')
      onSaved(
        message,
        {
          role,
          roleLabel: roles.find((item) => item.value === role)?.label ?? role,
          displayName,
          trusted,
          activated: user.isSelf || activated,
          titleIds,
        },
        failed?.status === 'rejected' ? `资料已保存，但${errText(failed.reason)}` : '',
      )
    } catch (e) {
      setError(errText(e))
      setSaving(false)
    }
  }

  async function applySanction(nextKind: string, nextSection: string, nextUntil: string) {
    setSanctionNote('')
    try {
      const message = await setSanction(user.id, csrf, { kind: nextKind, section: nextSection, until: nextUntil })
      setSanctionNote(message)
      if (!nextUntil.trim()) {
        setSanctions((prev) => prev.filter((item) => !(item.kind === nextKind && item.section === nextSection)))
      }
    } catch (e) {
      setSanctionNote(errText(e))
    }
  }

  return (
    <dialog className="modal" ref={ref} onClose={onClose}>
      <form className="modal-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
        <header className="modal-head">
          <div className="modal-who">
            {user.avatar
              ? <img className="avatar avatar-xl" src={adminUrl(`/avatar/${user.avatar}`)} alt="" width={64} height={64} />
              : <span className={`avatar-initial avatar-lg c${user.colorIndex}`} aria-hidden="true">{user.initial}</span>}
            <div>
              <strong>{user.displayName}</strong>
              <div className="meta"><span>@{user.handle}</span></div>
            </div>
          </div>
          <button className="icon-btn" type="button" aria-label="关闭" onClick={onClose}><IconClose /></button>
        </header>
        <div className="modal-body">
          <label>角色
            <select value={role} onChange={(event) => setRole(event.target.value)}>
              {roles.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
          </label>
          <label>显示名<input type="text" value={displayName} maxLength={20} onChange={(event) => setDisplayName(event.target.value)} /></label>
          <label>电子邮箱<input type="text" value={user.email} disabled /></label>
          <label>磁盘预算（GB）<input type="number" value={quota} min={0} max={10240} step={0.5} onChange={(event) => setQuota(event.target.value)} /></label>
          <label className="check"><input type="checkbox" checked={trusted} onChange={(event) => setTrusted(event.target.checked)} /> 信任（发帖只走自动审核）</label>
          <label className="check"><input type="checkbox" checked={activated} onChange={(event) => setActivated(event.target.checked)} /> 账号已激活</label>
          <label>新密码（留空表示不改）<input type="password" value={password} minLength={8} placeholder="至少 8 位" onChange={(event) => setPassword(event.target.value)} /></label>
          <p className="hint">{user.isSelf ? '这是你自己的账号：不能改自己的等级，也不能停用。' : ''}</p>
        </div>
        <footer className="modal-foot">
          <a className="btn ghost sm" href={adminUrl(`/admin/users/${user.id}`)}>更多设置</a>
          <button className="btn sm" type="submit" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </footer>
        <fieldset className="modal-sanctions">
          <legend>处罚（禁止发帖 / 禁止评论，可限定分区）</legend>
          <p className="hint">
            {sanctions.length === 0 ? '当前没有处罚' : sanctions.map((item) => (
              <span className="sanction-row" key={`${item.kind}:${item.section}`}>
                {sanctionLabel(item)}
                <button className="btn ghost sm" type="button" onClick={() => void applySanction(item.kind, item.section, '')}>解除</button>
              </span>
            ))}
          </p>
          <div className="sanction-add">
            <select value={kind} onChange={(event) => setKind(event.target.value)}>
              <option value="post">禁止发帖</option>
              <option value="reply">禁止评论</option>
            </select>
            <select value={section} onChange={(event) => setSection(event.target.value)}>
              <option value="">全站</option>
              {sections.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <input type="text" value={until} maxLength={32} placeholder="到期：3d / 12h / 2026-10-20 12:00" onChange={(event) => setUntil(event.target.value)} />
            <button className="btn sm" type="button" onClick={() => void applySanction(kind, section, until)}>设置</button>
          </div>
          <p className="hint" role="status">{sanctionNote}</p>
        </fieldset>
        <label>禁言（限期禁止发帖）
          <select value={hours} onChange={(event) => setHours(event.target.value)}>
            {banOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <fieldset className="modal-titles">
          <legend>头衔（发放 / 收回，改完立即生效）</legend>
          <UserTitles
            userId={user.id}
            csrf={csrf}
            initialHeld={titleIds}
            catalog={titles}
            titleIds={titleIds}
            onChanged={setTitleIds}
          />
        </fieldset>
        <fieldset className="modal-groups">
          <legend>用户组（可多选）</legend>
          {groups.length === 0 && <p className="hint">还没有用户组</p>}
          {groups.map((group) => (
            <label key={group.id}>
              <input type="checkbox" checked={picked.includes(group.id)} onChange={() => toggleGroup(group.id)} /> {group.name}
            </label>
          ))}
        </fieldset>
        {error && <p className="alert" role="alert">{error}</p>}
      </form>
    </dialog>
  )
}