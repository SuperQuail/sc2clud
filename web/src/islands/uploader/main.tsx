// 统一上传控件岛：帖子配图 / issue 配图共用（替换原先各写一份的内联 JS）
import { createRoot } from 'react-dom/client'
import { Uploader } from '../../ui/Uploader'
import '../../ui/ui.css'

document.querySelectorAll<HTMLElement>('[data-island="uploader"]').forEach((host) => {
  createRoot(host).render(
    <Uploader
      endpoint={host.dataset.endpoint || ''}
      csrf={host.dataset.csrf || ''}
      max={Number(host.dataset.max || 10)}
      existing={Number(host.dataset.existing || 0)}
    />,
  )
})
