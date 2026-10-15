import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { CheckCheck, Clock3, FileText, History } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import type { ReviewAction, ReviewQueueItem } from '@/lib/api/admin';
import { DataTable } from '../data-table';
import { ConfirmDialog, DangerAction } from '../confirm';
import { DisabledReason, GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';

// 屏 d：帖子审核队列（13.3）。契约与取舍见 完全重构/进行中/后端接口对账.md §3，
// 实现真源 forum/internal/forum/review_queue.go。
//
// **prop 驱动**（照 12-topic/topic-view.tsx）：取数在 routes/admin-screens.tsx 的容器里。
//
// 三件与旧版（mock）不同、必须照后端来的事：
//   ① `review_state` 是**四值** `pending | approved | rejected | revision_requested`（0004 + 0028）；
//      **档位里没有 plain「approved」**：部分索引的谓词是 `review_state <> 'approved'`，查它用不上索引。
//      唯一的例外是 `draft`（06.2 加的）：已发布、但有改动等着替换上线。
//   ② 「AI 转人工」不是状态，是**最近一次判定事件的结论** review_verdict='review'
//      （取自 review_events，从四态**推不出来** —— 交接单 C11）。
//   ③ **判定必须带 expected_updated_at**（队列项的 updated_at）：作者在你读队列之后改了稿时
//      状态不变（06.2 之后已发布帖改稿**不动** review_state）、内容变了，不带版本就会把一份
//      没人看过的新正文批成 approved（后端 400/409 挡）。
//
// 「打回修改」（request_revision）与「拒绝」是**两档**（拍板 08 · L6）：打回是「改改就能过」，
// 作者那一侧有独立的横幅与文案；拒绝是「这篇不行」。以前这里写着「不做」，现在是做完了。
// 两档都必须写理由（后端强制）：不说改哪里等于让作者猜。

const KIND_LABEL: Record<string, string> = { discussion: '讨论', resource: '资源', repost: '转载' };
const STATE_LABEL: Record<string, string> = {
  pending: '待审', approved: '已通过', rejected: '已拒绝', revision_requested: '打回修改',
};
/** 队列的五个档位（review_queue.go 的 reviewQueueStates）。
 *  draft 是唯一一个 review_state='approved' 的档：「已发布 + 有改动等着替换上线」（06.2）。 */
export type ReviewTab = 'pending' | 'revision_requested' | 'draft' | 'rejected' | 'all';

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
  /** 判定：approve 放行（有草稿时 = 把改动替换上线）、reject / request_revision 都要写理由。
   *  approve 之外的两个动作后端都强制 note（打回不说改哪里等于让作者猜）。 */
  onReview: (item: ReviewQueueItem, action: ReviewAction, note: string) => void;
  receipt?: ReactNode;
};

