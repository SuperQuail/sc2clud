import { useEffect, useMemo, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { roomHref } from '@/devroom/room-links';
import { KV, Panel, Pill, ScreenHead, Toolbar } from '@/devroom/pages/15-admin/bits';
import { HeaderSearch } from '@/ui/nav/header-search';
import { SearchPanel, type SearchState, type SearchTab } from './search-panel';
import { SEARCH_SCOPE, searchTopics, searchUsers, toTopicRow } from './data';
import { TOPICS } from '../14-home/mock';

// DevRoom 19 · 搜索（内嵌在首页的那一块）。
// 实际站现在的搜索是**临时简化版**：只有帖子一档、没有独立的加载/空/错误态、窄屏下按钮文字把输入框挤窄。
// 这一版补齐四件事（用户 2026-10-14 点名的那四条）：两档结果（帖子 / 用户）、空态、加载态、移动端折叠。
//
// **它不是一个页面**：真站把搜索内嵌在首页（用户明确要求不单独开页面，router 的 /search 只做重定向），
// 所以这里交付的件是 <SearchPanel>（见 ./search-panel），本页只是它的四态与窄屏演示台。
// 深链（?q=&type=&state=）只在**挂载时**读一次，之后由状态驱动 —— 与 14-home 的 ?view= 同一套做法：
// 真页面里这一段就是 useSearchParams 的初始值（「URL 即状态」，前端方案 §6）。
// 它同时是出图/盲审的入口：四态各有一条 URL，不必靠手点。
function initFromUrl(): { q: string; type: SearchTab; state: SearchState } {
  const p = typeof location === 'undefined' ? new URLSearchParams() : new URLSearchParams(location.search);
  const q = (p.get('q') ?? '').trim();
  const s = p.get('state');
  return {
    q,
    type: p.get('type') === 'users' ? 'users' : 'topics',
    state: s === 'loading' || s === 'error' ? s : q === '' ? 'idle' : 'ready',
  };
}

// 顶栏那一块（D11）：**真件**（@/ui/nav/header-search）挂在房间的假数据上。
// 它自己不 fetch —— 取数走 lib/api（只允许 client.ts 发请求），所以这里在页面级别把
// GET /api/v1/search 换成 19-search 的假数据；产品入口不需要这一段，接线由 shell 负责（见进度文件的阻塞）。
function useSearchStub() {
  useEffect(() => {
    const real = window.fetch;
    window.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://room');
      if (!url.pathname.endsWith('/api/v1/search')) return real(input as RequestInfo);
      // 后端的用户档条目是 SearchItem（id 是数字）；帖子档是 TopicCardDTO（与信息流同形）
      const data =
        url.searchParams.get('type') === 'users'
          ? searchUsers(url.searchParams.get('q') ?? '').map((u, i) => ({ ...u, id: i + 1 }))
          : searchTopics(url.searchParams.get('q') ?? '').map((t) => {
              const row = TOPICS.find((x) => x.id === t.id);
              return {
                id: t.id,
                kind: row?.kind ?? 'discussion',
                title: t.title,
                excerpt: t.excerpt,
                board: { slug: row?.board.slug ?? 'custom-campaign', name: row?.board.name ?? '自制战役' },
                author: { handle: 'demo-admin', nickname: t.author.nickname, avatar_hash: null, avatar_small_hash: null },
                reply_count: t.reply_count,
                like_count: t.like_count,
                view_count: t.view_count,
                pinned: false,
                featured: false,
                locked: false,
                cover_hash: null,
                created_at: t.created_at,
                last_reply_at: t.last_reply_at,
              };
            });
      return new Response(JSON.stringify({ data, next_cursor: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof window.fetch;
    return () => {
      window.fetch = real;
    };
  }, []);
}

/**
 * 出图用：`?click=<css 选择器>` 打开后自动点它一次。
 * 为什么要有它：顶栏搜索是**点开才有**的浮层，静态截图拍不到展开态（出图脚本没法往页面里注入脚本）。
 * 只在带参数时生效，参数还会从地址栏里去掉 —— 它不是一个产品行为。
 */
function useAutoClick() {
  useEffect(() => {
    const el = new URLSearchParams(location.search).get('click');
    if (!el) return;
    const t = window.setTimeout(() => {
      document.querySelector(el)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }, 400);
    return () => window.clearTimeout(t);
  }, []);
}

export default function SearchPage() {
  useSearchStub();
  useAutoClick();
  const [init] = useState(initFromUrl);
  const [draft, setDraft] = useState(init.q);
  const [query, setQuery] = useState(init.q);
  const [tab, setTab] = useState<SearchTab>(init.type);
  const [state, setState] = useState<SearchState>(init.state);
  // 演示用：真实实现里「加载 → 结果 / 空 / 失败」是网络决定的，房间里用这个开关走一遍
  const [failNext, setFailNext] = useState(false);

  // 结果按**已提交**的关键词算，不是按输入框里的字 —— 输入即搜会让每一次击键都变成一次请求
  const topics = useMemo(
    () => (state === 'ready' ? searchTopics(query).map((t) => toTopicRow(t, roomHref('12-topic'))) : []),
    [query, state],
  );
  const users = useMemo(
    () => (state === 'ready' ? searchUsers(query).map((u) => ({ ...u, href: roomHref('11-profile') })) : []),
    [query, state],
  );

  function run(next: string) {
    setQuery(next);
    setState('loading');
    window.setTimeout(() => setState(failNext ? 'error' : 'ready'), 600);
  }

  function submit() {
    const next = draft.trim();
    if (next === '') {
      clear();
      return;
    }
    run(next);
  }

  function clear() {
    setDraft('');
    setQuery('');
    setState('idle');
  }

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='搜索'
        note='首页顶部那一块（不单独开页面）。契约：GET /api/v1/search?q=&type=topics|users&limit=&cursor= —— 这里不 fetch，结果来自 15-admin / 14-home 的同一份假数据。'
        actions={<Pill tone='outline'>{'当前档：' + (tab === 'topics' ? '帖子' : '用户')}</Pill>}
      />

      <Panel
        title='顶栏搜索（D11：不换页，就地展开）'
        note='下面是真件 @/ui/nav/header-search —— 产品里它长在 app/shell.tsx 的顶栏里（那个文件由 Lead 管）。点它不会离开这一页，搜索栏与结果就地展开；结果区是懒加载的（首屏预算），所以第一次点开有一瞬「正在打开搜索…」。'
      >
        <div className='flex flex-wrap items-center gap-4'>
          {/* 模拟顶栏那一行的底色与高度，好看出浮层相对按钮的位置 */}
          <span className='flex items-center gap-1 rounded-md border border-border bg-background px-3 py-2'>
            <span className='pr-2 text-[13px] text-muted-foreground'>模拟顶栏：</span>
            <HeaderSearch />
          </span>
          <span className='text-[11px] leading-relaxed text-muted-foreground'>
            键入「战役」回车：结果就地出现在浮层里（帖子档），切「用户」档看搜人；
            点浮层外面或按 Esc 收起；<b>地址栏不会变、页面不会跳</b>。
          </span>
        </div>
      </Panel>

      <Toolbar>
        <Toggle checked={failNext} onChange={(e) => setFailNext(e.target.checked)}>
          下一次搜索模拟失败（演示错误态）
        </Toggle>
        <span className='text-[11px] text-muted-foreground'>
          试这些词：<code className='rounded-sm bg-muted px-1'>战役</code>
          <code className='ml-1 rounded-sm bg-muted px-1'>demo</code>
          <code className='ml-1 rounded-sm bg-muted px-1'>陆战</code>
          <code className='ml-1 rounded-sm bg-muted px-1'>不存在的词</code>（空态）
        </span>
        <Button disabled={state === 'idle' && query === ''} onClick={clear}>清空</Button>
      </Toolbar>

      <SearchPanel
        q={draft}
        onQChange={setDraft}
        onSubmit={submit}
        onClear={clear}
        tab={tab}
        onTabChange={setTab}
        state={state}
        topics={topics}
        users={users}
        error={failNext ? 'HTTP 500 common.internal（服务端故障，details 只进日志）' : undefined}
        onRetry={() => run(query)}
      />

      <Panel title='移动端折叠（<sm，即 <640px）' note='不另写一套窄屏组件：折叠全部靠断点类名，所以 390px 视口打开本页看到的**就是**真站的那一套'>
        <KV k='搜索栏' v='<sm 占满一行 → ≥sm 固定 320px' hint='首页的筛选条与搜索栏并排，定宽是为了不被挤成 Ring Input 库默认的 240px' />
        <KV k='搜索 / 清除按钮' v='<sm 只剩图标（文字 hidden sm:inline）' hint='图标按钮必须有 aria-label + title，否则读屏读不出来（registry 里 button 那条的欠账成因）' />
        <KV k='两档页签的计数' v='<sm 收起（只留「帖子 / 用户」）' hint='结果条数在窄屏不是决策信息，标题放得下更重要' />
        <KV k='结果行' v='帖子行右侧的回复/赞/浏览在窄屏收起' hint='@/ui/topic/topic-row 自己的 sm:flex 行为，本页不重复实现' />
      </Panel>

      <Panel title='契约（照后端抄，不照设计稿猜）' note='forum/internal/app/search_endpoint.go + forum/internal/user/service.go:76'>
        <KV k='端点' v='GET /api/v1/search' hint='q 必填（空 → 400 common.invalid_input「搜索词不能为空」）' />
        <KV k='type' v='topics | users' hint='其它值**直接 400**，不静默当成 topics（否则用户以为在搜人、其实在看帖子）' />
        <KV k='limit' v='默认 10，上限 20' hint='maxSearchLimit = 20' />
        <KV k='cursor' v='不透明游标' hint='搜索按 (rank, id) 排，游标自带 rank + tier；前端只原样带回、不解析' />
        <KV k='帖子条目' v='TopicCardDTO（与信息流同一个形状）' hint='id / kind / title / excerpt / board{slug,name} / author{handle,nickname,avatar_hash,avatar_small_hash} / reply_count / like_count / view_count / last_reply_at / created_at / pinned / featured / locked / cover_hash' />
        <KV k='用户条目' v='SearchItem' hint='id / handle / nickname / avatar / level / ambiguous' />
        <KV k='用户档的 q' v='1–32 个字' hint='超长返回 400（user.Search 的校验）；昵称重名时后端给 ambiguous=true，前端必须用 @handle 区分' />
      </Panel>

      <Panel title='这一版明确没做' note='设计稿别装作做完了；下面每条都是下一次接后端时要补的'>
        <ul className='m-0 flex flex-col gap-1 pl-4 text-[12px] leading-relaxed text-muted-foreground'>
          <li>没接后端：结果来自 14-home 的假数据，过滤是前端子串匹配（真检索是 bigram + tsvector 两档）。</li>
          <li>没做命中词高亮：后端 <b>不返回命中片段</b>（TopicCardDTO 里没有 highlight 字段），要做就得先加契约。</li>
          <li>没做搜索历史 / 热门词：老站有一列，但新契约里没有端点。</li>
          <li>没做键盘上下键选结果：等有真结果集再补（现在只有 12 条假数据，做了也是假的）。</li>
          <li>没做「搜索权重」展示：rank 只在游标里，后端明确不暴露给前端。</li>
        </ul>
        <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>
          两档的口径：{SEARCH_SCOPE.topics}；{SEARCH_SCOPE.users}。
        </p>
      </Panel>
    </div>
  );
}
