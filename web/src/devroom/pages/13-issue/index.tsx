import { useEffect, useMemo, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { SearchX } from 'lucide-react';
import { cn } from '@/lib/utils';
import { IssueCard } from '../12-topic/_task/issue-card';
import { ISSUE_STATUS_LABEL, type IssueStatus, type IssueSummary } from '../12-topic/_task/types';
import { COMMENTS, ISSUES, ME, MENTION_CANDIDATES } from './data';
import { IssueDetail } from './issue-detail';
import { IssueFilterBar, SORT_LABEL, type Scope, type SortKey } from './issue-filter-bar';
import { NewIssuePanel } from './new-issue-panel';
import { matchesQuery, parseQuery } from './query';
import { IssueKindButton, KINDS, TopicTaskTabs, type IssueKind } from './shared';
import type { IssueComment, IssueDetail as Detail } from './types';

// DevRoom 13 · 问题反馈页（仿 GitHub Issues + 帖子页同源的两个大按钮）。
// 界面文案不出现「Issue」：面向的是普通玩家（用户 2026-10-12 明确提过）。内部类型名保留 Issue* 与契约对齐。
// 数据全在本目录的 mock 里，读写都用 useState：新建反馈 / 发评论会**当场**出现在列表里，
// 用来证明交互闭环（真接口见后端方案 §21.2「资源帖 issue」段）。

/** 展示用的时间串：今天 / 昨天 / N 天前 / 具体日期（与 data.ts 里 mock 的口径一致） */
function stamp(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400_000);
  if (days < 1) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return days + ' 天前';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(new Date(iso));
}

function commentTimeOf(c: IssueComment): number {
  const m = /(\\d+)\\s*月\\s*(\\d+)\\s*日/.exec(c.createdAt);
  if (!m) return 0;
  return Number(m[1]) * 100 + Number(m[2]);
}

function sortComments(items: IssueComment[], sort: SortKey): IssueComment[] {
  if (sort === 'updated') return items;
  return [...items].sort((a, b) => (sort === 'comments' ? b.likes - a.likes : commentTimeOf(a) - commentTimeOf(b)));
}

