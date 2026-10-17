// 发帖/编辑表单岛：整张表单由 ui/PostForm 渲染，初值从 data-json 读（Rust 侧序列化，安全）
import { createRoot } from 'react-dom/client'
import { PostForm, type PostFormData } from '../../ui/PostForm'
import '../../ui/ui.css'

document.querySelectorAll<HTMLElement>('[data-island="post-form"]').forEach((host) => {
  const data = JSON.parse(host.dataset.json || '{}') as PostFormData
  createRoot(host).render(
    <PostForm
      action={host.dataset.action || ''}
      uploadEndpoint={host.dataset.upload || ''}
      csrf={host.dataset.csrf || ''}
      back={host.dataset.back || '/'}
      data={data}
    />,
  )
})
