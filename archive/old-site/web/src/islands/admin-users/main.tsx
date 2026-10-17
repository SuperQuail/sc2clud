// 管理页「用户列表 + 编辑弹窗」岛（控件：ui/AdminUsers.tsx）
import { createRoot } from 'react-dom/client'
import { AdminUsers } from '../../ui/AdminUsers'
import type { AdminUsersData } from '../../lib/admin'
import '../../ui/ui.css'

function mountAll() {
  document.querySelectorAll<HTMLElement>('[data-island="admin-users"]').forEach((host) => {
    // 老岛 admin.js 的 refreshRegions 会整块换掉 #users（添加用户/用户组后）：
    // 换过的新节点没挂过载，这里只对没挂过的挂一次
    if (host.dataset.mounted === '1') return
    host.dataset.mounted = '1'
    const data = JSON.parse(host.dataset.json || '{}') as AdminUsersData
    createRoot(host).render(<AdminUsers csrf={host.dataset.csrf || ''} data={data} />)
  })
}

mountAll()
document.addEventListener('sc2clud:remount', mountAll)
