// 帖子页右栏资源岛：复制原链 + 镜像测速（控件在 web/src/ui/PostAside.tsx）
import React from 'react'
import { createRoot } from 'react-dom/client'
import { PostAside } from '../../ui/PostAside'

const host = document.querySelector<HTMLElement>('[data-island="postaside"]')
if (host) createRoot(host).render(<PostAside />)
