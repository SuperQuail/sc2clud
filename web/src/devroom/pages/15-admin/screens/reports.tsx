import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { Username } from '@/ui/user/username';
import type { Report } from '@/lib/api/admin';
import { DataTable } from '../data-table';
import { ConfirmDialog } from '../confirm';
import { GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';

// 屏 e：举报处理队列（清单 4.6 / A7）。状态机 open → handled / dismissed，带处理人与处理备注。
// **prop 驱动**（照 12-topic/topic-view.tsx）：取数在 routes/admin-screens.tsx 的容器里。
//
// 三处与旧版（mock）不同、必须照后端来的事：
//   ① 行上的标题字段是 **target_label**（report/dto.go），不是 mock 里的 target_title ——
//      那个错名在本仓库造成过一次「每行标题恒空白」（交接单 §5.1）。
//   ② `open_reports` 是**同一目标当前的未处理举报数**：阈值压力要看得见，不要自己去数。
//   ③ 批量处理是**逐条 CAS + 逐条结果**（BatchResult.results[i].ok），
//      不是「一个事务全回滚」——所以逐条成败要显示出来，别把部分失败说成成功。
//
// **这一屏不做「就地删除被举报内容」**：mock 里那颗按钮走的是 post.delete_any，
// 而本屏的队列 DTO 没有带「我能不能删这条内容」的判定（board_moderators 的作用域前端拿不到：
// /me 只给 board_ids 数字，队列给 slug）。要做得先有一个「slug → 我是否该区版主」的读口。

const STATE_LABEL: Record<string, string> = { open: '待处理', handled: '已处理', dismissed: '已驳回' };
const TARGET_LABEL: Record<string, string> = { topic: '帖子', post: '回复', user: '用户' };
const REASON_LABEL: Record<string, string> = { spam: '垃圾广告', abuse: '辱骂攻击', illegal: '违法违规', offtopic: '文不对题', other: '其它' };

export type ReportTab = 'open' | 'handled' | 'dismissed';
export type ReportFilter = { state: ReportTab; target_type: string };

export type ReportsScreenProps = {
  items: Report[];
  hasMore: boolean;
  loading?: boolean;
  error?: ReactNode;
  filter: ReportFilter;
  onFilterChange: (next: ReportFilter) => void;
  onLoadMore?: () => void;
  canHandle: boolean;
  /** 处理一条举报：handled = 认定违规，dismissed = 经核实不构成违规。两条都要写备注。 */
  onHandle: (ids: string[], state: 'handled' | 'dismissed', note: string) => void;
  /** 批量处理的逐条结果（后端给 {results:[{id,ok,code}]}）；没有就传 null */
  batchResults?: { id: string; ok: boolean; code?: string }[] | null;
  receipt?: ReactNode;
};

export function ReportsScreen({
  items, hasMore, loading = false, error = null, filter, onFilterChange, onLoadMore,
  canHandle, onHandle, batchResults = null, receipt,
}: ReportsScreenProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<{ state: 'handled' | 'dismissed'; ids: string[] } | null>(null);

  const active = items.find((r) => r.id === activeId) ?? null;
  const openRows = items.filter((r) => r.state === 'open');
  const failed = (batchResults ?? []).filter((r) => !r.ok);

  const columns = [
    {
      key: 'target', title: '被举报对象', track: 'minmax(168px,1.7fr)',
      render: (r: Report) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='flex items-center gap-1.5'>
            <Pill tone={r.target_type === 'user' ? 'warn' : 'neutral'}>{TARGET_LABEL[r.target_type] ?? r.target_type}</Pill>
            <span className='truncate text-[13px] font-medium text-foreground'>{r.target_label || '（后端没给标题）'}</span>
          </span>
          <span className='truncate text-[11px] text-muted-foreground'>{r.detail}</span>
          <span className='truncate text-[10px] text-muted-foreground'>
            {r.board ? r.board.name + ' · ' : ''}{relTime(r.created_at)}
            {r.open_reports > 1 ? ' · 同目标还有 ' + (r.open_reports - 1) + ' 条未处理' : ''}
          </span>
        </span>
      ),
    },
    { key: 'reason', title: '理由', track: 'minmax(72px,0.7fr)', render: (r: Report) => <Pill>{REASON_LABEL[r.reason] ?? r.reason}</Pill> },
    {
      key: 'reporter', title: '举报人', track: 'minmax(96px,1fr)',
      render: (r: Report) => (r.reporter ? <Username nickname={r.reporter.nickname} handle={r.reporter.handle} size='sm' badge='none' /> : <Pill>已注销</Pill>),
    },
    {
      key: 'state', title: '状态 / 处理人', track: 'minmax(96px,1fr)',
      render: (r: Report) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <Pill tone={r.state === 'open' ? 'warn' : r.state === 'handled' ? 'ok' : 'neutral'}>{STATE_LABEL[r.state] ?? r.state}</Pill>
          <span className='truncate text-[10px] text-muted-foreground'>
            {r.handler ? r.handler.nickname + ' · ' + relTime(r.handled_at) : '未处理'}
          </span>
        </span>
      ),
    },
    {
      key: 'actions', title: '就地操作', track: 'minmax(190px,1.5fr)',
      render: (r: Report) => {
        const why = !canHandle ? '本账号没有 report.handle' : r.state !== 'open' ? '这条已经处理过了' : undefined;
        return (
          <span className='flex flex-wrap items-center gap-1.5' onClick={(e) => e.stopPropagation()}>
            <Button primary={r.state === 'open'} disabled={Boolean(why)} onClick={() => setPending({ state: 'handled', ids: [r.id] })}>标记已处理</Button>
            <Button disabled={Boolean(why)} onClick={() => setPending({ state: 'dismissed', ids: [r.id] })}>驳回</Button>
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
        note='4.6 / A7：open → handled / dismissed；处理人与处理备注落库（并在审计里能看到）。批量处理是逐条结果，不是整批回滚。'
        actions={canHandle ? <Button onClick={() => setSelected(openRows.map((r) => r.id))} disabled={openRows.length === 0}>全选本页待处理</Button> : null}
      />

      <StatRow>
        <Stat label='本页待处理' value={openRows.length} tone='info' />
        <Stat label='本页已处理' value={items.filter((r) => r.state === 'handled').length} />
        <Stat label='本页已驳回' value={items.filter((r) => r.state === 'dismissed').length} />
        <Stat label='同一目标多条' value={items.filter((r) => r.open_reports > 1).length} hint='阈值压力：同一对象被反复举报' />
        <Stat label='已选' value={selected.length} hint='批量处理对象' />
      </StatRow>

      {!canHandle ? <GateNote perm='report.handle'>处理与驳回按钮不渲染；列表仍然可见（只读队列）。</GateNote> : null}

      <Tabs selected={filter.state} onSelect={(id: string) => { onFilterChange({ ...filter, state: id as ReportTab }); setSelected([]); }}>
        <Tab id='open' title='待处理' />
        <Tab id='handled' title='已处理' />
        <Tab id='dismissed' title='已驳回' />
      </Tabs>

      <Toolbar>
        <Select
          type={SelectType.INPUT}
          label='对象类型'
          data={[{ key: 'all', label: '全部类型' }, { key: 'topic', label: '帖子' }, { key: 'post', label: '回复' }, { key: 'user', label: '用户' }]}
          selected={{ key: filter.target_type, label: filter.target_type === 'all' ? '全部类型' : (TARGET_LABEL[filter.target_type] ?? filter.target_type) }}
          onSelect={(item) => { if (item) onFilterChange({ ...filter, target_type: String(item.key) }); }}
        />
        <Button disabled={!canHandle || selected.length === 0} onClick={() => setPending({ state: 'handled', ids: selected })}>批量标记已处理（{selected.length}）</Button>
        <Button disabled={!canHandle || selected.length === 0} onClick={() => setPending({ state: 'dismissed', ids: selected })}>批量驳回（{selected.length}）</Button>
        {onLoadMore && hasMore ? <Button onClick={onLoadMore} disabled={loading}>加载下一页</Button> : null}
      </Toolbar>

      {failed.length > 0 ? (
        <p role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          批量结果：{batchResults!.length - failed.length} 条成功、{failed.length} 条失败（
          {failed.slice(0, 3).map((f) => f.id + '：' + (f.code ?? '失败')).join('；')}）。
          <b>后端是逐条 CAS，成功的那些已经生效了</b>，失败的要单独重试。
        </p>
      ) : null}
      {receipt}
      {error}

      <div className='grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_252px]'>
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(r) => r.id}
          rowLabel={(r) => r.target_label}
          selectable
          selected={selected}
          onSelectedChange={setSelected}
          selectDisabledReason={(r) => (r.state !== 'open' ? '已处理过的不再批量操作' : null)}
          activeKey={activeId}
          onRowClick={(r) => setActiveId(r.id)}
          loading={loading}
          minWidth={600}
          density='compact'
          empty='这个状态下没有举报'
        />

        <div className='flex flex-col gap-2'>
          <Panel title='举报详情' note='处理备注是必填的：将来要能回答「为什么驳回、为什么封号」'>
            {active ? (
              <>
                <KV k='对象' v={(TARGET_LABEL[active.target_type] ?? active.target_type) + ' · ' + (active.target_label || '（无标题）')} />
                <KV k='对象 id' v={<span className='font-mono text-[11px]'>{active.target_id}</span>} />
                <KV k='分区' v={active.board ? active.board.name + ' /' + active.board.slug : '—（用户级举报）'} />
                <KV k='理由' v={REASON_LABEL[active.reason] ?? active.reason} />
                <KV k='举报人' v={active.reporter ? active.reporter.nickname + ' @' + active.reporter.handle : '已注销'} />
                <KV k='举报时间' v={relTime(active.created_at)} />
                <KV k='同目标未处理' v={active.open_reports + ' 条'} hint='open_reports（后端算好的）' />
                <KV k='当前状态' v={<Pill tone={active.state === 'open' ? 'warn' : active.state === 'handled' ? 'ok' : 'neutral'}>{STATE_LABEL[active.state] ?? active.state}</Pill>} />
                <KV k='处理人 / 时间' v={active.handler ? active.handler.nickname + ' · ' + relTime(active.handled_at) : '未处理'} />
                <div className='my-1 rounded-sm border border-border bg-muted/40 p-2 text-[12px] leading-relaxed text-foreground'>{active.detail || '（举报人没有写补充说明）'}</div>
                <Input
                  label='处理备注（必填，进审计与通知）'
                  multiline
                  rows={2}
                  inputClassName='!h-[64px]'
                  value={note || active.handle_note}
                  onChange={(e) => setNote(e.target.value)}
                />
                {active.state !== 'open' ? (
                  <p className='text-[11px] text-muted-foreground'>这一条已经处理过了：处理备注是历史记录，不能再改。</p>
                ) : null}
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
              队列索引是 (state, created_at DESC)，游标分页按 §21.1。
              <b>就地删除被举报内容不在这里</b>：队列 DTO 没带「我能不能删这条」的判定
              （/me 只给 board_ids 数字、队列给 slug），要做得先有那个读口。
            </p>
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        show={pending !== null}
        label={pending?.state === 'handled' ? '确认标记为已处理？' : '确认驳回这条举报？'}
        danger={pending?.state === 'dismissed'}
        confirmText={pending?.state === 'handled' ? '标记已处理' : '驳回举报'}
        reasonLabel='处理备注（必填，进审计）'
        reasonRequired
        body={
          pending?.state === 'handled'
            ? <span>处理 <b>{pending?.ids.length}</b> 条举报：状态置 handled，记录处理人（当前管理员）与备注。</span>
            : <span>驳回后状态置 dismissed：<b>「经核实不构成违规」</b>。这是给举报人的答复，不是「忽略」。</span>
        }
        onClose={() => setPending(null)}
        onConfirm={(reason) => {
          if (pending) onHandle(pending.ids, pending.state, reason);
          setSelected([]);
          setNote('');
          setPending(null);
        }}
      />
    </div>
  );
}

/** 相对时间。**不再从 ../mock/core 引**：那是示例数据层，接了真端点就不该再依赖它。 */
function relTime(iso: string | null): string {
  if (!iso) return '—';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return mins + ' 分钟前';
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours + ' 小时前';
  const days = Math.round(hours / 24);
  if (days < 31) return days + ' 天前';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
