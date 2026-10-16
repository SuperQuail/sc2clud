import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { Tab, Tabs } from '@jetbrains/ring-ui-built/components/tabs/tabs';
import { Archive, RotateCcw } from 'lucide-react';
import type { IssueAdmin } from '@/lib/api/admin';
import { DataTable, type Sort } from '../data-table';
import { ConfirmDialog } from '../confirm';
import { GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';

// 屏 n：Issue 管理（契约 2026-10-16 冻结）。**归档不是删除**：非空 archived_at = 已被管理员藏起来。
// 三条必须照后端来的事：
//   ① 归档档位（未归档 / 已归档 / 全部）**进 query 由服务端筛**，archived=1|all 只对持 post.review 的人生效
//      （所以这一屏的权限点就是 post.review，不新造权限点 —— RBAC 是 24 点）；
//   ② 公开读一律排除已归档（archived_at IS NULL），非管理员访问已归档 issue 的详情是 **404**（与不存在同形）；
//   ③ 归档 / 恢复与 pin / lock 同形：POST + 200 {ok:true}，写 audit_logs（issue.archive / issue.restore）。
//
// **prop 驱动**（照 12-topic/topic-view.tsx）：取数在 routes/admin/issues.tsx 的容器里。
//
// 状态值域是 keep_open | closed（**不是 open**）——公开 IssueDTO 与这一屏同一张表，两边都别改口径。

const KIND_LABEL: Record<string, string> = { bug: 'Bug', feature: '功能建议', difficulty: '难度建议', other: '其他反馈' };
const STATUS_LABEL: Record<IssueAdmin['status'], string> = { keep_open: '开启中', closed: '已关闭' };

export type IssuesAdminFilter = { archived: '0' | '1' | 'all'; status: 'all' | 'open' | 'closed'; kind: string; q: string };

export type IssuesAdminScreenProps = {
  items: IssueAdmin[];
  hasMore: boolean;
  loading?: boolean;
  error?: ReactNode;
  filter: IssuesAdminFilter;
  onFilterChange: (next: IssuesAdminFilter) => void;
  onLoadMore?: () => void;
  canManage: boolean;
  /** 归档（弹层收 reason，可空）：reason 会进 audit_logs 的 detail */
  onArchive: (id: string, reason: string) => void;
  /** 恢复：低风险动作，不需要二次确认 */
  onRestore: (id: string) => void;
  receipt?: ReactNode;
};

export function IssuesAdminScreen({
  items, hasMore, loading = false, error = null, filter, onFilterChange, onLoadMore,
  canManage, onArchive, onRestore, receipt,
}: IssuesAdminScreenProps) {
  const [sort, setSort] = useState<Sort>({ key: 'number', dir: 'desc' });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [archive, setArchive] = useState<IssueAdmin | null>(null);

  const active = items.find((i) => i.id === activeId) ?? null;

  const columns = [
    {
      key: 'number', title: '#编号', track: 'minmax(72px,0.5fr)', sortable: true, sortValue: (i: IssueAdmin) => i.number,
      render: (i: IssueAdmin) => <span className='text-[12px] tabular-nums text-muted-foreground'>#{i.number}</span>,
    },
    {
      key: 'title', title: '标题', track: 'minmax(188px,2fr)', sortable: true, sortValue: (i: IssueAdmin) => i.title,
      render: (i: IssueAdmin) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='truncate text-[13px] font-medium text-foreground'>{i.title}</span>
          {i.tags.length > 0 ? <span className='truncate text-[10px] text-muted-foreground'>{i.tags.join(' · ')}</span> : null}
        </span>
      ),
    },
    {
      key: 'kind', title: '类型', track: 'minmax(76px,0.7fr)',
      render: (i: IssueAdmin) => <Pill>{KIND_LABEL[i.kind] ?? i.kind}</Pill>,
    },
    {
      key: 'status', title: '状态', track: 'minmax(72px,0.6fr)',
      render: (i: IssueAdmin) => <Pill tone={i.status === 'closed' ? 'neutral' : 'ok'}>{STATUS_LABEL[i.status] ?? i.status}</Pill>,
    },
    {
      key: 'author', title: '作者', track: 'minmax(96px,1fr)',
      render: (i: IssueAdmin) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='truncate text-[12px] text-foreground'>{i.author.nickname}</span>
          <span className='truncate text-[10px] text-muted-foreground'>@{i.author.handle}</span>
        </span>
      ),
    },
    {
      key: 'topic', title: '所属主题', track: 'minmax(104px,1.1fr)',
      render: (i: IssueAdmin) => (
        <span className='truncate text-[12px] text-muted-foreground' title={i.topic.title}>{i.topic.title}</span>
      ),
    },
    {
      key: 'archived', title: '归档', track: 'minmax(120px,1.3fr)',
      render: (i: IssueAdmin) => (i.archived_at ? (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='text-[11px] text-foreground'>{fmtTime(i.archived_at)}{i.archived_by ? ' · ' + i.archived_by.nickname : ''}</span>
          <span className='truncate text-[10px] text-muted-foreground' title={i.archive_reason}>
            {i.archive_reason || '（没有写原因）'}
          </span>
        </span>
      ) : <span className='text-[11px] text-muted-foreground'>—</span>),
    },
    {
      key: 'actions', title: '就地操作', track: 'minmax(140px,1.1fr)',
      render: (i: IssueAdmin) => (
        <span className='flex flex-wrap items-center gap-1.5' onClick={(e) => e.stopPropagation()}>
          {/* 「恢复」只在已归档行：未归档行亮一个点了没意义的按钮是在骗人 */}
          {i.archived_at ? (
            <Button data-testid={'issue-restore-' + i.id} disabled={!canManage} onClick={() => onRestore(i.id)}>
              <span className='flex items-center gap-1'><RotateCcw size={13} aria-hidden />恢复</span>
            </Button>
          ) : (
            <Button disabled={!canManage} onClick={() => setArchive(i)}>
              <span className='flex items-center gap-1'><Archive size={13} aria-hidden />归档</span>
            </Button>
          )}
          <Button onClick={() => setActiveId(i.id)}>详情</Button>
        </span>
      ),
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='Issue 管理'
        note='归档 = 从公开读里藏起来（详情地址对非管理员回 404）。列表的归档档位由服务端筛，前端不过滤。'
      />

      <StatRow>
        <Stat label='本页条数' value={items.length} />
        <Stat label='本页已归档' value={items.filter((i) => i.archived_at).length} />
        <Stat label='本页开启中' value={items.filter((i) => !i.archived_at && i.status === 'keep_open').length} tone='info' />
        <Stat label='还有下一页' value={hasMore ? '是' : '否'} hint='游标分页' />
      </StatRow>

      {!canManage ? <GateNote perm='post.review'>归档与恢复按钮不渲染；列表仍然可见（只读）。</GateNote> : null}

      <Tabs selected={filter.archived} onSelect={(id: string) => { onFilterChange({ ...filter, archived: id as IssuesAdminFilter['archived'] }); }}>
        <Tab id='0' title='未归档' />
        <Tab id='1' title='已归档' />
        <Tab id='all' title='全部' />
      </Tabs>

      <Toolbar>
        <Select
          type={SelectType.INPUT}
          label='状态'
          data={[{ key: 'all', label: '全部状态' }, { key: 'open', label: '开启中' }, { key: 'closed', label: '已关闭' }]}
          selected={{ key: filter.status, label: filter.status === 'all' ? '全部状态' : STATUS_LABEL[filter.status === 'open' ? 'keep_open' : 'closed'] }}
          onSelect={(item) => { if (item) onFilterChange({ ...filter, status: String(item.key) as IssuesAdminFilter['status'] }); }}
        />
        {/* 类型是开放小集合：选项从**本页真实出现过的** kind 里出，避免给出点了没结果的筛选项 */}
        <Select
          type={SelectType.INPUT}
          label='类型'
          data={[{ key: 'all', label: '全部类型' }, ...[...new Set(items.map((i) => i.kind))].map((k) => ({ key: k, label: KIND_LABEL[k] ?? k }))]}
          selected={{ key: filter.kind, label: filter.kind === 'all' ? '全部类型' : (KIND_LABEL[filter.kind] ?? filter.kind) }}
          onSelect={(item) => { if (item) onFilterChange({ ...filter, kind: String(item.key) }); }}
        />
        <Input
          label='搜索标题 / 作者登录名'
          value={filter.q}
          onChange={(e) => onFilterChange({ ...filter, q: e.target.value })}
        />
        {onLoadMore && hasMore ? <Button onClick={onLoadMore} disabled={loading}>加载下一页</Button> : null}
      </Toolbar>

      {receipt}
      {error}

      <div className='grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_260px]'>
        <DataTable
          columns={columns}
          rows={items}
          rowKey={(i) => i.id}
          rowTestId={(i) => 'issue-admin-row-' + i.id}
          rowLabel={(i) => '#' + i.number + ' ' + i.title}
          sort={sort}
          onSortChange={setSort}
          activeKey={activeId}
          onRowClick={(i) => setActiveId(i.id)}
          loading={loading}
          minWidth={880}
          density='compact'
          empty={filter.archived === '1' ? '没有已归档的 Issue' : '这个筛选下没有 Issue'}
        />

        <div className='flex flex-col gap-2'>
          <Panel title='这一条' note='正文是 HTML（后端不回 Markdown 源）'>
            {active ? (
              <>
                <div className='mb-2 flex items-center gap-1.5'>
                  <Pill>{KIND_LABEL[active.kind] ?? active.kind}</Pill>
                  <Pill tone={active.status === 'closed' ? 'neutral' : 'ok'}>{STATUS_LABEL[active.status] ?? active.status}</Pill>
                  {active.archived_at ? <Pill tone='warn'>已归档</Pill> : null}
                </div>
                <div className='mb-2 truncate text-[13px] font-medium text-foreground'>{active.title}</div>
                <div
                  className='mb-2 max-h-[220px] overflow-auto rounded-sm border border-border bg-muted/40 p-2 text-[12px] leading-relaxed text-foreground'
                  // 后端已经过 goldmark → bluemonday，这里是**同一份渲染结果**的回显（不自己再解释一次）
                  dangerouslySetInnerHTML={{ __html: active.body_html }}
                />
                <KV k='#编号' v={'#' + active.number} />
                <KV k='作者' v={active.author.nickname + ' @' + active.author.handle} />
                <KV k='所属主题' v={active.topic.title} />
                <KV k='创建 / 更新' v={fmtTime(active.created_at) + ' / ' + fmtTime(active.updated_at)} />
                <KV
                  k='归档时间'
                  v={active.archived_at ? fmtTime(active.archived_at) : '未归档'}
                  hint={active.archived_by ? '归档人：' + active.archived_by.nickname : undefined}
                />
                <KV k='归档原因' v={active.archive_reason || '—'} />
              </>
            ) : (
              <p className='text-[12px] text-muted-foreground'>在左侧点一行查看。</p>
            )}
          </Panel>

          <Panel title='归档意味着什么' note='不是删除，是公开读看不见'>
            <p className='text-[11px] leading-relaxed text-muted-foreground'>
              归档后：公开列表 / 话题页反馈列表 / 详情一律排除它（archived_at IS NULL），
              非管理员打开它的详情地址是 <b>404</b>（与不存在同形，不暴露「它被藏了」）；
              话题页那个「问题反馈 N」徽标也把它排除。动作写审计（issue.archive / issue.restore）。
            </p>
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        show={archive !== null}
        label='确认归档这条 Issue？'
        confirmText='确认归档'
        reasonLabel='归档原因（可选，进审计）'
        body={<span>归档 <b>#{archive?.number} {archive?.title}</b> 后，公开读一律看不到它；作者与其它用户打开详情地址会拿到 <b>404</b>。任何时候都能恢复。</span>}
        onClose={() => setArchive(null)}
        onConfirm={(reason) => {
          if (archive) onArchive(archive.id, reason);
          setArchive(null);
        }}
      />
    </div>
  );
}

/** 时间戳的本地展示（与 15-admin/screens/review.tsx 同款：这一层不引 mock/core）。 */
function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
