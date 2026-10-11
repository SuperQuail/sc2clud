import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'
import { marked } from 'marked'
import TurndownService from 'turndown'
import { compressImage, uploadImage } from '../lib/image'

export interface RichTextProps {
  /** 提交用的隐藏字段（模板里的 textarea id）：内容始终以 markdown 写回，存储格式不变 */
  targetId: string
  /** 初始 markdown（未提供就从 target 的当前值读） */
  initial?: string
  /** 图片上传端点（省略则隐藏插图按钮） */
  uploadEndpoint?: string
  csrf?: string
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
// 图片保持 `![alt](src)`：与 render_body 的解析一致
turndown.addRule('keepImage', {
  filter: 'img',
  replacement: (_content, node) => {
    const el = node as HTMLImageElement
    return `![${el.alt || '配图'}](${el.getAttribute('src') || ''})`
  },
})

/**
 * 可复用富文本编辑器（控件库）：TipTap 负责编辑体验，**存储仍然是 markdown**。
 * 载入时 markdown → HTML，编辑时 HTML → markdown 写回隐藏字段，因此服务端、老帖都不用改。
 */
export function RichText({ targetId, initial, uploadEndpoint, csrf }: RichTextProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const file = useRef<HTMLInputElement>(null)
  const markdown = useRef(initial ?? '')

  const editor = useEditor({
    extensions: [
      StarterKit,
      Image.configure({ inline: false, allowBase64: false }),
      Link.configure({ openOnClick: false }),
    ],
    content: turndownToHtml(markdown.current),
    onUpdate: ({ editor: instance }) => {
    
        const html = instance.getHTML()
        markdown.current = turndown.turndown(html)
        const target = document.getElementById(targetId) as HTMLTextAreaElement | null
        if (target) target.value = markdown.current
    },
  })

  // 组件挂载时把 target 的初值同步进来（模板本来就是服务端渲染的，无 JS 也能用）
  useEffect(() => {
    const target = document.getElementById(targetId) as HTMLTextAreaElement | null
    if (target && target.value) markdown.current = target.value
  }, [targetId])

  async function onPick(event: ChangeEvent<HTMLInputElement>) {
    const picked = event.target.files?.[0]
    if (!picked || !editor || !uploadEndpoint) return
    setBusy(true)
    setError('')
    try {
      const blob = await compressImage(picked, 512 * 1024)
      const url = await uploadImage(uploadEndpoint, csrf || '', blob, picked.name)
      editor.chain().focus().setImage({ src: url, alt: '配图' }).run()
    } catch (e) {
      setError(e instanceof Error ? e.message : '插入图片失败')
    } finally {
      setBusy(false)
      if (file.current) file.current.value = ''
    }
  }

  if (!editor) return null
  const btn = (label: string, title: string, on: boolean, run: () => void) => (
    <button key={label} type="button" title={title} data-on={on ? 'true' : 'false'} onClick={run}>{label}</button>
  )

  return (
    <div className="rte">
      <div className="rte-bar">
        {btn('B', '加粗', editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
        {btn('I', '斜体', editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run())}
        {btn('H', '小标题', editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run())}
        {btn('≡', '无序列表', editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
        {btn('❝', '引用', editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run())}
        {btn('<>', '代码块', editor.isActive('codeBlock'), () => editor.chain().focus().toggleCodeBlock().run())}
        {btn('↺', '撤销', false, () => editor.chain().focus().undo().run())}
        {uploadEndpoint && (
          <>
            <button type="button" title="插入图片" disabled={busy} onClick={() => file.current?.click()}>
              {busy ? '上传中…' : '图片'}
            </button>
            <input ref={file} type="file" accept="image/*" hidden onChange={onPick} />
          </>
        )}
      </div>
      <EditorContent className="rte-body" editor={editor} />
      {error && <p className="rte-error">{error}</p>}
    </div>
  )
}

/** markdown → HTML（marked）；失败就退回纯文本转义，保证编辑器永远能打开 */
function turndownToHtml(md: string): string {
  try {
    return marked.parse(md, { async: false }) as string
  } catch {
    return md.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch] ?? ch)
  }
}
