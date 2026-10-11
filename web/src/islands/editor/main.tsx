// 正文富文本岛：可复用控件 ui/RichText.tsx；模板里的 textarea 仍然存在（无 JS 时照常提交）
import { createRoot } from 'react-dom/client'
import { RichText } from '../../ui/RichText'
import '../../ui/ui.css'

document.querySelectorAll<HTMLElement>('[data-island="editor"]').forEach((host) => {
  const target = document.getElementById(host.dataset.target || 'post-body') as HTMLTextAreaElement | null
  createRoot(host).render(
    <RichText
      targetId={host.dataset.target || 'post-body'}
      initial={target?.value ?? ''}
      uploadEndpoint={host.dataset.upload || undefined}
      csrf={host.dataset.csrf || ''}
    />,
  )
})
