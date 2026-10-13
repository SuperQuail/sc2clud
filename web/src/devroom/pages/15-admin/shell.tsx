import type { ReactNode } from 'react';
import Breadcrumbs from '@jetbrains/ring-ui-built/components/breadcrumbs/breadcrumbs';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import DropdownMenu from '@jetbrains/ring-ui-built/components/dropdown-menu/dropdown-menu';
import { appPath } from '@/lib/url';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import { RoleBadge } from '@/ui/user/role-badge';
import { fmtDate } from './mock';
import { NAV, type ScreenKey } from './nav';
import { SideNav } from './side-nav';

// 后台骨架：左侧分组导航 + 中栏 + 右栏（各屏自己组装中/右两栏），顶部面包屑与「当前管理员」。
// 权限点只在**导航项**上做粗筛：没权限的屏在真实实现里直接 403（前端方案 §6），
// 这里仍然列出来并标注，方便一次看全后台的信息架构。
export function AdminShell({ screen, onScreen, meExtra, children }: {
  screen: ScreenKey;
  onScreen: (key: ScreenKey) => void;
  /** 当前管理员的追加权限（/api/v1/me 的 extra：含到期与理由） */
  meExtra: { key: string; reason: string; expires_at: string | null }[];
  children: ReactNode;
}) {
  const current = NAV.flatMap((g) => g.items).find((i) => i.key === screen);
  return (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        {/* Breadcrumbs 渲染出来是一串 Fragment（没有外层元素），所以必须自己包一层：
            否则它会被外层 flex + justify-between 拆成「管理后台 …… / …… 用户管理」 */}
        <span className='flex min-w-0 items-center gap-1.5 text-[13px]'>
          <Breadcrumbs>
            <a href={appPath('?page=15-admin')}>管理后台</a>
            <span>{current?.title ?? '用户管理'}</span>
          </Breadcrumbs>
        </span>
        <div className='flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1'>
          <UserAvatar name='示范管理员' size='sm' />
          <span className='flex flex-col leading-tight'>
            <Username nickname='示范管理员' handle='demo-admin' badge='none' size='sm' strong />
            <span className='text-[11px] text-muted-foreground'>当前管理员 · 基线角色</span>
          </span>
          <RoleBadge role={{ key: 'admin', name: '管理员', color: '#7c3aed' }} />
          <DropdownMenu
            anchor={<Button>权限明细</Button>}
            data={[
              { key: 'base', label: '基线角色：管理员（role_permissions 已展开）' },
              ...meExtra.map((p) => ({
                key: p.key,
                label: p.key + (p.expires_at ? '（' + fmtDate(p.expires_at) + ' 到期）' : '（永久）') + ' · ' + p.reason,
              })),
            ]}
          />
        </div>
      </div>

      <div className='grid items-start gap-3 lg:grid-cols-[164px_minmax(0,1fr)]'>
        <div className='flex flex-col gap-2'>
          <SideNav
            ariaLabel='后台分组导航'
            value={screen}
            onChange={(key) => onScreen(key as ScreenKey)}
            groups={NAV.map((group) => ({
              title: group.grp,
              items: group.items.map((item) => ({
                key: item.key,
                label: item.title,
                count: item.badge ? Number(item.badge) : undefined,
              })),
            }))}
          />
          <p className='px-2 text-[10px] leading-relaxed text-muted-foreground'>
            导航项在真实实现里按权限点渲染（前端方案 §6 /admin/* 声明权限点，缺权限渲染 403）。
          </p>
        </div>
        <div className='flex min-w-0 flex-col gap-3'>{children}</div>
      </div>
    </div>
  );
}