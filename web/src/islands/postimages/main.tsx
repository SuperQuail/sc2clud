// 编辑页配图管理岛（ui/PostImages.tsx）
import { createRoot } from 'react-dom/client'
import { PostImages, type PostImage } from '../../ui/PostImages'
import '../../ui/ui.css'

document.querySelectorAll<HTMLElement>('[data-island="post-images-edit"]').forEach((host) => {
  let images: PostImage[] = []
  try {
    images = JSON.parse(host.dataset.images || '[]') as PostImage[]
  } catch {
    images = []
  }
  createRoot(host).render(
    <PostImages
      postId={Number(host.dataset.postId || 0)}
      csrf={host.dataset.csrf || ''}
      base={`/p/${host.dataset.postId}/images`}
      max={Number(host.dataset.max || 10)}
      images={images}
    />,
  )
})
