import { useState, type FormEvent } from 'react'
import { Button } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { Input, Textarea } from '../../ui/Input'
import { SelectBox } from '../../ui/Select'
import { createIssue, ISSUE_KINDS, type IssueKind } from '../../lib/issues'
import './issues.css'

export interface IssuesAppProps {
  postId: number
  csrf: string
  defaultKind: IssueKind
}

export function IssuesApp({ postId, csrf, defaultKind }: IssuesAppProps) {
  const [kind, setKind] = useState<IssueKind>(defaultKind)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!title.trim()) {
      setError('标题不能为空')
      return
    }
    setBusy(true)
    setError('')
    try {
      await createIssue(postId, { kind, title: title.trim(), body: body.trim(), csrf })
      location.href = `/p/${postId}/issues`
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败')
      setBusy(false)
    }
  }

  const options = ISSUE_KINDS.map((item) => ({
    value: item.value,
    label: item.label,
    hint: item.hint,
  }))

  return (
    <form className="publish" onSubmit={onSubmit}>
      <h2>发布反馈</h2>
      <p className="lead">选一个类型，写清现象或想法；提交后作者与管理员都会看到。</p>
      <Field label="类型（必选）">
        <SelectBox
          value={kind}
          onChange={(value) => setKind(value as IssueKind)}
          options={options}
          aria-label="反馈类型"
        />
      </Field>
      <Field label="标题" hint="一句话说清问题，例如：第三关开局就崩溃">
        <Input value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="正文" hint="复现步骤 / 你的版本 / 期望的行为。写清这些，作者才好定位。">
        <Textarea value={body} rows={8} maxLength={5000} onChange={(e) => setBody(e.target.value)} />
      </Field>
      {error ? <p className="err">{error}</p> : null}
      <div className="actions">
        <Button type="submit" disabled={busy}>{busy ? '提交中…' : '提交反馈'}</Button>
        <a className="ui-btn" data-variant="ghost" href={`/p/${postId}/issues`}>取消</a>
      </div>
    </form>
  )
}
