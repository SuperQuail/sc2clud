import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { cn } from '@/lib/utils';

// 后台侧边导航。**后台专用件**（已登记在 devroom/registry.ts 的 15-admin 下，见 side-nav 条目）：
// 它是为管理后台的「12 项 / 4 组 / 按权限点渲染」这一种场景做的，不是通用房子件 ——
// 「房子件」的判据是多个域都用；提到 src/ui 会让别人以为能直接拿去用（Lead 2026-10-13 裁定：先不提升）。
//
// 形态（调研与选型见 admin-map.md / 回报）：**平铺文字行 + 分组小标题 + 选中=背景块+左侧色条+文字加重**。
// 上一版是「一竖排 Ring Button」——每一项都被一圈边框框起来，用户明确否掉了那种做法（像一排按钮，不像导航）。
// 现在：行本身没有边框，只有悬停/选中的背景；行仍用 Ring 的 ghost Button 做基座，
// 键盘、焦点、Enter/Space 的行为归控件库，外观由我们用令牌控制（与 @/ui/nav/icon-tabs 同一套做法）。
//
// 可访问性：外层 <nav aria-label>；每一项是真正的 button（可 Tab、可 Enter/Space）；
// 选中项额外带 aria-current='page'（视觉上是背景块 + 左侧 2px 色条，读屏也能知道「当前在哪」）。
// 原来这里有一个可选的 count（用房子件 CountBadge 渲染），唯一的使用者是 mock 的假数字
// （users 12 / review 4 …，见 nav.ts 的说明）。假数字摘掉之后它就没有使用者了，所以连 prop 一起删 ——
// 留着一个「谁来填」的槽位，下一个人就会再塞一个假数进去。
export type SideNavItem = { key: string; label: string };
export type SideNavGroup = { title: string; items: SideNavItem[] };

export function SideNav({
  groups,
  value,
  onChange,
  ariaLabel,
}: {
  groups: SideNavGroup[];
  value: string;
  onChange: (key: string) => void;
  ariaLabel: string;
}) {
  return (
    <nav aria-label={ariaLabel} className='flex flex-col gap-3'>
      {groups.map((g) => (
        // 窄屏（<lg）整组折行成横排，宽屏是竖列 —— 外壳的栅格在 lg 才分栏，这里跟着它走
        <div key={g.title} className='flex flex-wrap items-center gap-x-1.5 gap-y-0.5 lg:flex-col lg:items-stretch lg:gap-x-0'>
          <span className='w-full px-2 pt-1 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground lg:w-auto'>
            {g.title}
          </span>
          {g.items.map((it) => {
            const active = value === it.key;
            return (
              <span
                key={it.key}
                className={cn(
                  'relative flex min-w-0 items-center rounded-md lg:w-full',
                  active ? 'bg-muted' : 'hover:bg-muted/60',
                )}
              >
                {active ? (
                  <span aria-hidden className='pointer-events-none absolute inset-y-1 left-0 w-[2px] rounded-full bg-primary' />
                ) : null}
                <Button
                  ghost
                  inline={false}
                  height={ControlsHeight.S}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => onChange(it.key)}
                  className='w-full justify-start pl-3'
                >
                  <span className={cn('text-[13px]', active ? 'font-medium text-foreground' : 'text-muted-foreground')}>
                    {it.label}
                  </span>
                </Button>
              </span>
            );
          })}
        </div>
      ))}
    </nav>
  );
}