export default function IssuePage() {
  const [issues, setIssues] = useState<Detail[]>(ISSUES);
  const [comments, setComments] = useState<Record<string, IssueComment[]>>(COMMENTS);
  const [view, setView] = useState<'content' | 'issue'>('issue');
  const [statusTab, setStatusTab] = useState<IssueStatus>('open');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<IssueStatus | undefined>(undefined);
  const [kind, setKind] = useState<IssueKind | undefined>(undefined);
  const [sort, setSort] = useState<SortKey>('updated');
  const [scope, setScope] = useState<Scope>('all');
  const [pickedLabels, setPickedLabels] = useState<string[]>([]);
  // 首屏默认打开第一条：详情面板与列表**同时**可见，一眼能看出这是主从布局
  const [selectedId, setSelectedId] = useState<number | string | null>(ISSUES[0]?.id ?? null);
  const [dialogKind, setDialogKind] = useState<IssueKind | null>(null);

  // 从帖子页那四个按钮点进来时带着 ?kind=bug：直接开对应类型的反馈面板，用户不用再选一次。
  // （上线时这个参数走 react-router 的 searchParams，URL 即状态，见前端方案 §6。）
  useEffect(() => {
    const k = new URLSearchParams(location.search).get('kind');
    if (k === 'bug' || k === 'feature' || k === 'difficulty' || k === 'other') setDialogKind(k);
  }, []);
  const [lastCreated, setLastCreated] = useState<string | null>(null);

  const parsed = useMemo(() => parseQuery(query), [query]);
  const openCount = issues.filter((i) => i.status === 'open').length;

  const counts = useMemo(
    () => ({ open: issues.filter((i) => i.status === 'open').length, closed: issues.filter((i) => i.status === 'closed').length }),
    [issues],
  );

  /** 标签选项：只列真实存在过的标签（含类型名），避免给出点了没结果的筛选项 */
  const labelOptions = useMemo(() => {
    const set = new Set<string>();
    for (const i of issues) for (const l of i.labels) set.add(l);
    return [...set];
  }, [issues]);

  const visible = useMemo(() => {
    // 解析出的 is: 覆盖 tab；显式下拉再覆盖解析值（用户最后点的那次说了算）
    const wantStatus = status ?? parsed.status ?? statusTab;
    const wantKind = kind ?? parsed.kind;
    const list = issues.filter((i) => {
      if (i.status !== wantStatus) return false;
      if (wantKind && i.kind !== wantKind) return false;
      if (scope === 'mine' && i.author.handle !== ME.handle) return false;
      if (scope === 'assigned' && i.assignee?.handle !== ME.handle) return false;
      if (pickedLabels.length > 0 && !pickedLabels.every((l) => i.labels.includes(l))) return false;
      return matchesQuery(
        { ...parsed, status: undefined, kind: undefined },
        {
          title: i.title,
          body: i.bodyHtml,
          status: i.status,
          kind: i.kind,
          labels: i.labels,
          authorNickname: i.author.nickname,
          authorHandle: i.author.handle,
          number: Number(i.id),
        },
      );
    });
    const sorted = [...list];
    if (sort === 'updated') sorted.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    if (sort === 'created') sorted.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    if (sort === 'comments') sorted.sort((a, b) => b.commentCount - a.commentCount);
    return sorted;
  }, [issues, parsed, statusTab, status, kind, scope, pickedLabels, sort]);

  const selected = issues.find((i) => String(i.id) === String(selectedId)) ?? null;
  const selectedComments = selected ? (comments[String(selected.id)] ?? []) : [];

  function resetFilters() {
    setQuery('');
    setStatus(undefined);
    setKind(undefined);
    setScope('all');
    setPickedLabels([]);
  }

  function pickTab(next: IssueStatus) {
    setStatusTab(next);
    setStatus(undefined);
  }

  function createIssue(draft: { kind: IssueKind; title: string; bodyJson: string; bodyHtml?: string }) {
    const now = new Date().toISOString();
    const issue: Detail = {
      id: 'new-' + now,
      kind: draft.kind,
      status: 'open',
      title: draft.title,
      bodyMarkdown: draft.bodyJson,
      bodyHtml: draft.bodyHtml ?? '',
      labels: [],
      author: ME,
      assignee: null,
      commentCount: 0,
      createdAt: stamp(now),
      updatedAt: stamp(now),
    };
    setIssues((prev) => [issue, ...prev]);
    setComments((prev) => ({ ...prev, [String(issue.id)]: [] }));
    setDialogKind(null);
    setStatusTab('open');
    setStatus(undefined);
    setKind(undefined);
    setScope('all');
    setSelectedId(issue.id);
    setLastCreated('已创建 #' + issue.id + '「' + issue.title + '」，它就在列表最上面。');
  }

  function setIssueStatus(next: IssueStatus) {
    if (!selected) return;
    setIssues((prev) => prev.map((i) => (i.id === selected.id ? { ...i, status: next, updatedAt: stamp(new Date().toISOString()) } : i)));
  }

  function addComment(parentId: string | null, body: { json: string; html: string }) {
    if (!selected) return;
    const id = String(selected.id);
    const comment: IssueComment = {
      id: 'c-' + id + '-' + Date.now(),
      author: ME,
      body: body.html,
      createdAt: stamp(new Date().toISOString()),
      likes: 0,
      dislikes: 0,
    };
    setComments((prev) => {
      const list = prev[id] ?? [];
      if (parentId === null) return { ...prev, [id]: [...list, comment] };
      // 楼中楼：parent_id 只允许指向一级回复（契约），所以挂到那一条的 replies 里
      return {
        ...prev,
        [id]: list.map((c) =>
          c.id === parentId
            ? { ...c, replies: { total: (c.replies?.total ?? 0) + 1, items: [...(c.replies?.items ?? []), comment] } }
            : c,
        ),
      };
    });
    setIssues((prev) => prev.map((i) => (i.id === selected.id ? { ...i, commentCount: i.commentCount + 1 } : i)));
  }

  return (
    <div className='flex w-full flex-col gap-4'>
      {/* 页宽由容器给（DevRoom 与真实壳同为 max-w-[1280px]），本页不再自己外扩。 */}
      <div className='w-full'>
        <TopicTaskTabs value={view} onChange={setView} onOpenIssue={() => setScope('all')} issueCount={openCount} />

        {/* 窄屏两列：390 下 4 列会把标签截成「汇报 B / 功能建」（2026-10-14 FIX-COPY 在出图时抓到，两个入口一模一样地截）。 */}
        <div className='mt-4 grid grid-cols-2 gap-2 rounded-lg border border-dashed border-border p-3 sm:grid-cols-4' aria-label='我要反馈'>
          {KINDS.map((k) => (
            <span key={k} className='flex [&>*]:flex-1'>
              <IssueKindButton kind={k} size='lg' onSelect={setDialogKind} />
            </span>
          ))}
        </div>

        <div className='mt-4'>
          <IssueFilterBar
            query={query}
            onQuery={setQuery}
            status={status}
            onStatus={setStatus}
            kind={kind}
            onKind={setKind}
            sort={sort}
            onSort={setSort}
            scope={scope}
            onScope={setScope}
            labels={labelOptions}
            pickedLabels={pickedLabels}
            onToggleLabel={(l) => setPickedLabels((prev) => (prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l]))}
            onReset={resetFilters}
          />
        </div>

        {lastCreated ? (
          <p role='status' className='mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-[12px] text-foreground'>
            {lastCreated}
            <Button ghost className='ml-auto' onClick={() => setLastCreated(null)}>
              知道了
            </Button>
          </p>
        ) : null}

        <div className='mt-4 grid items-start gap-4 md:grid-cols-[minmax(340px,384px)_minmax(0,1fr)]'>
          <section className='flex min-w-0 flex-col rounded-lg border border-border bg-card' aria-label='反馈列表'>
            <div className='border-b border-border p-3'>
              <Tabs selected={statusTab} onSelect={(id: string) => pickTab(id === 'closed' ? 'closed' : 'open')}>
                <Tab id='open' title={'开启中 ' + counts.open} />
                <Tab id='closed' title={'已关闭 ' + counts.closed} />
              </Tabs>
              <p className='mt-2 text-[11px] text-muted-foreground'>
                共 {visible.length} 条 · 按 {SORT_LABEL[sort]} 排序 · 「{ISSUE_STATUS_LABEL[statusTab]}」分类
              </p>
            </div>

            {visible.length === 0 ? (
              <div className='flex flex-col items-center gap-2 px-6 py-14 text-center'>
                <SearchX aria-hidden className='size-8 text-muted-foreground' />
                <p className='text-sm font-medium text-foreground'>没有符合条件的反馈</p>
                <p className='max-w-[44ch] text-[12px] text-muted-foreground'>
                  换个关键词，或清掉上面的筛选；也可能是这一分类下暂时没有。
                </p>
                <span className='mt-1 flex flex-wrap items-center justify-center gap-2'>
                  <Button onClick={resetFilters}>清空筛选</Button>
                  <Button primary onClick={() => setDialogKind(parsed.kind ?? 'bug')}>
                    新建一条
                  </Button>
                </span>
              </div>
            ) : (
              <ul className='flex flex-col'>
                {visible.map((i) => (
                  <li key={String(i.id)}>
                    <ClickableIssueRow
                      issue={i}
                      selected={String(i.id) === String(selectedId)}
                      onOpen={() => setSelectedId(i.id)}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className='min-w-0 rounded-lg border border-border bg-card p-4'>
            {selected ? (
              <IssueDetail
                issue={selected}
                comments={sortComments(selectedComments, sort)}
                me={ME}
                candidates={MENTION_CANDIDATES}
                onSetStatus={setIssueStatus}
                onComment={addComment}
                onClose={() => setSelectedId(null)}
              />
            ) : (
              <div className='flex flex-col items-center gap-2 px-6 py-20 text-center'>
                <p className='text-sm font-medium text-foreground'>从左边选一条反馈看详情</p>
                <p className='max-w-[46ch] text-[12px] leading-relaxed text-muted-foreground'>
                  详情里有正文、状态开关（{ISSUE_STATUS_LABEL.open} / {ISSUE_STATUS_LABEL.closed}）、以及评论区——评论、楼中楼、赞踩都在那里。
                </p>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* D7：房间与真站同一块页内表单（原来两边都是弹窗） */}
      {dialogKind ? (
        <NewIssuePanel initialKind={dialogKind} onClose={() => setDialogKind(null)} onSubmit={createIssue} />
      ) : null}
    </div>
  );
}

/**
 * 列表行的**点击容器**：W1 的 IssueCard 是纯展示件（它自己写了这一句：点击行为由列表容器决定），
 * 所以这里只负责「能点 + 能只用键盘进详情」，行本身仍然是那一份共享件。
 */
function ClickableIssueRow({ issue, selected, onOpen }: { issue: IssueSummary; selected: boolean; onOpen: () => void }) {
  return (
    <div
      role='button'
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      aria-label={'打开反馈 #' + issue.id + ' ' + issue.title}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={cn(
        'cursor-pointer outline-none transition-colors hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50',
        selected && 'bg-muted/60',
      )}
    >
      <IssueCard issue={issue} />
    </div>
  );
}
