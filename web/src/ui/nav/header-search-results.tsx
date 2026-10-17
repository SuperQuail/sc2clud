import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { qk } from '@/lib/query/keys';
import { searchTopics, type Topic as ApiTopic } from '@/lib/api/forum';
import { searchUsers } from '@/lib/api/user';
import { appPath } from '@/lib/url';
import { formatTime } from '@/lib/format';
import type { TopicRowData } from '@/ui/topic/topic-row';
import { KIND_TAG, TOPIC_KIND_LABEL } from '@/devroom/pages/14-home/topic-kind';
import { toCardTopic } from '@/routes/_parts/mappers';
import { SearchPanel, type SearchState, type SearchTab } from '@/devroom/pages/19-search/search-panel';

// 顶栏搜索的**结果区**。它与首页那一块是**同一个件**（19-search 的 SearchPanel），
// 所以两处的两档页签、四态、空态、窄屏折叠全都只有一份实现（清单 §0 的同源要求）。
//
// 单独一个文件是为了**懒加载**：SearchPanel 为了 Tabs 静态拖进 react-virtualized + sniffr + combokeys
// （实测 53 KB gzip，见 routes/home.tsx 的注释），而首屏预算只有 150 KB。顶栏是首屏的一部分，
// 所以「点开搜索」才去下载这一块 —— 没点开的人一个字节都不用付。
//
// 取数在这里（结果区自己拿着草稿态）：输入即搜会让每个字都发一次请求，所以只有回车 / 点「搜索」才发。
export function HeaderSearchResults({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<SearchTab>('topics');
  const searching = q !== '';

  const topics = useQuery({
    queryKey: [...qk.search('topics', q), 'header'],
    queryFn: ({ signal }) => searchTopics(q, null, signal),
    enabled: searching && tab === 'topics',
  });
  // 用户档没有游标（一次一页，上限 20）
  const users = useQuery({
    queryKey: qk.search('users', q),
    queryFn: ({ signal }) => searchUsers(q, 20, signal),
    enabled: searching && tab === 'users',
    staleTime: 30_000,
  });

  // **展开即聚焦**（用户原话）：Ring 的 Input 吃不吃 autoFocus 不可靠，所以在自己的容器里显式聚焦一次。
  useEffect(() => {
    box.current?.querySelector('input')?.focus();
  }, []);

  const active = tab === 'topics' ? topics : users;
  const state: SearchState = !searching ? 'idle' : active.isError ? 'error' : active.isPending ? 'loading' : 'ready';

  return (
    <div ref={box}>
    <SearchPanel
      className='max-h-[70vh] overflow-y-auto'
      q={draft}
      onQChange={setDraft}
      onSubmit={() => setQ(draft.trim())}
      onClear={() => {
        setDraft('');
        setQ('');
        onClose();
      }}
      tab={tab}
      onTabChange={setTab}
      state={state}
      topics={(topics.data?.items ?? []).map(toRow)}
      users={(users.data ?? []).map((u) => ({ ...u, id: String(u.id), href: appPath('u/' + encodeURIComponent(u.handle)) }))}
      error={state === 'error' ? errorText(active.error) : undefined}
      onRetry={() => void active.refetch()}
    />
    </div>
  );
}

// 结果行的映射：与 routes/home.tsx 的 toSearchRows 是同一件事（那边只是多了首页的排版参数）。
// 两处都走 mappers.toCardTopic（hash → /img/<hash>），不各自拼头像地址。
function toRow(t: ApiTopic): TopicRowData {
  const c = toCardTopic(t);
  return {
    id: c.id,
    title: c.title,
    tags: [{ text: TOPIC_KIND_LABEL[c.kind], type: KIND_TAG[c.kind] }],
    author: { nickname: c.author.nickname, avatar: c.author.avatar, role: c.author.role ?? null, title: c.author.title ?? null },
    replies: c.reply_count,
    views: c.view_count,
    lastReplyAt: formatTime(c.last_reply_at),
    href: appPath('t/' + encodeURIComponent(c.id)),
  };
}

/** 错误态要一句人话：后端的 message 比 String(err) 有用（ErrorState 里也是这条口径）。 */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : '搜索失败，请重试。';
}
