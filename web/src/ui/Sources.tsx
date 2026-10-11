import { useState } from 'react'

export interface SourceProvider {
  value: string
  label: string
}

export interface SourceSlot {
  provider: string
  label: string
  code: string
  url: string
}

export interface SourcesProps {
  providers: SourceProvider[]
  initial: SourceSlot[]
}

const empty = (provider: string): SourceSlot => ({ provider, label: '', code: '', url: '' })

/**
 * 下载来源：数量不限、可增删。字段名与旧模板保持一致（provider/label/code/url），
 * 因此服务端的表单解析与保存逻辑一行都不用改；无 JS 时服务端渲染的行照常提交。
 */
export function Sources({ providers, initial }: SourcesProps) {
  const first = providers[0]?.value ?? ''
  const [rows, setRows] = useState<SourceSlot[]>(initial.length > 0 ? initial : [empty(first)])

  const patch = (index: number, key: keyof SourceSlot, value: string) =>
    setRows((prev) => prev.map((row, i) => (i === index ? { ...row, [key]: value } : row)))

  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>下载来源（数量不限，名称可自定义）</legend>
      <div className="source-rows">
        {rows.map((row, index) => (
          <div className="source-row" key={index}>
            <select name="provider" value={row.provider} onChange={(e) => patch(index, 'provider', e.target.value)}>
              {providers.map((provider) => (
                <option key={provider.value} value={provider.value}>{provider.label}</option>
              ))}
            </select>
            <input type="text" name="label" value={row.label} maxLength={24} placeholder="显示名（可留空）" onChange={(e) => patch(index, 'label', e.target.value)} />
            <input type="text" name="code" value={row.code} maxLength={8} placeholder="提取码" onChange={(e) => patch(index, 'code', e.target.value)} />
            <input type="url" name="url" value={row.url} placeholder="https:// 下载地址" onChange={(e) => patch(index, 'url', e.target.value)} />
            <button className="icon-btn" type="button" title="删除这一行" onClick={() => setRows((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : prev))}>
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="actions-inline" style={{ marginTop: 10 }}>
        <button className="btn ghost sm" type="button" onClick={() => setRows((prev) => [...prev, empty(first)])}>＋ 添加一个来源</button>
        <span className="hint">留空的整行会被忽略；保存后按这里的顺序重写</span>
      </div>
    </fieldset>
  )
}
