import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { Trash2 } from 'lucide-react';
import { Username } from '@/ui/user/username';
import { DataTable } from '../data-table';
import { ConfirmDialog, DangerAction } from '../confirm';
import { DisabledReason, GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';
import { relTime, REPORT_REASON, REPORTS, type ReportItem } from '../mock';
import { canInBoard, useCan } from '../mock/perms';

// 屏 e：举报处理队列（清单 4.6 / A7）。状态机 open → handled / dismissed，带处理人与处理备注。
// 注：§21.2 已有 POST /api/v1/reports 与 GET/PATCH /admin/reports，但数据库文档里**还没有 reports 表**（见回报）。

const STATE_LABEL: Record<ReportItem['state'], string> = { open: '待处理', handled: '已处理', dismissed: '已驳回' };
const TARGET_LABEL: Record<ReportItem['target_type'], string> = { topic: '帖子', post: '回复', user: '用户' };

export function ReportsScreen() {
  const canHandle = useCan('report.handle');
  const canDeleteAny = useCan('post.delete_any');
  const [tab, setTab] = useState<ReportItem['state']>('open');
  const [typeFilter, setTypeFilter] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(REPORTS[0]!.id);
  const [patch, setPatch] = useState<Record<string, ReportItem['state']>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<{ kind: 'handle' | 'dismiss' | 'delete'; ids: string[] } | null>(null);

  const rows = REPORTS
    .map((r) => ({ ...r, state: patch[r.id] ?? r.state }))
    .filter((r) => r.state === tab && (typeFilter === 'all' || r.target_type === typeFilter));
  const active = REPORTS.find((r) => r.id === activeId) ?? null;
  const activeState = active ? patch[active.id] ?? active.state : 'open';
  const scoped = active?.board ? canInBoard(active.board.slug, 'board.moderate') : false;

  function apply(ids: string[], next: ReportItem['state'], text: string) {
    setPatch((p) => {
      const c = { ...p };
      for (const id of ids) c[id] = next;
      return c;
    });
    setNote((p) => {
      const c = { ...p };
      for (const id of ids) c[id] = text;
      return c;
    });
    setSelected([]);
  }

  // 5 列：右栏放详情与状态机；「处理人 / 提交时间 / 处理备注」都在右栏，列表只留判断需要的东西。
  const columns = [
    {
      key: 'target', title: '被举报对象', track: 'minmax(168px,1.7fr)',
      render: (r: ReportItem) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='flex items-center gap-1.5'>
            <Pill tone={r.target_type === 'user' ? 'warn' : 'neutral'}>{TARGET_LABEL[r.target_type]}</Pill>
            <span className='truncate text-[13px] font-medium text-foreground'>{r.target_label}</span>
          </span>
          <span className='truncate text-[11px] text-muted-foreground'>{r.detail}</span>
          <span className='truncate text-[10px] text-muted-foreground'>
            {r.board ? r.board.name + ' · ' : ''}{relTime(r.created_at)}
          </span>
        </span>
      ),
    },
    { key: 'reason', title: '理由', track: 'minmax(72px,0.7fr)', render: (r: ReportItem) => <Pill>{REPORT_REASON[r.reason]}</Pill> },
    { key: 'reporter', title: '举报人', track: 'minmax(96px,1fr)', render: (r: ReportItem) => <Username nickname={r.reporter.nickname} size='sm' badge='none' /> },
    {
      key: 'state', title: '状态 / 处理人', track: 'minmax(96px,1fr)',
      render: (r: ReportItem) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <Pill tone={r.state === 'open' ? 'warn' : r.state === 'handled' ? 'ok' : 'neutral'}>{STATE_LABEL[r.state]}</Pill>
          <span className='truncate text-[10px] text-muted-foreground'>{r.handler ? r.handler.nickname + ' · ' + relTime(r.handled_at) : '未处理'}</span>
        </span>
      ),
    },
    {
      key: 'actions', title: '就地操作', track: 'minmax(190px,1.5fr)',
      render: (r: ReportItem) => {
        const why = !canHandle ? '本账号没有 report.handle' : r.state !== 'open' ? '这条已经处理过了' : undefined;
        return (
          <span className='flex flex-wrap items-center gap-1.5' onClick={(e) => e.stopPropagation()}>
            <Button primary={r.state === 'open'} disabled={Boolean(why)} onClick={() => setPending({ kind: 'handle', ids: [r.id] })}>标记已处理</Button>
            <Button disabled={Boolean(why)} onClick={() => setPending({ kind: 'dismiss', ids: [r.id] })}>驳回</Button>
            <Button onClick={() => setActiveId(r.id)}>详情</Button>
          </span>
        );
      },
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='举报处理队列'
        note='4.6 / A7：open → handled / dismissed 的状态机；处理人与处理备注必须落库（并在审计里能看到）。'
      />

      <StatRow>
        <Stat label='待处理' value={REPORTS.filter((r) => (patch[r.id] ?? r.state) === 'open').length} tone='info' />
        <Stat label='已处理' value={REPORTS.filter((r) => (patch[r.id] ?? r.state) === 'handled').length} />
        <Stat label='已驳回' value={REPORTS.filter((r) => (patch[r.id] ?? r.state) === 'dismissed').length} />
        <Stat label='对象类型' value={'帖子 / 回复 / 用户'} hint='user 类不挂分区' />
      </StatRow>

      {!canHandle ? <GateNote perm='report.handle'>处理与驳回按钮不渲染；列表仍然可见（只读队列）。</GateNote> : null}

      <Tabs selected={tab} onSelect={(id: string) => { setTab(id as ReportItem['state']); setSelected([]); }}>
        <Tab id='open' title={'待处理 ' + REPORTS.filter((r) => (patch[r.id] ?? r.state) === 'open').length} />
        <Tab id='handled' title={'已处理 ' + REPORTS.filter((r) => (patch[r.id] ?? r.state) === 'handled').length} />
        <Tab id='dismissed' title={'已驳回 ' + REPORTS.filter((r) => (patch[r.id] ?? r.state) === 'dismissed').length} />
      </Tabs>

      <Toolbar>
        <Select
          type={SelectType.INPUT}
          label='对象类型'
          data={[{ key: 'all', label: '全部类型' }, { key: 'topic', label: '帖子' }, { key: 'post', label: '回复' }, { key: 'user', label: '用户' }]}
          selected={{ key: typeFilter, label: typeFilter === 'all' ? '全部类型' : TARGET_LABEL[typeFilter as ReportItem['target_type']] }}
          onSelect={(item) => { if (item) setTypeFilter(String(item.key)); }}
        />
        <Button disabled={!canHandle || selected.length === 0} onClick={() => setPending({ kind: 'handle', ids: selected })}>批量标记已处理（{selected.length}）</Button>
        <DangerAction disabled={!canHandle || selected.length === 0} why={selected.length === 0 ? '先在列表里勾选' : undefined} onClick={() => setPending({ kind: 'dismiss', ids: selected })}>
          批量驳回（{selected.length}）
        </DangerAction>
      </Toolbar>

      <div className='grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_252px]'>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.target_label}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          selectDisabledReason={(r) => (r.state !== 'open' ? '已处理过的不再批量操作' : null)}
          activeKey={activeId}
          onRowClick={(r) => setActiveId(r.id)}
          minWidth={600}
          density='compact'
          empty='这个状态下没有举报'
        />

        <div className='flex flex-col gap-2'>
          <Panel title='举报详情' note='处理备注是必填的：将来要能回答「为什么驳回/为什么封号」'>
            {active ? (
              <>
                <KV k='对象' v={TARGET_LABEL[active.target_type] + ' · ' + active.target_label} />
                <KV k='分区' v={active.board ? active.board.name + ' /' + active.board.slug : '—（用户级举报）'} />
                <KV k='理由' v={REPORT_REASON[active.reason]} />
                <KV k='举报人' v={active.reporter.nickname + ' @' + active.reporter.handle} hint={active.reporter.role?.name ?? ''} />
                <KV k='举报时间' v={relTime(active.created_at)} />
                <KV k='当前状态' v={<Pill tone={activeState === 'open' ? 'warn' : activeState === 'handled' ? 'ok' : 'neutral'}>{STATE_LABEL[activeState]}</Pill>} />
                <div className='my-1 rounded-sm border border-border bg-muted/40 p-2 text-[12px] leading-relaxed text-foreground'>{active.detail}</div>
                <Input
                  label='处理备注（必填，进审计与通知）'
                  multiline
                  rows={2}
                  value={note[active.id] ?? active.handle_note}
                  onChange={(e) => setNote((p) => ({ ...p, [active.id]: e.target.value }))}
                />
                <div className='mt-2 flex flex-wrap items-center gap-1.5'>
                  {canDeleteAny && active.board && scoped ? (
                    <DangerAction onClick={() => setPending({ kind: 'delete', ids: [active.id] })} why={undefined}>
                      <span className='flex items-center gap-1'><Trash2 size={13} aria-hidden />就地删除被举报内容</span>
                    </DangerAction>
                  ) : null}
                </div>
                {active.board && !scoped ? (
                  <GateNote perm='board.moderate'>
                    「就地删除被举报内容」不渲染：/{active.board.slug} 不在你管理的分区里（board_moderators 未命中）。
                    你仍然可以在别处用 post.delete_any 处理，但那条路不带分区审核语义。
                  </GateNote>
                ) : null}
                {!active.board ? <DisabledReason>用户级举报没有分区：就地删除不适用（走封号或警告）</DisabledReason> : null}
              </>
            ) : (
              <p className='text-[12px] text-muted-foreground'>在左侧点一行查看详情。</p>
            )}
          </Panel>

          <Panel title='状态机' note='两条出路，都要求写处理人 + 备注'>
            <div className='flex flex-wrap items-center gap-1 text-[12px]'>
              <Pill tone='warn'>open</Pill>
              <span className='text-muted-foreground'>→</span>
              <Pill tone='ok'>handled</Pill>
              <span className='text-muted-foreground'>/</span>
              <Pill>dismissed</Pill>
            </div>
            <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>
              指数：DB 侧需要一个 (state, created_at DESC) 的队列索引与 reports 表本身；分页要按 §21.1 的游标分页 —— 见回报。
            </p>
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        show={pending !== null}
        label={pending?.kind === 'handle' ? '确认标记为已处理？' : pending?.kind === 'dismiss' ? '确认驳回这条举报？' : '确认删除被举报内容？'}
        danger={pending?.kind !== 'handle'}
        confirmText={pending?.kind === 'handle' ? '标记已处理' : pending?.kind === 'dismiss' ? '驳回举报' : '删除内容'}
        reasonLabel={pending?.kind === 'delete' ? '删除理由（必填，进审计）' : '处理备注（必填，进审计）'}
        reasonRequired
        body={
          pending?.kind === 'handle'
            ? <span>处理 <b>{pending.ids.length}</b> 条举报：状态置 handled，记录处理人（当前管理员）与备注，并通知举报人。</span>
            : pending?.kind === 'dismiss'
              ? <span>驳回后状态置 dismissed；举报人会收到「经核实不构成违规」的通知。滥用举报的次数要能被统计（另见回报）。</span>
              : <span>删除被举报内容（topics.status=deleted / posts.status=deleted，软删），并写入审计。</span>
        }
        onClose={() => setPending(null)}
        onConfirm={(reason) => {
          if (pending && pending.kind !== 'delete') apply(pending.ids, pending.kind === 'handle' ? 'handled' : 'dismissed', reason);
          setPending(null);
        }}
      />
    </div>
  );
}