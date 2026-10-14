import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Search, X } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { UserBadge } from '@/ui/user/user-badge';
import { TopicRow, type TopicRowData } from '@/ui/topic/topic-row';
import { CompactRowSkeleton } from '../14-home/states';
// 空态的唯一实现在 @/ui/state/empty（14-home/states.tsx 里那份 EmptyState 已删）
import { Empty } from '@/ui/state/empty';
import { cn } from '@/lib/utils';
import { SEARCH_SCOPE, type SearchUser } from './data';

// 搜索面板（全站的搜索体验唯一实现）。
// **它不是一个独立页面**：真站把搜索内嵌在首页（用户要求不单独开一个页面，router 的 /search 只做重定向），
// 所以这里交付的是「首页顶部那一块」的完整件：搜索栏 + 两档结果（帖子 / 用户）+ 四态。
//
// 契约：GET /api/v1/search?q=&type=topics|users&limit=&cursor=
//   · type=topics 的条目与信息流**同一个形状** → 直接喂 @/ui/topic/topic-row（不是搜索结果专属的行）；
//   · type=users 的条目是 user.SearchItem（id/handle/nickname/avatar/level/ambiguous）。
//
// 移动端折叠（下面这些 className 就是全部实现，不是另写一套窄屏组件）：
//   · 搜索按钮与「清除」只剩图标（文字 hidden sm:inline，aria-label 保住无障碍名）；
//   · 两档页签后面的计数收起来（<sm 只留「帖子 / 用户」四个字）；
//   · 搜索栏在 <sm 占满一行，≥sm 固定 320px（与首页的筛选条并排时不会被挤成 240px 的库默认宽）。
//   为什么要靠断点而不是「窄屏用另一个组件」：同一份 DOM 只有一处行为，盲审拿 390px 视口打开就能验。
export type SearchTab = 'topics' | 'users';
export type SearchState = 'idle' | 'loading' | 'ready' | 'error';

export type SearchPanelProps = {
  /** 输入框里的字（受控；提交由 onSubmit 决定，不是输入即搜） */
  q: string;
  onQChange: (next: string) => void;
  onSubmit: () => void;
  /** 清空输入并退出搜索态（空态里的「清除搜索」也走它） */
  onClear: () => void;
  tab: SearchTab;
  onTabChange: (next: SearchTab) => void;
  state: SearchState;
  /** 已提交关键词的帖子结果（state=ready 时才有意义） */
  topics: TopicRowData[];
  users: SearchUser[];
  error?: string;
  onRetry?: () => void;
  /** 外层盒子的额外类名（顶栏那份用它把面板变成浮层；首页不传 = 逐字不变） */
  className?: string;
};

