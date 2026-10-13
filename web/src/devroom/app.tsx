import Button from '@jetbrains/ring-ui-built/components/button/button';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import { VERIFIED } from './registry';
import { appPath } from '@/lib/url';
import ShowroomPage from './pages/00-showroom';
import InteractivePage from './pages/01-interactive';
import OverlayPage from './pages/02-overlay';
import NavigationPage from './pages/03-navigation';
import DisplayPage from './pages/04-display';
import OurComponentsPage from './pages/05-our-components';
import UserStylesPage from './pages/06-user-styles';
import UserRenderPage from './pages/07-user-render';
import CommentsPage from './pages/08-comments';
import RichPage from './pages/09-rich';
import MessagesPage from './pages/10-messages';
import ProfilePage from './pages/11-profile';
import TopicPage from './pages/12-topic';
import IssuePage from './pages/13-issue';
import HomePage from './pages/14-home';
import AdminPage from './pages/15-admin';
import AuthPage from './pages/16-auth';
import { ThemeSwitcher } from '@/ui/theme-switcher';

// 开发者房间：控件在这里**逐件验证**；业务代码只允许使用登记过的控件。
// 容器宽度必须与真实壳（src/app/shell.tsx）一致：都是 1280px。
// 对不上的后果已经踩过——房间锁 1100px，页面里为了塞下三栏只能自己加负边距外扩，
// 于是「房间里量到的列宽/列数」在真站不成立，量出来的指标是假的。
//
// 导航分三组，组内按编号升序。为什么分组而不是一大排：
//   ① 顺序 == 编号（编号本身就是我们定的顺序；以前 12–15 插在 08 后面、09/10/11 甩在最后，
//      看起来就是乱的）；② 页面只会继续变多，分组之后每组自己折行，不会把整排挤成一坨。
type PageEntry = { key: string; title: string; el: () => React.ReactNode };
type NavGroup = { label: string; pages: PageEntry[] };

const GROUPS: NavGroup[] = [
  {
    label: '基座',
    pages: [
      { key: '00-showroom', title: '00 · 样板间', el: () => <ShowroomPage /> },
      { key: '01-interactive', title: '01 · 交互与表单', el: () => <InteractivePage /> },
      { key: '02-overlay', title: '02 · 浮层与反馈', el: () => <OverlayPage /> },
      { key: '03-navigation', title: '03 · 导航与结构', el: () => <NavigationPage /> },
      { key: '04-display', title: '04 · 展示与状态', el: () => <DisplayPage /> },
    ],
  },
  {
    label: '我们的件',
    pages: [
      { key: '05-our-components', title: '05 · 我们的组合件', el: () => <OurComponentsPage /> },
      { key: '06-user-styles', title: '06 · 用户向风格候选', el: () => <UserStylesPage /> },
      { key: '07-user-render', title: '07 · 用户身份控件', el: () => <UserRenderPage /> },
      { key: '08-comments', title: '08 · 评论区', el: () => <CommentsPage /> },
    ],
  },
  {
    label: '业务页面',
    pages: [
      { key: '09-rich', title: '09 · 富文本与图片', el: () => <RichPage /> },
      { key: '10-messages', title: '10 · 信息中心', el: () => <MessagesPage /> },
      { key: '11-profile', title: '11 · 个人主页', el: () => <ProfilePage /> },
      { key: '12-topic', title: '12 · 帖子内容页', el: () => <TopicPage /> },
      { key: '13-issue', title: '13 · 问题反馈', el: () => <IssuePage /> },
      { key: '14-home', title: '14 · 首页信息流', el: () => <HomePage /> },
      { key: '15-admin', title: '15 · 管理后台', el: () => <AdminPage /> },
      { key: '16-auth', title: '16 · 登录与注册', el: () => <AuthPage /> },
    ],
  },
];

// 扁平查找表**由分组推导**：一处定义两处用，不会再出现「加了页面忘了挂进导航」
const PAGES: Record<string, PageEntry> = Object.fromEntries(
  GROUPS.flatMap((group) => group.pages.map((p) => [p.key, p] as const)),
);

export function DevRoom({ page }: { page: string }) {
  const current = PAGES[page] ?? PAGES['00-showroom']!;
  return (
    <div className='min-h-screen bg-background text-foreground'>
      <header className='border-b border-border bg-background'>
        <div className='mx-auto flex w-full max-w-[1280px] flex-col gap-2 px-5 py-4'>
          <h1 className='text-lg font-semibold'>开发者房间 · DevRoom</h1>
          <p className='text-[13px] leading-relaxed text-muted-foreground'>
            这里逐个验证控件。
            <strong className='font-medium text-foreground'>
              业务代码只允许使用已登记（src/devroom/registry.ts）的控件
            </strong>
            ；需要新控件 → 先在本房间加一页验证 → 登记 → 才能用。未登记会被 pnpm gate:controls 挡住。
          </p>
          <nav aria-label='开发者房间页面' className='flex flex-col gap-2 pt-1'>
            {GROUPS.map((group) => (
              <Island key={group.label}>
                <div className='flex flex-wrap items-center gap-1.5 px-2.5 py-2'>
                  <span className='shrink-0 pr-1 text-[11px] font-medium text-muted-foreground'>{group.label}</span>
                  {group.pages.map((p) => (
                    <Button key={p.key} href={appPath('?page=' + p.key)} active={p.key === page}>
                      {p.title}
                    </Button>
                  ))}
                </div>
              </Island>
            ))}
            <div className='flex flex-wrap items-center justify-end gap-3 text-xs text-muted-foreground'>
              <span>已登记控件：{VERIFIED.length} 个</span>
              <ThemeSwitcher />
            </div>
          </nav>
        </div>
      </header>
      <main className='mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-5 py-5'>{current.el()}</main>
    </div>
  );
}
