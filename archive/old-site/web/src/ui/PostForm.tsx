import { useState } from 'react'
import { Sources } from './Sources'
import type { SourceProvider, SourceSlot } from '../lib/sources'
import { RichText } from './RichText'

export interface PostFormOption {
  value: string
  label: string
  checked?: boolean
}

export interface PostFormData {
  title: string
  body: string
  kinds: PostFormOption[]
  sections: PostFormOption[]
  providers: SourceProvider[]
  sources: SourceSlot[]
}

export interface PostFormProps {
  /** 提交地址（表单端点，服务端逻辑不变） */
  action: string
  /** 图片上传端点（正文插图用） */
  uploadEndpoint: string
  csrf: string
  /** 返回帖子的地址（取消） */
  back: string
  data: PostFormData
}

/**
 * 发帖 / 编辑的整张表单（控件库）：标题、类型、分区、下载来源、正文富文本。
 * 字段名与服务端解析保持一致（title/kind/section/provider/label/code/url/body），
 * 直接提交原生表单，因此服务端与旧的保存路径一行没改。
 */
export function PostForm({ action, uploadEndpoint, csrf, back, data }: PostFormProps) {
  const [kind, setKind] = useState(data.kinds.find((k) => k.checked)?.value ?? data.kinds[0]?.value ?? '')
  const [section, setSection] = useState(data.sections.find((s) => s.checked)?.value ?? data.sections[0]?.value ?? '')
  const [sources, setSources] = useState<SourceSlot[]>(data.sources)

  return (
    <form method="post" action={action} className="stack">
      <label>标题
        <input type="text" name="title" defaultValue={data.title} required minLength={2} maxLength={120} />
      </label>

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>类型</legend>
        <div className="kind-options">
          {data.kinds.map((option) => (
            <label key={option.value} className={kind === option.value ? 'on' : ''}>
              <input
                type="radio"
                name="kind"
                value={option.value}
                checked={kind === option.value}
                onChange={() => setKind(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <label>分区
        <select name="section" value={section} onChange={(e) => setSection(e.target.value)}>
          {data.sections.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>

      <Sources providers={data.providers} value={sources} onChange={setSources} />

      {/* 正文：富文本组件（存储仍是 markdown，写回隐藏字段，表单原样提交） */}
      <div className="field">
        <span className="ui-label">正文</span>
        <RichText bodyName="body" initial={data.body} uploadEndpoint={uploadEndpoint} csrf={csrf} />
      </div>

      <div className="actions-inline">
        <button className="btn" type="submit">保存</button>
        <a className="btn ghost" href={back}>取消</a>
      </div>
    </form>
  )
}