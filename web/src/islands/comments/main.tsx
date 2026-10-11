// 统一评论岛：帖子页与 issue 详情共用（控件在 web/src/ui/Comments.tsx）
import { createRoot } from 'react-dom/client'
import { Comments } from '../../ui/Comments'
import '../../ui/ui.css'

document.querySelectorAll<HTMLElement>('[data-island="comments"]').forEach((host) => {
  const flag = (name: string, fallback = true) => (host.dataset[name] ?? String(fallback)) === 'true'
  createRoot(host).render(
    <Comments
      list={host.dataset.list || ''}
      action={host.dataset.action || ''}
      csrf={host.dataset.csrf || ''}
      canReply={flag('canReply')}
      showActions={flag('showActions')}
      loggedIn={flag('loggedIn', false)}
    />,
  )
})
