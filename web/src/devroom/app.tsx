import Button from '@jetbrains/ring-ui-built/components/button/button';
import { VERIFIED } from './registry';
import { appPath } from '@/lib/url';
import ShowroomPage from './pages/00-showroom';
import InteractivePage from './pages/01-interactive';
import OurComponentsPage from './pages/05-our-components';
import UserStylesPage from './pages/06-user-styles';
import UserRenderPage from './pages/07-user-render';
import OverlayPage from './pages/02-overlay';
import NavigationPage from './pages/03-navigation';
import DisplayPage from './pages/04-display';
import CommentsPage from './pages/08-comments';
import MessagesPage from './pages/10-messages';
import ProfilePage from './pages/11-profile';
import AdminPage from './pages/15-admin';
import HomePage from './pages/14-home';
import IssuePage from './pages/13-issue';
import TopicPage from './pages/12-topic';
import AuthPage from './pages/16-auth';
import RichPage from './pages/09-rich';
import { ThemeSwitcher } from '@/ui/theme-switcher';

// 开发者房间：控件在这里**逐件验证**；业务代码只允许使用登记过的控件。
// 容器宽度必须与真实壳（src/app/shell.tsx）一致：都是 1280px。
// 对不上的后果已经踩过——房间锁 1100px，页面里为了塞下三栏只能自己加负边距外扩，
// 于是「房间里量到的列宽/列数」在真站不成立，量出来的指标是假的。
const PAGES: Record<string, { title: string; el: () => React.ReactNode }> = {
  '00-showroom': { title: '00 · 样板间', el: () => <ShowroomPage /> },
  '01-interactive': { title: '01 · 交互与表单', el: () => <InteractivePage /> },
  '02-overlay': { title: '02 · 浮层与反馈', el: () => <OverlayPage /> },
  '03-navigation': { title: '03 · 导航与结构', el: () => <NavigationPage /> },
  '04-display': { title: '04 · 展示与状态', el: () => <DisplayPage /> },
  '05-our-components': { title: '05 · 我们的组合件', el: () => <OurComponentsPage /> },
  '06-user-styles': { title: '06 · 用户向风格候选', el: () => <UserStylesPage /> },
  '07-user-render': { title: '07 · 用户身份控件', el: () => <UserRenderPage /> },
  '08-comments': { title: '08 · 评论区', el: () => <CommentsPage /> },
  '12-topic': { title: '12 · 帖子内容页', el: () => <TopicPage /> },
  '13-issue': { title: '13 · Issue', el: () => <IssuePage /> },
  '14-home': { title: '14 · 主页面', el: () => <HomePage /> },
  '15-admin': { title: '15 · 管理员', el: () => <AdminPage /> },
  '11-profile': { title: '11 · 个人主页', el: () => <ProfilePage /> },
  '10-messages': { title: '10 · 信息中心', el: () => <MessagesPage /> },
  '09-rich': { title: '09 · 富文本与图片', el: () => <RichPage /> },
  '16-auth': { title: '16 · 登录与注册', el: () => <AuthPage /> },
};

export function DevRoom({ page }: { page: string }) {
  const current = PAGES[page] ?? PAGES['00-showroom']!;
  return (
    <div className='min-h-screen bg-background text-foreground'>
      <header className='border-b border-border bg-background'>
        <div className='mx-auto flex w-full max-w-[1280px] flex-col gap-2 px-5 py-4'>
          <h1 className='text-lg font-semibold'>开发者房间 · DevRoom</h1>
          <p className='text-[13px] leading-relaxed text-muted-foreground'>
            这里逐个验证控件。**业务代码只允许使用已登记（src/devroom/registry.ts）的控件**；
            需要新控件 → 先在本房间加一页验证 → 登记 → 才能用。未登记会被 pnpm gate:controls 挡住。
          </p>
          <nav aria-label='开发者房间页面' className='flex flex-wrap items-center gap-2 pt-1'>
            {Object.entries(PAGES).map(([key, p]) => (
              <Button key={key} href={appPath('?page=' + key)} active={key === page}>
                {p.title}
              </Button>
            ))}
            <span className='ml-auto flex items-center gap-3'>
              <span className='text-xs text-muted-foreground'>已登记控件：{VERIFIED.length} 个</span>
              <ThemeSwitcher />
            </span>
          </nav>
        </div>
      </header>
      <main className='mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-5 py-5'>{current.el()}</main>
    </div>
  );
}