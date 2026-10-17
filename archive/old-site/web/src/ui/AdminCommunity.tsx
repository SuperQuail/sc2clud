import { useState } from 'react'
import { setBlockReply, type AdminCommunityData } from '../lib/admin'

export interface AdminCommunityProps {
  csrf: string
  data: AdminCommunityData
}

const errText = (e: unknown) => (e instanceof Error ? e.message : '请求失败')

/** 社区开关：改完点保存立即生效（不刷新页面）；失败显示错误，不静默。 */
export function AdminCommunity({ csrf, data }: AdminCommunityProps) {
  const [enabled, setEnabled] = useState(data.blockReplyEnforced)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  async function save() {
    setSaving(true)
    setMessage('')
    setError('')
    try {
      setMessage(await setBlockReply(csrf, enabled))
    } catch (e) {
      setError(errText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      <h2>社区开关</h2>
      <div className="acl-row">
        <label className="acl-switch">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          <span>被拉黑后不能在对方帖子下回复</span>
        </label>
        <button className="btn sm" type="button" disabled={saving} onClick={() => void save()}>
          {saving ? '保存中…' : '保存'}
        </button>
        {message && <span className="form-note ok" role="status">{message}</span>}
      </div>
      <p className="hint">默认关闭（现状）：被拉黑只影响私信与列表显示；开启后，被他拉黑的人无法在他的帖子下回复。</p>
      {error && <p className="alert" role="alert">{error}</p>}
    </>
  )
}
