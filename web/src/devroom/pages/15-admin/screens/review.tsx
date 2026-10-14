import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { CheckCheck, FileText, History } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import type { ReviewQueueItem } from '@/lib/api/admin';
import { DataTable } from '../data-table';
import { ConfirmDialog, DangerAction } from '../confirm';
import { DisabledReason, GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';

// 屏 d：帖子审核队列（13.3）。契约与取舍见 完全重构/进行中/后端接口对账.md §3，
// 实现真源 forum/internal/forum/review_queue.go。
//
// **prop 驱动**（照 12-topic/topic-view.tsx）：取数在 routes/admin-screens.tsx 的容器里。
//
// 三件与旧版（mock）不同、必须照后端来的事：
//   ① `review_state` 只有三值 `pending | approved | rejected`（不是 mock 的 normal）；
//      **档位也没有 approved**：部分索引的谓词是 `review_state <> 'approved'`，查它用不上索引。
//   ② 「AI 转人工」不是状态，是**最近一次判定事件的结论** review_verdict='review'
//      （取自 review_events，从三态**推不出来** —— 交接单 C11）。
//   ③ **判定必须带 expected_updated_at**（队列项的 updated_at）：作者在你读队列之后改了正文时
//      状态不变、内容变了，不带版本就会把一份没人看过的新正文批成 approved（后端 400/409 挡）。
//
// **「请求修改」不做**：后端的 action 只有 approve | reject（review_queue.go 的 review_queueActions），
// 加第四态是 schema 变更而没有用户可感知的差别。要退回给作者就拒绝 + 写清理由 ——
// 作者改完 1 楼正文会自动回 pending（ResetTopicReview），闭环不缺这一环。

const KIND_LABEL: Record<string, string> = { discussion: '讨论', resource: '资源', repost: '转载' };
const STATE_LABEL: Record<string, string> = { pending: '待审', approved: '已通过', rejected: '已拒绝' };
/** 队列的三个档位（review_queue.go 的 reviewQueueStates；**没有 approved**） */
export type ReviewTab = 'pending' | 'rejected' | 'all';

export type ReviewFilter = { state: ReviewTab; board: string; q: string };

export type ReviewScreenProps = {
  items: ReviewQueueItem[];
  /** 还有下一页（后端给了 next_cursor） */
  hasMore: boolean;
  loading?: boolean;
  error?: ReactNode;
  filter: ReviewFilter;
  onFilterChange: (next: ReviewFilter) => void;
  /** 服务端渲染好的「上一页」入口由宿主给（游标栈在宿主手里） */
  onLoadMore?: () => void;
  canReview: boolean;
  /** 判定：approve 会立刻公开、reject 只有作者与管理员可见。note 必填（后端也要求）。 */
  onReview: (item: ReviewQueueItem, action: 'approve' | 'reject', note: string) => void;
  receipt?: ReactNode;
};

export function ReviewScreen({
  items, hasMore, loading = false, error = null, filter, onFilterChange, onLoadMore,
  canReview, onReview, receipt,
}: ReviewScreenProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<{ action: 'approve' | 'reject'; ids: string[] } | null>(null);

  const active = items.find((r) => r.id === activeId) ?? null;
  const aiToHuman = items.filter(isAiToHuman);
  const boards = [...new Map(items.map((r) => [r.board.slug, r.board.name])).entries()];
  const picked = items.filter((r) => selected.includes(r.id));
  // 只有「队列里那一版还在手上」的行能被批：否则后端会用 expected_updated_at 挡回来（等于白点）。
  const reviewable = (r: ReviewQueueItem) => r.review_state === 'pending';

  function submit(action: 'approve' | 'reject', noteText: string) {
    for (const r of picked) onReview(r, action, noteText);
    setSelected([]);
    setNote('');
  }

  const columns = [
    {
      key: 'title', title: '标题', track: 'minmax(186px,1.9fr)', sortable: true, sortValue: (r: ReviewQueueItem) => r.title,
      render: (r: ReviewQueueItem) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='flex items-center gap-1.5'>
            {r.review_verdict ? <Pill>{KIND_LABEL[r.kind] ?? r.kind}</Pill> : null}
            <span className='truncate text-[13px] font-medium text-foreground'>{r.title}</span>
          </span>
          <span className='flex min-w-0 items-center gap-1.5'>
            <SourceBadge item={r} />
            {/* 截断用 min-w-0 + truncate（flex 子项默认 min-width:auto 不会收缩）；
                hover 看全用原生 title —— Ring Tooltip 会再包一层，那层没有 min-w-0，截断会失效 */}
            <span className='min-w-0 truncate text-[11px] text-muted-foreground' title={r.review_note ?? ''}>
              {r.review_note ?? '（没有留下理由）'}
            </span>
          </span>
          <span className='truncate text-[11px] text-muted-foreground'>{r.excerpt}</span>
        </span>
      ),
    },
    {
      key: 'board', title: '分区', track: 'minmax(76px,0.7fr)', sortable: true, sortValue: (r: ReviewQueueItem) => r.board.name,
      render: (r: ReviewQueueItem) => <span className='text-[12px] text-muted-foreground'>{r.board.name}</span>,
    },
    {
      key: 'state', title: '状态', track: 'minmax(84px,0.7fr)',
      render: (r: ReviewQueueItem) => (
        <Pill tone={r.review_state === 'rejected' ? 'danger' : r.review_state === 'approved' ? 'ok' : 'warn'}>
          {STATE_LABEL[r.review_state] ?? r.review_state}
        </Pill>
      ),
    },
    {
      key: 'author', title: '作者', track: 'minmax(104px,1fr)',
      render: (r: ReviewQueueItem) => (
        <span className='flex min-w-0 items-center gap-1.5'>
          <UserAvatar name={r.author.nickname} src={r.author.avatar} size='sm' />
          <Username nickname={r.author.nickname} handle={r.author.handle} size='sm' badge='none' />
        </span>
      ),
    },
    {
      key: 'actions', title: '就地操作', track: 'minmax(150px,1.3fr)',
      render: (r: ReviewQueueItem) => {
        const why = !canReview ? '本账号没有 post.review' : !reviewable(r) ? '只有待审的帖子能判定' : undefined;
        return (
          <span className='flex flex-wrap items-center gap-1.5' onClick={(e) => e.stopPropagation()}>
            <Button primary inline={false} height={ControlsHeight.S} icon={icon16(CheckCheck)} disabled={Boolean(why)} onClick={() => setPending({ action: 'approve', ids: [r.id] })}>通过</Button>
            <DangerAction disabled={Boolean(why)} why={why} onClick={() => setPending({ action: 'reject', ids: [r.id] })}>拒绝</DangerAction>
          </span>
        );
      },
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='帖子审核队列'
        note='13.3：通过 / 拒绝。没有「请求修改」——后端的 action 只有 approve | reject，退回就写清理由拒绝（作者改完正文自动回待审）。'
        actions={canReview ? <Button onClick={() => setSelected(items.filter(reviewable).map((r) => r.id))} disabled={items.length === 0}>全选本页</Button> : null}
      />

      <StatRow>
        <Stat label='本页待审' value={items.filter(reviewable).length} tone='info' />
        <Stat label='本页已拒绝' value={items.filter((r) => r.review_state === 'rejected').length} tone='danger' />
        <Stat label='AI 转人工' value={aiToHuman.length} tone={aiToHuman.length ? 'danger' : 'neutral'} hint='最近一次判定是 review' />
        <Stat label='已选' value={selected.length} hint='批量判定对象' />
        <Stat label='还有下一页' value={hasMore ? '是' : '否'} hint='游标分页' />
      </StatRow>

      {!canReview ? <GateNote perm='post.review'>通过 / 拒绝按钮不渲染（真正的判定在后端 authz.Require）。</GateNote> : null}

      <Tabs selected={filter.state} onSelect={(id: string) => { onFilterChange({ ...filter, state: id as ReviewTab }); setSelected([]); }}>
        <Tab id='pending' title='待审' />
        <Tab id='rejected' title='已拒绝' />
        <Tab id='all' title='全部未通过' />
      </Tabs>

      <Toolbar>
        <Select
          type={SelectType.INPUT}
          label='分区'
          data={[{ key: 'all', label: '全部分区' }, ...boards.map(([slug, name]) => ({ key: slug, label: name }))]}
          selected={{ key: filter.board, label: filter.board === 'all' ? '全部分区' : (boards.find(([s]) => s === filter.board)?.[1] ?? filter.board) }}
          onSelect={(item) => { if (item) onFilterChange({ ...filter, board: String(item.key) }); }}
        />
        <Input
          label='搜索标题 / 用户名 / 昵称'
          value={filter.q}
          onChange={(e) => onFilterChange({ ...filter, q: e.target.value })}
        />
        <Button
          primary
          inline={false}
          height={ControlsHeight.S}
          icon={icon16(CheckCheck)}
          disabled={!canReview || selected.length === 0}
          onClick={() => setPending({ action: 'approve', ids: selected })}
        >
          批量通过（{selected.length}）
        </Button>
        <DangerAction
          disabled={!canReview || selected.length === 0}
          why={selected.length === 0 ? '先在列表里勾选' : undefined}
          onClick={() => setPending({ action: 'reject', ids: selected })}
        >
          批量拒绝（{selected.length}）
        </DangerAction>
        {onLoadMore && hasMore ? <Button onClick={onLoadMore} disabled={loading}>加载下一页</Button> : null}
      </Toolbar>

      {receipt}
      {error}

      <div className='grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_252px]'>
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.title}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          selectDisabledReason={(r) => (reviewable(r) ? null : '只有待审的帖子能批量处理')}
          activeKey={activeId}
          onRowClick={(r) => setActiveId(r.id)}
          loading={loading}
          minWidth={632}
          density='compact'
          rowClassName={(r) => (isAiToHuman(r) ? 'bg-destructive/10' : undefined)}
          empty='这个档位下没有帖子'
        />

        <div className='flex flex-col gap-2'>
          <Panel title='原文侧栏' note='审核要看见正文摘要，而不是只看标题'>
            {active ? (
              <>
                <div className='mb-2 flex items-center gap-2'>
                  <FileText size={14} aria-hidden className='text-muted-foreground' />
                  <span className='truncate text-[13px] font-medium text-foreground'>{active.title}</span>
                </div>
                <div className='mb-2 rounded-sm border border-border bg-muted/40 p-2 text-[12px] leading-relaxed text-foreground'>
                  {active.excerpt || '（后端没有给摘要）'}
                </div>
                <KV k='分区' v={active.board.name + ' /' + active.board.slug} />
                <KV k='类型' v={KIND_LABEL[active.kind] ?? active.kind} />
                <KV k='作者' v={active.author.nickname + ' @' + active.author.handle} />
                <KV k='审核态 review_state' v={<Pill tone={active.review_state === 'rejected' ? 'danger' : active.review_state === 'approved' ? 'ok' : 'warn'}>{STATE_LABEL[active.review_state] ?? active.review_state}</Pill>} />
                <KV
                  k='最近一次判定 review_verdict'
                  v={<SourceBadge item={active} />}
                  hint='取自 review_events，推不出来（三态里没有「转人工」）'
                />
                <KV
                  k='审核备注 review_note'
                  v={active.review_note ?? '—'}
                  hint={active.reviewer ? '判定人：' + active.reviewer.nickname : 'AI 判定（reviewer 为 null）'}
                />
                <KV k='内容版本 updated_at' v={fmtTime(active.updated_at)} hint='判定时原样回传（expected_updated_at）' />
                <KV k='提交时间' v={fmtTime(active.created_at)} />
                <Input
                  label='备注 / 给作者的话（拒绝时后端必填，进审计与通知）'
                  multiline
                  rows={2}
                  inputClassName='!h-[64px]'
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
                {!reviewable(active) ? <DisabledReason>这一条已经判过了：再判会被后端按 expected_updated_at 挡回来</DisabledReason> : null}
              </>
            ) : (
              <p className='text-[12px] text-muted-foreground'>在左侧点一行查看原文。</p>
            )}
          </Panel>

          <Panel title='判定历史在哪里' note='这一屏只带「最近一次」'>
            <p className='flex items-start gap-1 text-[11px] leading-relaxed text-muted-foreground'>
              <History size={12} aria-hidden className='mt-0.5 shrink-0' />
              完整的判定事件在 review_events（只增不改：谁判的、什么理由、什么触发方式）。
              队列 DTO 只带最近一次（reviewer / reviewed_at / review_verdict）——
              **这一屏不编一份假时间线出来**，要多次判定历史得先给队列加一个读口。
            </p>
          </Panel>

          <Panel title='状态机' note='topics.review_state 只有三值（0004 的 ck_topics_review_state）'>
            <div className='flex flex-wrap items-center gap-1 text-[12px]'>
              <Pill tone='warn'>pending 待审</Pill>
              <span className='text-muted-foreground'>→</span>
              <Pill tone='ok'>approved 发布</Pill>
              <span className='text-muted-foreground'>/</span>
              <Pill tone='danger'>rejected 拒绝</Pill>
            </div>
            <p className='mt-2 text-[11px] text-muted-foreground'>
              作者改完 1 楼正文 → ResetTopicReview 自动回到 pending。公开流的可见性谓词只有一条：
              visibility=normal **且** review_state=approved。
            </p>
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        show={pending !== null}
        label={pending?.action === 'approve' ? '确认通过并发布？' : '确认拒绝？'}
        danger={pending?.action === 'reject'}
        confirmText={pending?.action === 'approve' ? '通过并发布' : '拒绝并通知作者'}
        reasonLabel={pending?.action === 'reject' ? '拒绝理由（必填：作者在帖子页看到的就是它）' : '备注（可选，进审计）'}
        reasonRequired={pending?.action === 'reject'}
        body={
          pending?.action === 'approve'
            ? <span>通过后 <b>{pending?.ids.length}</b> 条帖子立即公开（review_state=approved），作者收到通知，搜索索引跟着重建。</span>
            : <span>拒绝后帖子只有作者与管理员可见，作者收到通知与<b>这条理由</b>。
                若判定时作者已经改过正文，后端会以「你手上的那一版不是现在这一版」拒绝（请刷新队列重判）——那是有意的，不是报错。</span>
        }
        onClose={() => setPending(null)}
        onConfirm={(reason) => {
          if (pending) {
            if (pending.ids.length > 1 && reason === '' && pending.action === 'reject') return;
            if (pending.ids.length === 1) {
              const one = items.find((r) => r.id === pending.ids[0]);
              if (one) onReview(one, pending.action, reason);
              setSelected([]);
              setNote('');
            } else {
              submit(pending.action, reason);
            }
          }
          setPending(null);
        }}
      />
    </div>
  );
}

/** d7 §8：判定来源三色 —— AI 判定（绿/红）、人工判定（灰）、免审（虚线）；
 *  **AI 转人工**单独用 danger，因为它是审核员最先要看的一类。 */
function SourceBadge({ item }: { item: ReviewQueueItem }) {
  if (item.review_source === 'ai') {
    if (item.review_verdict === 'review') return <Pill tone='danger' className='font-semibold'>AI 转人工</Pill>;
    if (item.review_verdict === 'reject') return <Pill tone='danger'>AI 拒绝</Pill>;
    return <Pill tone='ok'>AI 通过</Pill>;
  }
  if (item.review_source === 'manual') return <Pill tone='neutral'>人工判定</Pill>;
  if (item.review_source === 'trusted') return <Pill tone='outline'>免审</Pill>;
  return <Pill tone='warn'>AI 未判定</Pill>;
}

/** d7：ai + verdict=review 就是「AI 转人工」。**不是从 review_state 推的**。 */
function isAiToHuman(r: ReviewQueueItem): boolean {
  return r.review_source === 'ai' && r.review_verdict === 'review';
}

/** 时间戳的本地展示。**不再从 ../mock/core 引**：那是示例数据层，接了真端点就不该再依赖它。 */
function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
