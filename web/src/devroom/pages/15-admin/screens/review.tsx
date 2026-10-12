import { useMemo, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import DropdownMenu from '@jetbrains/ring-ui-built/components/dropdown-menu/dropdown-menu';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { CheckCheck, FileText } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import { DataTable } from '../data-table';
import { ConfirmDialog, DangerAction } from '../confirm';
import { DisabledReason, GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';
import { REVIEW_QUEUE, relTime, type ReviewItem } from '../mock';
import { canInBoard, useCan } from '../mock/perms';

// 屏 d：帖子审核队列（13.3）。topics.status ∈ pending / normal / rejected（DB §4.2）。
// 归档不做独立动作：DB 里没有 archived 的帖子状态，归档=隐藏(hidden)，这里并入状态机说明。

const KIND_LABEL: Record<ReviewItem['kind'], string> = { discussion: '讨论', resource: '资源', repost: '转载' };

export function ReviewScreen() {
  const canReview = useCan('post.review');
  const canDeleteAny = useCan('post.delete_any');
  const [tab, setTab] = useState<ReviewItem['state']>('pending');
  const [boardFilter, setBoardFilter] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(REVIEW_QUEUE[0]!.id);
  const [patch, setPatch] = useState<Record<string, ReviewItem['state']>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{ kind: 'approve' | 'reject' | 'revise'; ids: string[] } | null>(null);

  const boards = useMemo(() => [...new Set(REVIEW_QUEUE.map((r) => r.board.slug))], []);
  const rows = REVIEW_QUEUE
    .map((r) => ({ ...r, state: patch[r.id] ?? r.state }))
    .filter((r) => r.state === tab && (boardFilter === 'all' || r.board.slug === boardFilter));
  const active = REVIEW_QUEUE.find((r) => r.id === activeId) ?? null;
  const activeState = active ? patch[active.id] ?? active.state : 'pending';
  const activeScoped = active ? canInBoard(active.board.slug, 'board.moderate') : false;

  function apply(ids: string[], next: ReviewItem['state'], text: string) {
    setPatch((prev) => {
      const copy = { ...prev };
      for (const id of ids) copy[id] = next;
      return copy;
    });
    setNote((prev) => {
      const copy = { ...prev };
      for (const id of ids) copy[id] = text;
      return copy;
    });
    setSelected([]);
  }

  // 列压到 5 列：右栏详情占 252px，宽屏下这里只剩 ~600px。
  // 「类型 / 图片 / 提交时间」并进标题单元格的第二行；「请求修改」收进「更多」菜单（次要动作）。
  const columns = [
    {
      key: 'title', title: '标题', track: 'minmax(168px,1.7fr)', sortable: true, sortValue: (r: ReviewItem) => r.title,
      render: (r: ReviewItem) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='flex items-center gap-1.5'>
            <Pill>{KIND_LABEL[r.kind]}</Pill>
            <span className='truncate text-[13px] font-medium text-foreground'>{r.title}</span>
          </span>
          <span className='truncate text-[11px] text-muted-foreground'>{r.excerpt}</span>
          <span className='truncate text-[10px] text-muted-foreground'>{relTime(r.created_at)} 提交 · {r.images} 张图</span>
        </span>
      ),
    },
    {
      key: 'board', title: '分区', track: 'minmax(76px,0.7fr)', sortable: true, sortValue: (r: ReviewItem) => r.board.name,
      render: (r: ReviewItem) => <span className='text-[12px] text-muted-foreground'>{r.board.name}</span>,
    },
    {
      key: 'author', title: '作者', track: 'minmax(104px,1fr)',
      render: (r: ReviewItem) => (
        <span className='flex min-w-0 items-center gap-1.5'>
          <UserAvatar name={r.author.nickname} size='sm' />
          <span className='flex min-w-0 flex-col leading-tight'>
            <Username nickname={r.author.nickname} size='sm' badge='none' />
            <span className='truncate text-[10px] text-muted-foreground'>{r.author_trusted ? '免审作者' : '普通作者'}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'actions', title: '就地操作', track: 'minmax(176px,1.5fr)',
      render: (r: ReviewItem) => {
        const scopedRow = canInBoard(r.board.slug, 'board.moderate');
        const why = !canReview ? '本账号没有 post.review' : !scopedRow ? '无该分区版主授权（board_moderators 未命中）' : undefined;
        const open = r.state === 'pending';
        return (
          <span className='flex flex-wrap items-center gap-1.5' onClick={(e) => e.stopPropagation()}>
            <Button primary={open} icon={icon16(CheckCheck)} disabled={Boolean(why) || !open} onClick={() => setPending({ kind: 'approve', ids: [r.id] })}>通过</Button>
            <DangerAction disabled={Boolean(why) || !open} why={open ? why : '只有待审的帖子能拒绝'} onClick={() => setPending({ kind: 'reject', ids: [r.id] })}>拒绝</DangerAction>
            <DropdownMenu
              anchor={<Button disabled={Boolean(why) || !open}>更多</Button>}
              data={[
                { key: 'revise', label: '请求修改（退回给作者）' },
                { key: 'open', label: '在原文侧栏查看' },
              ]}
              onSelect={(item) => {
                if (!item) return;
                if (item.key === 'revise') setPending({ kind: 'revise', ids: [r.id] });
                else setActiveId(r.id);
              }}
            />
          </span>
        );
      },
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='帖子审核队列'
        note='13.3：通过 / 拒绝 / 请求修改。归档不做独立动作（DB 没有 archived 帖子状态，归档=hidden）。'
        actions={canDeleteAny ? <Button onClick={() => setSelected(rows.map((r) => r.id))} disabled={rows.length === 0}>全选本页</Button> : null}
      />

      <StatRow>
        <Stat label='待审' value={REVIEW_QUEUE.filter((r) => (patch[r.id] ?? r.state) === 'pending').length} tone='info' />
        <Stat label='已通过' value={REVIEW_QUEUE.filter((r) => (patch[r.id] ?? r.state) === 'normal').length} />
        <Stat label='已拒绝' value={REVIEW_QUEUE.filter((r) => (patch[r.id] ?? r.state) === 'rejected').length} tone='danger' />
        <Stat label='已选' value={selected.length} hint='批量操作对象' />
        <Stat label='我的分区' value={'campaign / resources'} hint='不在命中的分区只读' />
      </StatRow>

      {!canReview ? <GateNote perm='post.review'>通过 / 拒绝 / 请求修改按钮不渲染（§21.2 目前没有 admin 侧审核端点，权限点也待补，见回报）。</GateNote> : null}

      <Tabs selected={tab} onSelect={(id: string) => { setTab(id as ReviewItem['state']); setSelected([]); }}>
        <Tab id='pending' title={'待审 ' + REVIEW_QUEUE.filter((r) => (patch[r.id] ?? r.state) === 'pending').length} />
        <Tab id='normal' title={'已通过 ' + REVIEW_QUEUE.filter((r) => (patch[r.id] ?? r.state) === 'normal').length} />
        <Tab id='rejected' title={'已拒绝 ' + REVIEW_QUEUE.filter((r) => (patch[r.id] ?? r.state) === 'rejected').length} />
      </Tabs>

      <Toolbar>
        <Select
          type={SelectType.INPUT}
          label='分区'
          data={[{ key: 'all', label: '全部分区' }, ...boards.map((b) => ({ key: b, label: REVIEW_QUEUE.find((r) => r.board.slug === b)!.board.name }))]}
          selected={{ key: boardFilter, label: boardFilter === 'all' ? '全部分区' : REVIEW_QUEUE.find((r) => r.board.slug === boardFilter)!.board.name }}
          onSelect={(item) => { if (item) setBoardFilter(String(item.key)); }}
        />
        <Button
          icon={icon16(CheckCheck)}
          disabled={!canReview || selected.length === 0}
          onClick={() => setPending({ kind: 'approve', ids: selected })}
        >
          批量通过（{selected.length}）
        </Button>
        <DangerAction
          disabled={!canReview || selected.length === 0}
          why={selected.length === 0 ? '先在列表里勾选' : undefined}
          onClick={() => setPending({ kind: 'reject', ids: selected })}
        >
          批量拒绝（{selected.length}）
        </DangerAction>
        {selected.some((id) => !canInBoard(REVIEW_QUEUE.find((r) => r.id === id)?.board.slug ?? '', 'board.moderate')) ? (
          <DisabledReason>选中项里有不属于你管理的分区：那些行会被后端拒绝（前端只做提示）</DisabledReason>
        ) : null}
      </Toolbar>

      <div className='grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_252px]'>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.title}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          selectDisabledReason={(r) => (r.state !== 'pending' ? '只有待审的帖子能批量处理' : !canInBoard(r.board.slug, 'board.moderate') ? '不在你管理的分区' : null)}
          activeKey={activeId}
          onRowClick={(r) => setActiveId(r.id)}
          minWidth={592}
          density='compact'
          empty='这个状态下没有帖子'
        />

        <div className='flex flex-col gap-2'>
          <Panel title='原文侧栏' note='审核要看见正文与图片张数，而不是只看标题'>
            {active ? (
              <>
                <div className='mb-2 flex items-center gap-2'>
                  <FileText size={14} aria-hidden className='text-muted-foreground' />
                  <span className='truncate text-[13px] font-medium text-foreground'>{active.title}</span>
                </div>
                <div className='mb-2 rounded-sm border border-border bg-muted/40 p-2 text-[12px] leading-relaxed text-foreground'>
                  {active.excerpt}
                </div>
                <KV k='分区' v={active.board.name + ' /' + active.board.slug} />
                <KV k='类型 / 图片' v={KIND_LABEL[active.kind] + ' · ' + active.images + ' 张'} />
                <KV k='作者' v={active.author.nickname + ' @' + active.author.handle} hint={active.author.role?.name ?? ''} />
                <KV k='trusted' v={active.author_trusted ? '是（发帖免审）' : '否（进人工队列）'} />
                <KV k='状态' v={<Pill tone={activeState === 'rejected' ? 'danger' : activeState === 'pending' ? 'warn' : 'ok'}>{activeState === 'pending' ? '待审' : activeState === 'normal' ? '已通过' : '已拒绝'}</Pill>} />
                <KV k='审核备注' v={(note[active.id] ?? active.review_note) || '—'} hint={active.reviewer ? '审核人：' + active.reviewer.nickname + ' · ' + relTime(active.reviewed_at) : undefined} />
                <Input
                  label='备注（通过/拒绝/请求修改都写这里，进审计）'
                  multiline
                  rows={2}
                  value={note[active.id] ?? active.review_note}
                  onChange={(e) => setNote((p) => ({ ...p, [active.id]: e.target.value }))}
                />
                {!activeScoped ? <DisabledReason>/{active.board.slug} 不在你管理的分区：这里只读</DisabledReason> : null}
              </>
            ) : (
              <p className='text-[12px] text-muted-foreground'>在左侧点一行查看原文。</p>
            )}
          </Panel>

          <Panel title='状态机' note='topics.status 只有 normal / locked / hidden / deleted / pending / rejected'>
            <div className='flex flex-wrap items-center gap-1 text-[12px]'>
              <Pill tone='warn'>pending 待审</Pill>
              <span className='text-muted-foreground'>→</span>
              <Pill tone='ok'>normal 发布</Pill>
              <span className='text-muted-foreground'>/</span>
              <Pill tone='danger'>rejected 拒绝</Pill>
              <span className='text-muted-foreground'>；作者改完重新提交 → 回到 pending</span>
            </div>
            <p className='mt-2 text-[11px] text-muted-foreground'>
              「请求修改」在数据上要有一个可回传的备注（现在契约里没有，见回报的后端需求）。
            </p>
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        show={pending !== null}
        label={pending?.kind === 'approve' ? '确认通过并发布？' : pending?.kind === 'reject' ? '确认拒绝？' : '确认请求修改？'}
        danger={pending?.kind === 'reject'}
        confirmText={pending?.kind === 'approve' ? '通过并发布' : pending?.kind === 'reject' ? '拒绝并通知作者' : '发出修改请求'}
        reasonLabel='理由 / 给作者的话（必填，进审计与通知）'
        reasonRequired
        body={
          pending?.kind === 'approve'
            ? <span>通过后 <b>{pending.ids.length}</b> 条帖子立即公开（status=normal），作者会收到通知。trusted 作者的帖子本身免审，这里通常只剩被举报后重审的。</span>
            : pending?.kind === 'reject'
              ? <span>拒绝后帖子进入 rejected（只有作者与管理员可见），作者会收到通知与理由。</span>
              : <span>把帖子退回给作者修改：帖子保持 pending，作者改完重新提交。</span>
        }
        onClose={() => setPending(null)}
        onConfirm={(reason) => {
          if (pending) apply(pending.ids, pending.kind === 'approve' ? 'normal' : pending.kind === 'reject' ? 'rejected' : 'pending', reason);
          setPending(null);
        }}
      />
    </div>
  );
}