export function ReviewScreen({
  items, hasMore, loading = false, error = null, filter, onFilterChange, onLoadMore,
  canReview, onReview, receipt,
}: ReviewScreenProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<{ action: ReviewAction; ids: string[] } | null>(null);

  const active = items.find((r) => r.id === activeId) ?? null;
  const aiToHuman = items.filter(isAiToHuman);
  const boards = [...new Map(items.map((r) => [r.board.slug, r.board.name])).entries()];
  const picked = items.filter((r) => selected.includes(r.id));
  // 「队列里那一版还在手上」的行才能判：否则后端会用 expected_updated_at 挡回来（等于白点）。
  // **draft 那一档里的行是 approved**：它要判的不是「放不放行这条帖」，而是「这份改动替不替换上线」，
  // 所以它同样可判（06.2 的闭环全靠这一步）。
  const reviewable = (r: ReviewQueueItem) => r.review_state === 'pending' || hasDraft(r);
  // 批量动作只对 pending 开放：一次勾选里混着「待审的新帖」与「待替换的改动」时，
  // 一句理由说不清两种事，而后端一次只收一个动作。
  const bulkable = (r: ReviewQueueItem) => r.review_state === 'pending';

  function submit(action: ReviewAction, noteText: string) {
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
        const why = !canReview ? '本账号没有 post.review' : !reviewable(r) ? '这一档没有可判定的内容' : undefined;
        return (
          <span className='flex flex-wrap items-center gap-1.5' onClick={(e) => e.stopPropagation()}>
            <Button primary inline={false} height={ControlsHeight.S} icon={icon16(CheckCheck)} disabled={Boolean(why)} onClick={() => setPending({ action: 'approve', ids: [r.id] })}>
              {hasDraft(r) ? '放行改动' : '通过'}
            </Button>
            {/* 打回修改与拒绝并列：两档都要写理由，但作者那一侧看到的是两种话（拍板 08 · L6）。 */}
            <Button inline={false} height={ControlsHeight.S} icon={icon16(Clock3)} disabled={Boolean(why)} onClick={() => setPending({ action: 'request_revision', ids: [r.id] })}>打回修改</Button>
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
        note='13.3：通过 / 打回修改 / 拒绝。打回与拒绝是两档（打回是「改改就能过」，作者那一侧文案不同），两档都必须写理由。'
        actions={canReview ? <Button onClick={() => setSelected(items.filter(bulkable).map((r) => r.id))} disabled={items.length === 0}>全选本页</Button> : null}
      />

      <StatRow>
        <Stat label='本页待审' value={items.filter((r) => r.review_state === 'pending').length} tone='info' />
        <Stat label='待替换改动' value={items.filter(hasDraft).length} tone='info' hint='已发布、改动等着替换上线' />
        <Stat label='打回修改' value={items.filter((r) => r.review_state === 'revision_requested').length} tone='info' />
        <Stat label='本页已拒绝' value={items.filter((r) => r.review_state === 'rejected').length} tone='danger' />
        <Stat label='AI 转人工' value={aiToHuman.length} tone={aiToHuman.length ? 'danger' : 'neutral'} hint='最近一次判定是 review' />
        <Stat label='已选' value={selected.length} hint='批量判定的对象' />
        <Stat label='还有下一页' value={hasMore ? '是' : '否'} hint='游标分页' />
      </StatRow>

      {!canReview ? <GateNote perm='post.review'>通过 / 打回修改 / 拒绝按钮不渲染（真正的判定在后端 authz.Require）。</GateNote> : null}

      {/* 五个档位照 review_queue.go 的 reviewQueueStates。draft 是 06.2 的那一档：
          「线上还挂着旧版、改动等着替换上线」——它列的是 approved 的帖，别按状态名去猜。 */}
      <Tabs selected={filter.state} onSelect={(id: string) => { onFilterChange({ ...filter, state: id as ReviewTab }); setSelected([]); }}>
        <Tab id='pending' title='待审' />
        <Tab id='revision_requested' title='打回修改' />
        <Tab id='draft' title='待替换改动' />
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
        {/* 批量没有「打回修改」：一次勾选里可能混着「待审的新帖」与「待替换的改动」，
            而打回的理由是写给作者看的具体意见 —— 一句话说不清两种事。逐条打回。 */}
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
          selectDisabledReason={(r) => (bulkable(r) ? null : '只有待审的新帖能批量处理')}
          activeKey={activeId}
          onRowClick={(r) => setActiveId(r.id)}
          loading={loading}
          minWidth={632}
          density='compact'
          rowClassName={(r) => (isAiToHuman(r) ? 'bg-destructive/10' : undefined)}
          empty='这个档位下没有帖子'
        />

        <div className='flex flex-col gap-2'>
          <Panel title='原文侧栏' note='审核要看见正文全文与作者，而不是只看标题'>
            {active ? (
              <>
                <div className='mb-2 flex items-center gap-2'>
                  <FileText size={14} aria-hidden className='text-muted-foreground' />
                  <span className='truncate text-[13px] font-medium text-foreground'>{active.title}</span>
                </div>
                {/* 就地预览被审内容（D25①）：**正文全文**，不是 200 字摘要。
                    渲染的是 Markdown **源**（不解析）：审核要看的是「有没有广告 / 攻击 / 离题」，
                    而解释过的富文本会把链接、图片地址、原始符号藏起来 —— 那些恰恰是要判的东西。
                    图片字节不含在内（DTO 里就没有）：正文里 `![alt](/img/<hash>)` 是
                    「这里有一张图」唯一的可见证据，与发给模型的那段文本同源。 */}
                <div className='mb-2 flex flex-col gap-1'>
                  <span className='text-[11px] text-muted-foreground'>
                    {'正文全文 · ' + [...active.body_md].length + ' 字'}
                    {active.body_truncated ? ' · 已截断（只显示前 ' + active.body_md.length + ' 字）' : ''}
                  </span>
                  <pre
                    data-testid='review-preview-body'
                    className='m-0 max-h-[240px] overflow-auto whitespace-pre-wrap break-words rounded-sm border border-border bg-muted/40 p-2 text-[12px] leading-relaxed text-foreground'
                  >
                    {active.body_md || '（后端没有给正文）'}
                  </pre>
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
                {hasDraft(active) ? <DisabledReason>这是<b>已发布</b>的帖：通过 = 把作者的改动<b>替换</b>上线，读者在此之前一直看到旧版（06.2）。</DisabledReason> : null}
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

          <Panel title='状态机' note='topics.review_state 四值（0004 + 0028 的 ck_topics_review_state）'>
            <div className='flex flex-wrap items-center gap-1 text-[12px]'>
              <Pill tone='warn'>pending 待审</Pill>
              <span className='text-muted-foreground'>→</span>
              <Pill tone='ok'>approved 发布</Pill>
            </div>
            <div className='mt-1 flex flex-wrap items-center gap-1 text-[12px]'>
              <Pill tone='danger'>rejected 拒绝</Pill>
              <span className='text-muted-foreground'>/</span>
              <Pill tone='warn'>revision_requested 打回修改</Pill>
            </div>
            <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>
              公开流的可见性谓词只有一条：visibility=normal **且** review_state=approved。
              从没过审的帖改完 1 楼正文会回 pending；**已发布的帖改稿不动状态**（06.2：线上仍是
              最后一个过审版本）——那种改动落在「待替换改动」这一档，放行即替换上线。
            </p>
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        show={pending !== null}
        label={pending?.action === 'approve' ? '确认通过并发布？' : pending?.action === 'request_revision' ? '确认打回修改？' : '确认拒绝？'}
        danger={pending?.action === 'reject'}
        confirmText={pending?.action === 'approve' ? '通过并发布' : pending?.action === 'request_revision' ? '打回并通知作者修改' : '拒绝并通知作者'}
        reasonLabel={pending?.action === 'reject' ? '拒绝理由（必填：作者在帖子页看到的就是它）'
          : pending?.action === 'request_revision' ? '打回意见（必填：说清改哪里，作者才不用猜）'
            : '备注（可选，进审计）'}
        reasonRequired={pending?.action !== 'approve'}
        body={
          pending?.action === 'approve'
            ? <span>通过后 <b>{pending?.ids.length}</b> 条帖子立即公开（review_state=approved）；
                其中「待替换改动」那些是 <b>把作者改的那一版换上线上</b>（06.2：通过才替换），
                未过审期间读者看到的一直是旧版。作者收到通知，搜索索引跟着重建。</span>
            : pending?.action === 'request_revision'
              ? <span>打回后是<b>独立状态</b>（revision_requested，不是拒绝）：作者看到「按意见改一版就能重新进队列」，
                  期间只有作者可见、可编辑，他手上那一版不会丢；线上仍是最后一个过审版本。
                  作者改完自动回到待审。</span>
              : <span>拒绝后帖子只有作者与管理员可见，作者收到通知与<b>这条理由</b>。
                  若判定时作者已经改过正文，后端会以「你手上的那一版不是现在这一版」拒绝（请刷新队列重判）——那是有意的，不是报错。</span>
        }
        onClose={() => setPending(null)}
        onConfirm={(reason) => {
          if (pending) {
            if (pending.ids.length > 1 && reason === '' && pending.action !== 'approve') return;
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

/** 「这一行是已发布帖上还没过审的改动」（06.2 的 draft 档）。
 *  判据是 review_state='approved'：**只有 draft 那一档会给出 approved 的行**（队列 SQL 里
 *  那是唯一一个 approved 档），所以不需要再给队列 DTO 加一个字段。 */
function hasDraft(r: ReviewQueueItem): boolean {
  return r.review_state === 'approved';
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