export function SearchPanel(props: SearchPanelProps) {
  const { q, onQChange, onSubmit, onClear, tab, onTabChange, state, topics, users, error, onRetry, className } = props;
  const counts: Record<SearchTab, number> = { topics: topics.length, users: users.length };
  const rows = tab === 'topics' ? topics : users;

  return (
    <section className={cn('flex flex-col gap-3', className)}>
      <div className='flex flex-wrap items-center gap-2 border-y border-border py-2'>
        {/* 用原生 form 接 Enter：Ring 的 Input 没有 onPressEnter，手写 onKeyDown 要赌它透传 DOM 属性 */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          data-testid='search-form'
          className='flex w-full min-w-0 items-center gap-2 sm:w-[320px]'
        >
          <Input
            size={Size.FULL}
            value={q}
            onChange={(e) => onQChange(e.target.value)}
            placeholder='搜索帖子、作者…'
            aria-label='搜索帖子或用户'
            autoComplete='off'
            data-testid='search-input'
          />
          <Button type='submit' inline={false} height={ControlsHeight.S} icon={icon16(Search)} aria-label='搜索' data-testid='search-submit'>
            <span data-testid='search-submit-label' className='hidden sm:inline'>搜索</span>
          </Button>
        </form>
        {q !== '' ? (
          <Button
            inline={false}
            height={ControlsHeight.S}
            icon={icon16(X)}
            aria-label='清空搜索词'
            title='清空搜索词'
            data-testid='search-clear'
            onClick={onClear}
          >
            <span className='hidden sm:inline'>清除</span>
          </Button>
        ) : null}
        {/* 两档：**帖子 / 用户**。计数在窄屏收起（<sm 只留这两个词） */}
        <Tabs selected={tab} onSelect={(id: string) => onTabChange(id as SearchTab)}>
          <Tab
            id='topics'
            title={<span data-testid='search-tab-topics'>帖子<span data-testid='search-count-topics' className='hidden pl-1 text-muted-foreground sm:inline'>{counts.topics}</span></span>}
          />
          <Tab
            id='users'
            title={<span data-testid='search-tab-users'>用户<span data-testid='search-count-users' className='hidden pl-1 text-muted-foreground sm:inline'>{counts.users}</span></span>}
          />
        </Tabs>
      </div>

      {state === 'idle' ? (
        <div data-testid='search-idle' className='rounded-lg border border-dashed border-border px-4 py-6 text-center'>
          <p className='m-0 text-[14px] text-foreground'>搜帖子，或搜人</p>
          <p className='mx-auto mt-1 max-w-[46ch] text-[12px] leading-relaxed text-muted-foreground'>
            {SEARCH_SCOPE[tab]}。输入关键词后回车或点「搜索」。
          </p>
        </div>
      ) : null}

      {state === 'loading' ? (
        <div data-testid='search-loading' aria-busy='true' aria-label='正在搜索' className='rounded-lg border border-border bg-card p-0.5'>
          <span className='block px-3 py-1 text-[11px] text-muted-foreground'>正在搜索…</span>
          <CompactRowSkeleton />
          <CompactRowSkeleton />
          <CompactRowSkeleton />
          <CompactRowSkeleton />
        </div>
      ) : null}

      {state === 'error' ? (
        <div data-testid='search-error' className='flex flex-col items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/8 px-4 py-8 text-center'>
          <span className='text-[14px] text-foreground'>搜索失败了</span>
          <span className='max-w-[46ch] text-[12px] leading-relaxed text-muted-foreground'>
            {error ?? '服务端没有返回结果。搜索是只读操作，重试一次即可；不用刷新整页。'}
          </span>
          {onRetry ? <Button onClick={onRetry}>重试</Button> : null}
        </div>
      ) : null}

      {state === 'ready' && rows.length === 0 ? (
        <span data-testid='search-empty' className='contents'>
        <Empty
          title={tab === 'topics' ? '没有匹配的帖子' : '没有匹配的用户'}
          hint={
            tab === 'topics'
              ? '换个词试试；' + SEARCH_SCOPE.topics + '。'
              : '换个词试试；' + SEARCH_SCOPE.users + '。'
          }
          action={<Button onClick={onClear}>清除搜索</Button>}
        />
        </span>
      ) : null}

      {state === 'ready' && rows.length > 0 && tab === 'topics' ? (
        <ul data-testid='search-results-topics' className='m-0 list-none overflow-hidden rounded-lg border border-border bg-card p-0'>
          {topics.map((t) => (
            <li key={t.id}>
              <TopicRow topic={t} />
            </li>
          ))}
        </ul>
      ) : null}

      {state === 'ready' && rows.length > 0 && tab === 'users' ? (
        <ul data-testid='search-results-users' className='m-0 list-none overflow-hidden rounded-lg border border-border bg-card p-0'>
          {users.map((u) => (
            <li key={u.id} className='border-b border-border last:border-b-0 hover:bg-muted/40'>
              {u.href ? (
                <a href={u.href} className='flex items-center gap-2 px-4 py-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'>
                  <UserRow user={u} />
                </a>
              ) : (
                <span className='flex items-center gap-2 px-4 py-3'>
                  <UserRow user={u} />
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** 一行用户：头像 + 昵称 + @handle；重名的那几位要一眼看出来（后端用 ambiguous 标记）。 */
function UserRow({ user }: { user: SearchUser }) {
  return (
    <>
      <UserBadge user={{ handle: user.handle, nickname: user.nickname, avatar: user.avatar }} size='sm' showHandle />
      {user.ambiguous ? (
        <span
          className='ml-auto shrink-0 rounded-[3px] bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'
          title='昵称重名：靠 @handle 区分（契约里的 ambiguous）'
        >
          重名
        </span>
      ) : null}
    </>
  );
}
