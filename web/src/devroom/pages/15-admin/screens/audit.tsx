import { useState } from 'react';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { Username } from '@/ui/user/username';
import { DataTable, type Sort } from '../data-table';
import { GateNote, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';
import { AUDIT_ACTION_LABEL, AUDIT_LOGS, ESCALATION_ACTIONS, fmtTime, type AuditLog } from '../mock';
import { useCan } from '../mock/perms';

// 13.13 审计日志（DB §4.1 audit_logs）。9.8：角色创建/删除、矩阵变更、角色分配、版主任免**必须**留痕——
// 所以这一屏的重点不是「能搜」，而是「提权类操作一眼看得出来」。

const TARGETS: AuditLog['target_type'][] = ['user', 'role', 'board', 'mail_account', 'site', 'reward', 'report', 'title'];
const TARGET_LABEL: Record<AuditLog['target_type'], string> = {
  user: '用户', role: '角色', board: '分区', mail_account: '发信账号', site: '站点', reward: '打赏', report: '举报', title: '头衔',
};

export function AuditScreen() {
  const canView = useCan('audit.view');
  const canSystem = useCan('system.settings');
  const [actor, setActor] = useState('all');
  const [target, setTarget] = useState('all');
  const [action, setAction] = useState('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>({ key: 'created_at', dir: 'desc' });

  const actions = [...new Set(AUDIT_LOGS.map((l) => l.action))];
  const rows = AUDIT_LOGS.filter((l) => {
    if (actor !== 'all' && (l.actor?.handle ?? 'system') !== actor) return false;
    if (target !== 'all' && l.target_type !== target) return false;
    if (action === 'escalation' && !ESCALATION_ACTIONS.includes(l.action)) return false;
    if (action !== 'all' && action !== 'escalation' && l.action !== action) return false;
    if (q.trim() && !(l.detail + l.target_id).toLowerCase().includes(q.trim().toLowerCase())) return false;
    return true;
  });

  const columns = [
    {
      key: 'created_at', title: '时间', track: 'minmax(112px,1fr)', sortable: true, sortValue: (l: AuditLog) => l.created_at,
      render: (l: AuditLog) => <span className='text-[12px] text-muted-foreground'>{fmtTime(l.created_at)}</span>,
    },
    {
      key: 'actor', title: '操作者', track: 'minmax(128px,1.1fr)',
      render: (l: AuditLog) => (l.actor
        ? <Username nickname={l.actor.nickname} size='sm' badge='none' />
        : <Pill>系统任务</Pill>),
    },
    {
      key: 'action', title: '动作', track: 'minmax(138px,1.2fr)',
      render: (l: AuditLog) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='flex items-center gap-1'>
            <Pill tone={ESCALATION_ACTIONS.includes(l.action) ? 'danger' : 'neutral'}>{AUDIT_ACTION_LABEL[l.action] ?? l.action}</Pill>
            {ESCALATION_ACTIONS.includes(l.action) ? <span className='text-[10px] text-destructive'>提权类</span> : null}
          </span>
          <span className='truncate font-mono text-[10px] text-muted-foreground'>{l.action}</span>
        </span>
      ),
    },
    {
      key: 'target', title: '目标', track: 'minmax(126px,1.1fr)',
      render: (l: AuditLog) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='text-[12px] text-foreground'>{TARGET_LABEL[l.target_type]}</span>
          <span className='truncate font-mono text-[10px] text-muted-foreground'>{l.target_id}</span>
        </span>
      ),
    },
    { key: 'detail', title: '详情（jsonb 摘要）', track: 'minmax(158px,1.7fr)', render: (l: AuditLog) => <span className='truncate text-[12px] text-muted-foreground'>{l.detail}</span> },
    { key: 'ip', title: 'IP', track: '96px', render: (l: AuditLog) => <span className='font-mono text-[11px] text-muted-foreground'>{l.ip}</span> },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='审计日志'
        note='13.13：按操作者 / 目标类型 / 动作 / 关键词过滤；(actor_id, created_at DESC) 与 (target_type, target_id) 两个索引是查询的落点。'
      />

      <StatRow>
        <Stat label='日志条数' value={AUDIT_LOGS.length} hint='mock 抽样' />
        <Stat label='提权类操作' value={AUDIT_LOGS.filter((l) => ESCALATION_ACTIONS.includes(l.action)).length} tone='danger' hint='role.edit / role.assign / 追加权限' />
        <Stat label='系统任务写入' value={AUDIT_LOGS.filter((l) => !l.actor).length} hint='actor_id 为 NULL' />
        <Stat label='保留期' value='180 天' hint='按 DB §8 备份策略' />
      </StatRow>

      {!canView ? <GateNote perm='audit.view'>整张日志表不渲染（只显示这一句）。</GateNote> : null}

      <Toolbar>
        <Select
          type={SelectType.INPUT}
          label='操作者'
          data={[{ key: 'all', label: '全部操作者' }, ...['tangtian', 'linkai'].map((h) => ({ key: h, label: h })), { key: 'system', label: '系统任务' }]}
          selected={{ key: actor, label: actor === 'all' ? '全部操作者' : actor }}
          onSelect={(item) => { if (item) setActor(String(item.key)); }}
        />
        <Select
          type={SelectType.INPUT}
          label='目标类型'
          data={[{ key: 'all', label: '全部类型' }, ...TARGETS.map((t) => ({ key: t, label: TARGET_LABEL[t] }))]}
          selected={{ key: target, label: target === 'all' ? '全部类型' : TARGET_LABEL[target as AuditLog['target_type']] }}
          onSelect={(item) => { if (item) setTarget(String(item.key)); }}
        />
        <Select
          type={SelectType.INPUT}
          label='动作'
          data={[{ key: 'all', label: '全部动作' }, { key: 'escalation', label: '只看提权类' }, ...actions.map((a) => ({ key: a, label: a }))]}
          selected={{ key: action, label: action === 'all' ? '全部动作' : action }}
          onSelect={(item) => { if (item) setAction(String(item.key)); }}
        />
        <Input label='关键词（目标 id / 详情）' value={q} onChange={(e) => setQ(e.target.value)} />
      </Toolbar>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(l) => l.id}
        rowLabel={(l) => l.action}
        sort={sort}
        onSortChange={setSort}
        minWidth={806}
        density='compact'
        empty='没有符合条件的日志'
      />

      <div className='grid items-start gap-3 lg:grid-cols-2'>
        <Panel title='这一屏要能回答的问题'>
          <ul className='flex flex-col gap-1 text-[12px] text-muted-foreground'>
            <li>· 谁在什么时候把什么权限给了谁（9.8：提权是攻击者的第一目标）</li>
            <li>· 角色矩阵变更的 diff（detail jsonb 里的前后值）</li>
            <li>· 分区版主任免与到期时间</li>
            <li>· 打赏改判、举报处理这类「解释得清」的记录</li>
          </ul>
        </Panel>
        <Panel title='导出与保留'>
          {canSystem ? (
            <p className='text-[12px] text-muted-foreground'>导出 CSV / 归档到冷存储（系统级，本页不重复实现）</p>
          ) : (
            <GateNote perm='system.settings'>
              「导出 CSV」「设置保留期」不渲染：导出会把全站操作人行为带走，属系统级配置。
              另外 §21.2 目前也没有导出端点（见回报）。
            </GateNote>
          )}
        </Panel>
      </div>
    </div>
  );
}