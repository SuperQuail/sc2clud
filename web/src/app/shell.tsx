import { Suspense } from 'react';
import { Link, Outlet } from 'react-router';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { useQuery } from '@tanstack/react-query';
import { Bell, Download, MessageSquare, Search } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { ThemeSwitcher } from '@/ui/theme-switcher';
import { UserAvatar } from '@/ui/user/avatar';
import { appPath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { fetchSite } from '@/lib/api/site';
import { useSession } from '@/lib/perms';
import { AdminEntryButton } from '@/routes/_parts/admin-entry';
import { Loading } from '@/routes/_parts/state';

// 布局壳：顶栏 / 横幅 / 内容 / 页脚（前端方案 §4 的 app/shell.tsx）。
// 内容宽度 max-w-[1280px] 是**量出来的**，不是随手取的：帖子页是贴吧式三栏、信息流要求
// 1440/1200 档一行 ≥4 张方卡片，两者要在同一个容器里同时成立，1024/1100 都塞不下。**不要再改这里**。
//
// 站名与横幅来自 GET /site（契约 §21.2 site 段）。拿不到就用常量名 —— 顶栏不该因为一个可有可无的
// 接口而空着或白屏（三态在这里的形态是「退化」而不是「报错」）。
export function Shell() {
  const session = useSession();
  const site = useQuery({ queryKey: qk.site(), queryFn: ({ signal }) => fetchSite(signal), staleTime: 10 * 60_000 });

  return (
    <div className='flex min-h-screen flex-col bg-background'>
      <header className='border-b border-border'>
        <div className='mx-auto flex h-14 w-full max-w-[1280px] items-center gap-6 px-4'>
          <Link to={appPath('')} className='shrink-0 font-semibold text-foreground'>
            {site.data?.name ?? 'SC2clud'}
          </Link>
          <nav aria-label='主导航' className='hidden items-center gap-1 sm:flex'>
            <Button ghost inline={false} height={ControlsHeight.S} href={appPath('')}>
              首页
            </Button>
            <Button ghost inline={false} height={ControlsHeight.S} href={appPath('search')} icon={icon16(Search)}>
              搜索
            </Button>
            <Button ghost inline={false} height={ControlsHeight.S} href={appPath('download')} icon={icon16(Download)}>
              下载
            </Button>
          </nav>
          <div className='ml-auto flex items-center gap-2'>
            <AdminEntryButton />
            {session.isLoggedIn ? (
              <>
                <Button
                  ghost
                  inline={false}
                  height={ControlsHeight.S}
                  icon={icon16(Bell)}
                  href={appPath('notifications')}
                  aria-label='通知中心'
                  title='通知中心'
                />
                <Button
                  ghost
                  inline={false}
                  height={ControlsHeight.S}
                  icon={icon16(MessageSquare)}
                  href={appPath('messages')}
                  aria-label='私信'
                  title='私信'
                />
                <Button
                  ghost
                  inline={false}
                  height={ControlsHeight.S}
                  icon={icon16(Search)}
                  href={appPath('new')}
                  aria-label='发帖'
                  title='发帖'
                />
                <Link
                  to={appPath('u/' + encodeURIComponent(session.session?.handle ?? ''))}
                  className='flex items-center gap-2 rounded-md px-1 py-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
                >
                  <UserAvatar name={session.session?.nickname ?? ''} src={session.session?.avatar} size='sm' />
                  <span className='hidden text-[13px] text-foreground sm:inline'>{session.session?.nickname}</span>
                </Link>
              </>
            ) : (
              <>
                <Button inline={false} height={ControlsHeight.S} href={appPath('login')}>
                  登录
                </Button>
                <Button primary inline={false} height={ControlsHeight.S} href={appPath('register')}>
                  注册
                </Button>
              </>
            )}
            <ThemeSwitcher />
          </div>
        </div>
      </header>

      {/* 横幅位：只在后端真的给了没被关掉的横幅时出现（§21.2 banners/{id}/dismiss 负责关掉） */}
      {site.data?.banner && !site.data.banner.dismissed ? (
        <div role='status' className='border-b border-border bg-muted'>
          <p className='mx-auto w-full max-w-[1280px] px-4 py-2 text-[13px] text-foreground'>{site.data.banner.text}</p>
        </div>
      ) : null}

      <main className='mx-auto w-full max-w-[1280px] flex-1 px-4 py-6'>
        {/* 懒加载页第一次进来会有一瞬空白：**不给文案就等于白屏**（DevRoom 因为这一条吃过亏） */}
        <Suspense fallback={<Loading what='页面' />}>
          <Outlet />
        </Suspense>
      </main>

      <footer className='border-t border-border py-6'>
        <div className='mx-auto flex w-full max-w-[1280px] flex-wrap items-center justify-center gap-x-4 gap-y-1 px-4 text-xs text-muted-foreground'>
          <span>{site.data?.name ?? 'SC2clud'} · 星际争霸战役社区</span>
          <a className='underline' href={appPath('appeal?type=other')}>
            反馈与申诉
          </a>
          <a className='underline' href={appPath('download')}>
            启动器下载
          </a>
        </div>
      </footer>
    </div>
  );
}
