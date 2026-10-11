// 正文工具栏岛：只挂一排按钮，增强编辑页原有的 textarea（无 JS 时表单照常提交）
import { createRoot } from 'react-dom/client'
import { EditorToolbar, type EditorImage } from '../../ui/MarkdownEditor'
import '../../ui/ui.css'

document.querySelectorAll<HTMLElement>('[data-island="editor-toolbar"]').forEach((host) => {
  let images: EditorImage[] = []
  try {
    images = JSON.parse(host.dataset.images || '[]') as EditorImage[]
  } catch {
    images = []
  }
  createRoot(host).render(<EditorToolbar targetId={host.dataset.target || 'post-body'} images={images} />)
})
