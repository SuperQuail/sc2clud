import { useEffect } from 'react'
import { copyWithFeedback, rankMirrors } from '../lib/postaside'

/**
 * 帖子页右栏资源区：复制 GitHub 原链 + 镜像实测。
 * 下拉、按钮、提示都由 post_aside.html 服务端渲染，这里只接管行为。
 */
export function PostAside() {
  useEffect(() => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy-github]')) {
      button.addEventListener('click', () => void copyWithFeedback(button, button.dataset.copyGithub ?? ''))
    }
    for (const box of document.querySelectorAll<HTMLElement>('[data-mirror-box]')) {
      const select = box.querySelector<HTMLSelectElement>('[data-mirror-select]')
      const open = box.querySelector<HTMLButtonElement>('[data-mirror-open]')
      const note = box.querySelector<HTMLElement>('[data-mirror-note]')
      if (!select || !open) continue
      open.addEventListener('click', () => window.open(select.value, '_blank', 'noopener,noreferrer'))
      void rankMirrors(box).then((fastest) => {
        if (!note) return
        note.textContent = fastest
          ? `已实测：最快的是 ${fastest.label}（约 ${Math.round(fastest.ms)} ms）`
          : '只有一个原链来源；网络慢的话可以自己挂代理'
      })
    }
  }, [])
  return null
}
