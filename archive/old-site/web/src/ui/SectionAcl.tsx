import { useState } from 'react'
import { saveSectionAcl, type AclData, type AclRow } from '../lib/admin'

export interface SectionAclProps {
  csrf: string
  data: AclData
}

type Status = 'idle' | 'saving' | 'saved' | 'error'

/**
 * 分区发言权限：角色门槛（可发言 / 可评论）+ 用户组检查档位 + 允许的用户组（chips）。
 * 保存是 JSON 提交，不刷新页面；失败会把错误显示在行内（不静默）。
 */
export function SectionAcl({ csrf, data }: SectionAclProps) {
  const [rows, setRows] = useState<AclRow[]>(data.sections)
  const [status, setStatus] = useState<Record<string, Status>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})

  const patch = (value: string, next: Partial<AclRow>) =>
    setRows((prev) => prev.map((row) => (row.value === value ? { ...row, ...next } : row)))

  const toggleGroup = (row: AclRow, id: number) =>
    patch(row.value, {
      groupIds: row.groupIds.includes(id) ? row.groupIds.filter((x) => x !== id) : [...row.groupIds, id],
    })

  async function save(row: AclRow) {
    setStatus((prev) => ({ ...prev, [row.value]: 'saving' }))
    setErrors((prev) => ({ ...prev, [row.value]: '' }))
    try {
      await saveSectionAcl(row.value, {
        csrf,
        post: row.post,
        reply: row.reply,
        mode: row.mode,
        groupIds: row.groupIds,
      })
      setStatus((prev) => ({ ...prev, [row.value]: 'saved' }))
    } catch (e) {
      setStatus((prev) => ({ ...prev, [row.value]: 'error' }))
      setErrors((prev) => ({ ...prev, [row.value]: e instanceof Error ? e.message : '保存失败' }))
    }
  }

  const roleSelect = (row: AclRow, field: 'post' | 'reply', label: string) => (
    <select
      className="ui-select"
      aria-label={`${row.label} ${label}`}
      value={row[field]}
      onChange={(e) => patch(row.value, { [field]: e.target.value } as Partial<AclRow>)}
    >
      {data.roles.map((role) => (
        <option key={role.value} value={role.value}>{role.label}</option>
      ))}
    </select>
  )

  return (
    <>
      <p className="hint">
        角色门槛＝「至少哪个等级能在该分区发言 / 评论」；用户组规则是额外的白名单（禁止项优先于一切）。
        改完点该行右侧的「保存」立即生效（不刷新页面）；管理员及以上始终无视用户组。
      </p>
      <table className="acl-matrix">
        <thead>
          <tr><th>分区</th><th>可发言</th><th>可评论</th><th>用户组检查</th><th>允许的用户组</th><th></th></tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.value}>
              <th scope="row">{row.label}</th>
              <td>{roleSelect(row, 'post', '可发言')}</td>
              <td>{roleSelect(row, 'reply', '可评论')}</td>
              <td>
                <select
                  className="ui-select"
                  aria-label={`${row.label} 用户组检查`}
                  value={String(row.mode)}
                  onChange={(e) => patch(row.value, { mode: Number(e.target.value) })}
                >
                  <option value="0">不启用</option>
                  <option value="1">白名单</option>
                  <option value="2">黑名单</option>
                </select>
              </td>
              <td className="acl-chips">
                {data.groups.length === 0 && <span className="hint">还没有用户组</span>}
                {data.groups.map((group) => {
                  const on = row.groupIds.includes(group.id)
                  return (
                    <button
                      key={group.id}
                      type="button"
                      className={`acl-chip${on ? ' is-on' : ''}`}
                      aria-pressed={on}
                      onClick={() => toggleGroup(row, group.id)}
                    >
                      {group.name}
                    </button>
                  )
                })}
              </td>
              <td>
                <button className="btn sm" type="button" disabled={status[row.value] === 'saving'} onClick={() => void save(row)}>
                  {status[row.value] === 'saving' ? '保存中…' : status[row.value] === 'saved' ? '已保存' : '保存'}
                </button>
                {errors[row.value] && <p className="hint" style={{ color: '#b91c1c' }}>{errors[row.value]}</p>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
