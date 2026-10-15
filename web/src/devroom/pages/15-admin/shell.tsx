import type { ReactNode } from 'react';
import Breadcrumbs from '@jetbrains/ring-ui-built/components/breadcrumbs/breadcrumbs';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import DropdownMenu from '@jetbrains/ring-ui-built/components/dropdown-menu/dropdown-menu';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { LogOut } from 'lucide-react';
import { appPath } from '@/lib/url';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import { RoleBadge } from '@/ui/user/role-badge';
import { fmtDate } from './mock';
import { NAV, type ScreenKey } from './nav';
import { SideNav } from './side-nav';

// 后台骨架：左侧分组导航 + 中栏 + 右栏（各屏自己组装中/右两栏），顶部面包屑与「当前管理员」。
// 权限点只在**导航项**上做粗筛：没权限的屏在真实实现里直接 403（前端方案 §6），
// 这里仍然列出来并标注，方便一次看全后台的信息架构。
//
// **D14**：右上角那张卡以前写死「示范管理员 @demo-admin / 管理员」—— 那是 DevRoom 时期的 mock，
// 于是每个登录者看到的都是同一个人。现在只吃宿主喂进来的**真 session**；喂不到就**整块不画**，
// 绝不拿一个示例用户顶上（界面上显示一个不存在的管理员，比空着危险得多：出问题时人会去找他）。
export type AdminSelf = {
  nickname: string;
  handle: string;
  /** /me 的 role 只有 key 与 name（**没有颜色**）——所以徽标走 design 2（ours 的令牌色） */
  role?: { key: string; name: string } | null;
  avatar?: string | null;
};

export function AdminShell({ screen, onScreen, me, meExtra, onLogout, children }: {
  screen: ScreenKey;
  onScreen: (key: ScreenKey) => void;
  /** 当前登录者（真 session）。**没有就不画那张卡** */
  me?: AdminSelf | null;
  /** 当前管理员的追加权限（/api/v1/me 的 extra：含到期与理由） */
  meExtra: { key: string; reason: string; expires_at: string | null }[];
  /** D57：右上卡上的「退出登录」。缺省不画（无登录者时角落里不能有一颗不知道退谁的按钮） */
  onLogout?: () => void;
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
        {me ? (
          <div className='flex items-center gap-2 rounded-md border border-border bg-card px-2 py-1'>
            <UserAvatar name={me.nickname} src={me.avatar} size='sm' />
            <span className='flex flex-col leading-tight'>
              <Username nickname={me.nickname} handle={me.handle} badge='none' size='sm' strong />
              <span className='text-[11px] text-muted-foreground'>当前管理员</span>
            </span>
            {me.role ? <RoleBadge role={me.role} design={2} /> : null}
            <DropdownMenu
              anchor={<Button>权限明细</Button>}
              data={[
                ...(me.role ? [{ key: 'base', label: '基线角色：' + me.role.name + '（role_permissions 已展开）' }] : []),
                ...meExtra.map((p) => ({
                  key: p.key,
                  label: p.key + (p.expires_at ? '（' + fmtDate(p.expires_at) + ' 到期）' : '（永久）') + ' · ' + p.reason,
                })),
              ]}
            />
            {/* D57：用户找不到退出入口 —— 设置页里其实一直有（AccountPanel），但管理员一进后台就认定
                「退出在这张卡上才对」。直接给它：退出在这一刻可见、可点，不用先想到去 /settings。 */}
            {onLogout ? (
              <Button
                inline={false}
                height={ControlsHeight.S}
                icon={icon16(LogOut)}
                data-testid='admin-logout'
                onClick={onLogout}
              >
                退出登录
              </Button>
            ) : null}
          </div>
        ) : (
          // 拿不到登录者时**不画人**（不编一个示例管理员），但也不留一片沉默：
          // 这一行说明它为什么空着 —— 空白与「这个人没有名字」在界面上长得一样。
          <span data-testid='admin-self-missing' className='rounded-md border border-dashed border-border px-2 py-1 text-[11px] text-muted-foreground'>
            没拿到当前登录者（/me 还没回来）——这里不显示任何人，刷新后自动出现。
          </span>
        )}
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
              })),
            }))}
          />
          <p className='px-2 text-[10px] leading-relaxed text-muted-foreground'>
            没有权限的页面不会出现在导航里；越权访问会直接被拒。
          </p>
        </div>
        <div className='flex min-w-0 flex-col gap-3'>{children}</div>
      </div>
    </div>
  );
}