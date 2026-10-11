import { useEffect, useState } from 'react'

export interface EditorImage {
  href: string
  number?: number
}

export interface EditorToolbarProps {
  /** 要增强的 textarea 的 id（不替换它，无 JS 时表单照常可用） */
  targetId: string
  /** 帖子已有的配图（点「插入图片」时可选） */
  images: EditorImage[]
}

interface Action {
  label: string
  title: string
  /** 包裹选中文本（前后各插一段），没选中就插入占位 */
  wrap?: [string, string]
  /** 行首插入 */
  prefix?: string
  placeholder?: string
}

const ACTIONS: Action[] = [
  { label: 'B', title: '加粗（Ctrl+B）', wrap: ['**', '**'], placeholder: '加粗文字' },
  { label: 'I', title: '斜体（Ctrl+I）', wrap: ['*', '*'], placeholder: '斜体文字' },
  { label: 'H', title: '小标题', prefix: '## ', placeholder: '小标题' },
  { label: '≡', title: '无序列表', prefix: '- ', placeholder: '列表项' },
  { label: '❝', title: '引用', prefix: '> ', placeholder: '引用内容' },
  { label: '<>', title: '行内代码', wrap: ['`', '`'], placeholder: 'code' },
  { label: '🔗', title: '链接', wrap: ['[', '](https://)'], placeholder: '链接文字' },
]

/**
 * 正文工具栏：对现成的 textarea 做渐进增强（不接管表单，也不引入编辑器框架）。
 * 插入的都是纯 markdown，服务端 render_body 直接渲染（含 ![说明](/img/hash) 配图）。
 */
export function EditorToolbar({ targetId, images }: EditorToolbarProps) {
  const [pickerOpen, setPickerOpen] = useState(false)

  const area = () => document.getElementById(targetId) as HTMLTextAreaElement | null

  function apply(action: Action) {
    const el = area()
    if (!el) return
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? start
    const selected = el.value.slice(start, end)
    let insert = ''
    if (action.wrap) {
      const text = selected || action.placeholder || ''
      insert = action.wrap[0] + text + action.wrap[1]
    } else if (action.prefix) {
      const text = selected || action.placeholder || ''
      insert = action.prefix + text
    }
    el.setRangeText(insert, start, end, 'end')
    el.focus()
  }

  function insertImage(href: string) {
    const el = area()
    if (!el) return
    const text = `![配图](${href})`
    el.setRangeText(text, el.selectionStart ?? el.value.length, el.selectionEnd ?? el.value.length, 'end')
    el.focus()
    setPickerOpen(false)
  }

  // Ctrl+B / Ctrl+I 也走同一套插入逻辑
  useEffect(() => {
    const el = area()
    if (!el) return
    function onKey(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey)) return
      const key = event.key.toLowerCase()
      const action = key === 'b' ? ACTIONS[0] : key === 'i' ? ACTIONS[1] : null
      if (!action) return
      event.preventDefault()
      apply(action)
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="editor-bar">
      <div className="editor-tools">
        {ACTIONS.map((action) => (
          <button key={action.label} className="editor-tool" type="button" title={action.title} onClick={() => apply(action)}>
            {action.label}
          </button>
        ))}
        <span className="editor-sep" />
        <button className="editor-tool" type="button" title="插入配图" onClick={() => setPickerOpen((open) => !open)}>图片</button>
      </div>
      {pickerOpen && (
        <div className="editor-images">
          {images.length === 0 && <span className="hint">还没有配图，先在下方「配图」处上传。</span>}
          {images.map((image) => (
            <button key={image.href} type="button" className="editor-thumb" title="插入这张" onClick={() => insertImage(image.href)}>
              <img src={image.href} alt="" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
