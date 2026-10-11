import { emptySource, type SourceProvider, type SourceSlot } from '../lib/sources'

export interface SourcesProps {
  providers: SourceProvider[]
  /** 受控值：父组件持有状态（表单岛 / 独立岛都能用） */
  value: SourceSlot[]
  onChange: (rows: SourceSlot[]) => void
  legend?: string
}

/**
 * 下载来源控件（控件库）：字段名 provider/label/code/url 与服务端解析一致，
 * 直接随表单提交；样式在 ui.css（.src-*），与页面模板解耦。
 */
export function Sources({ providers, value, onChange, legend = '下载来源（数量不限，名称可自定义）' }: SourcesProps) {
  const first = providers[0]?.value ?? ''
  const rows = value.length > 0 ? value : [emptySource(first)]

  const patch = (index: number, key: keyof SourceSlot, next: string) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, [key]: next } : row)))

  return (
    <fieldset className="src-field">
      <legend>{legend}</legend>
      <div className="src-rows">
        {rows.map((row, index) => (
          <div className="src-row" key={index}>
            <select name="provider" value={row.provider} onChange={(e) => patch(index, 'provider', e.target.value)}>
              {providers.map((provider) => (
                <option key={provider.value} value={provider.value}>{provider.label}</option>
              ))}
            </select>
            <input type="text" name="label" value={row.label} maxLength={24} placeholder="显示名（可留空）" onChange={(e) => patch(index, 'label', e.target.value)} />
            <input type="text" name="code" value={row.code} maxLength={8} placeholder="提取码" onChange={(e) => patch(index, 'code', e.target.value)} />
            <input type="url" name="url" value={row.url} placeholder="https:// 下载地址" onChange={(e) => patch(index, 'url', e.target.value)} />
            <button
              className="ui-btn ui-btn-sm"
              type="button"
              title="删除这一行"
              disabled={rows.length <= 1}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
      <div className="src-actions">
        <button className="ui-btn ui-btn-sm" type="button" onClick={() => onChange([...rows, emptySource(first)])}>＋ 添加一个来源</button>
        <span className="ui-hint">留空的整行会被忽略；保存后按这里的顺序重写</span>
      </div>
    </fieldset>
  )
}
