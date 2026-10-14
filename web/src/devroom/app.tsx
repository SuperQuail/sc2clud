import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import { VERIFIED } from './registry';
import { appPath } from '@/lib/url';

// 页面**按需加载**（React.lazy），不是全部静态 import。
// 为什么（2026-10-13，房间因此白屏过多次）：静态 import 全部页面时，**任一页面里的一处模块错误**
// （缺导出、类型不符、语法错）都会让整个 bundle 加载失败 —— 结果不是「那一页坏了」，而是「房间整个打不开」，
// 连「哪一页坏了」都看不出来（并发施工时这不是小概率事件，一天撞了三次）。
// 改成 lazy 之后：坏的那一页只在点开它时失败，其余页面照常可用。
const ShowroomPage = lazy(() => import('./pages/00-showroom'));
const InteractivePage = lazy(() => import('./pages/01-interactive'));
const OverlayPage = lazy(() => import('./pages/02-overlay'));
const NavigationPage = lazy(() => import('./pages/03-navigation'));
const DisplayPage = lazy(() => import('./pages/04-display'));
const OurComponentsPage = lazy(() => import('./pages/05-our-components'));
const UserStylesPage = lazy(() => import('./pages/06-user-styles'));
const UserRenderPage = lazy(() => import('./pages/07-user-render'));
const CommentsPage = lazy(() => import('./pages/08-comments'));
const RichPage = lazy(() => import('./pages/09-rich'));
const MessagesPage = lazy(() => import('./pages/10-messages'));
const ProfilePage = lazy(() => import('./pages/11-profile'));
const TopicPage = lazy(() => import('./pages/12-topic'));
const IssuePage = lazy(() => import('./pages/13-issue'));
const HomePage = lazy(() => import('./pages/14-home'));
const AdminPage = lazy(() => import('./pages/15-admin'));
const AuthPage = lazy(() => import('./pages/16-auth'));
const AppealPage = lazy(() => import('./pages/17-appeal'));
const ComposePage = lazy(() => import('./pages/18-compose'));
const SearchPage = lazy(() => import('./pages/19-search'));
import { ThemeSwitcher } from '@/ui/theme-switcher';

// 开发者房间：控件在这里**逐件验证**；业务代码只允许使用登记过的控件。
// 容器宽度必须与真实壳（src/app/shell.tsx）一致：都是 1280px。
// 对不上的后果已经踩过——房间锁 1100px，页面里为了塞下三栏只能自己加负边距外扩，
// 于是「房间里量到的列宽/列数」在真站不成立，量出来的指标是假的。
//
// 导航分三组，组内按编号升序。为什么分组而不是一大排：
//   ① 顺序 == 编号（编号本身就是我们定的顺序；以前 12–15 插在 08 后面、09/10/11 甩在最后，
//      看起来就是乱的）；② 页面只会继续变多，分组之后每组自己折行，不会把整排挤成一坨。
type PageEntry = { key: string; title: string; el: () => ReactNode };

// 一页坏了不该让整个房间打不开。
// lazy 解决了「模块加载失败」（坏的那页只在点开它时失败），这一层解决「渲染时抛错」。
// 两者都指向同一件事：**并发施工时，坏掉的范围要能被限制在一页之内**，
// 而且要能看见「哪一页坏了、错在哪」—— 白屏什么信息都不给。
class PageBoundary extends Component<{ pageKey: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { pageKey: string }) {
    if (prev.pageKey !== this.props.pageKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (this.state.error) {
      return (
        <div className='flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/8 p-4'>
          <span className='text-[15px] font-medium text-foreground'>这一页渲染失败了，其它页面仍然可用。</span>
          <pre className='whitespace-pre-wrap break-all text-[12px] text-muted-foreground'>{String(this.state.error)}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}
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
      // 17-appeal / 18-compose 的导航条目由 Lead 加（app.tsx 是共享文件，避免施工者抢同一个文件）。
      { key: '17-appeal', title: '17 · 申诉与反馈', el: () => <AppealPage /> },
      { key: '18-compose', title: '18 · 发帖', el: () => <ComposePage /> },
      { key: '19-search', title: '19 · 搜索', el: () => <SearchPage /> },
    ],
  },
];

// 扁平查找表**由分组推导**：一处定义两处用，不会再出现「加了页面忘了挂进导航」
const PAGES: Record<string, PageEntry> = Object.fromEntries(
  GROUPS.flatMap((group) => group.pages.map((p) => [p.key, p] as const)),
);

export function DevRoom({ page }: { page: string }) {
  const current = PAGES[page] ?? PAGES['00-showroom']!;
  const [blockedHref, setBlockedHref] = useState<string | null>(null);

  // 房间内的站内链接一律不导航到房间外。
  // 理由（盲审一号报的「所有站内链接都是死路」）：房间部署在**旧站域名**下（/dev/devroom/），
  // 像 /p/xxx、/settings 这类路径会被浏览器解析到旧站，旧站没有这些路由 -> 落到一个与房间无关的 404，
  // 而且那个 404 页上的链接也 404、用户**回不到刚才在看的页面**。
  // 拦在一个地方，比在 17 个页面里逐个改链接可靠：新加的页面自动受保护。
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      const a = el && typeof el.closest === 'function' ? (el.closest('a') as HTMLAnchorElement | null) : null;
      if (!a) return;
      const href = a.getAttribute('href') ?? '';
      if (!href || href.startsWith('#') || /^https?:/i.test(href)) return; // 锚点与外链放行
      if (href.startsWith('?') || href.includes('page=')) return;          // 房间内链接放行
      e.preventDefault();
      setBlockedHref(href); // 明确反馈，而不是静默跳到旧站 404
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);
  return (
    <div className='min-h-screen bg-background text-foreground'>
      {blockedHref ? (
        <div role='status' className='border-b border-border bg-muted px-5 py-2 text-[13px] text-foreground'>
          这句话是设计稿里的站内链接（{blockedHref}），**本房间不导航到房间外** —— 真实站点里它会跳到对应页面。
          <Button inline onClick={() => setBlockedHref(null)}>知道了</Button>
        </div>
      ) : null}
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
          {/* 盲审一号（2026-10-13）：「点了没反应」与「坏了」与「我没权限」三者分不清。
              这是设计稿，多数按钮本来就没有真实动作 —— 与其在每个按钮上写一遍，不如在房间唯一的位置说明一次。 */}
          <p className='rounded-md border border-dashed border-border px-2.5 py-1.5 text-[12px] leading-relaxed text-muted-foreground'>
            <strong className='font-medium text-foreground'>这是设计稿：</strong>
            页面里的按钮大多不接后端动作，<strong className='font-medium text-foreground'>点了没反应 ≠ 坏了</strong>；
            房间还没有的页面/接口会标 <span className='rounded-sm bg-muted px-1 text-[11px]'>未做</span>
            ，房间里的站内链接一律指向房间内的页面（不会把你带到站外）。
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
      <main className='mx-auto flex w-full max-w-[1280px] flex-col gap-4 px-5 py-5'>
        {/* 加载态也要有明确文案：lazy 之后首次进某页会有一瞬空白，不给文案就等于白屏 */}
        <Suspense fallback={<div className='p-4 text-[13px] text-muted-foreground'>正在加载这一页…</div>}>
          <PageBoundary pageKey={current.key}>{current.el()}</PageBoundary>
        </Suspense>
      </main>
    </div>
  );
}