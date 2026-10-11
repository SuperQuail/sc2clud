// 帖子页动作岛：点赞 / 收藏 / 「⋯」菜单（控件在 web/src/ui/PostActions.tsx）
import React from 'react'
import { createRoot } from 'react-dom/client'
import { PostActions } from '../../ui/PostActions'

const host = document.querySelector<HTMLElement>('[data-island="postactions"]')
if (host) {
  const flag = (name: string) => host.dataset[name] === 'true'
  createRoot(host).render(<PostActions
    postId={Number(host.dataset.postId || 0)}
    likeAction={host.dataset.likeAction || ''}
    bookmarkAction={host.dataset.bookmarkAction || ''}
    csrf={host.dataset.csrf || ''}
    likeCount={Number(host.dataset.likeCount || 0)}
    liked={flag('liked')}
    bookmarked={flag('bookmarked')}
    canEdit={flag('canEdit')}
    isStaff={flag('isStaff')}
    state={host.dataset.state || ''}
    stateLabel={host.dataset.stateLabel || ''}
    archived={flag('archived')}
    uiVariant={Number(host.dataset.uiVariant || 2)}
  />)
}
