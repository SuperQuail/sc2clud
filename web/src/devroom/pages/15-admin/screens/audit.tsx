import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { Download } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { Username } from '@/ui/user/username';
import type { AuditItem } from '@/lib/api/admin';
import { DataTable, type Sort } from '../data-table';
import { GateNote, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';

// 13.13 审计日志（DB §4.1 audit_logs）。9.8：角色创建/删除、矩阵变更、角色分配、版主任免**必须**留痕 ——
// 所以这一屏的重点不是「能搜」，而是「提权类操作一眼看得出来」。
//
// **prop 驱动**：取数在 routes/admin-screens.tsx 的容器里。
//
// 三处与旧版（mock）不同、必须照后端来的：
//   ① 动作名**照后端的常量**（auth/audit.go 与各域的 deps.go），不是 mock 编的那一套。
//      演示数据里的 `user.permission.grant` / `board.moderate.grant` / `user.role.change`
//      在后端**一个都不存在**（真名是 `permission.grant` / `user.role.assign`，版主任免表还没建）。
//   ② `id` 是**数字**（自增，auth/audit.go 的 AuditItem），游标才是不透明串。
//   ③ `actor` 可以为 null（CLI / 系统任务，actor_id 为 NULL），`detail` 是 jsonb（对象或 null），
//      所以详情列展示的是 `JSON.stringify(detail)` 的截断，不是 mock 里那句手写中文。
//
// **导出**走 `<a href>` 直下 CSV（`GET /admin/audit-logs/export?format=csv`）——
// 前端方案 §5 的「fetch 只在 client.ts」管不到浏览器直接下载；权限点是 `audit.export`，
// 与 `audit.view` 分开（能看日志不等于能把全站操作人行为带走）。

/** 提权类：这些动作让某个人**多拿到**了权力或影响面。照后端常量列，不照 mock 的旧名。
 *  **导出给宿主**（routes/admin-screens.tsx 要按它筛「只看提权类」那一档）：两份清单必然漂移。 */
export const ESCALATION_ACTIONS = [
  'role.permissions.edit',
  'user.role.assign',
  'permission.grant',
  'permission.revoke',
  'user.ban',
  'user.sessions.revoke',
  'user.activate',
  'mail.account.update',
  'mail.account.create',
  'mail.account.archive',
  'site.setting.update',
  'title.grant',
  'title.revoke',
  'title.manage',
];

const ACTION_LABEL: Record<string, string> = {
  'auth.email.verify': '邮箱激活',
  'auth.password.change': '改口令',
  'user.register': '注册',
  'user.login': '登录',
  'user.ban': '封号 / 解封',
  'user.activate': '人工激活',
  'user.role.assign': '改基线角色',
  'user.sessions.revoke': '踢会话',
  'user.create_admin': '创建超管（CLI）',
  'permission.grant': '点对点追加权限',
  'permission.revoke': '回收追加权限',
  'permission.expire': '追加权限到期清理',
  'role.permissions.edit': '改角色权限矩阵',
  'role.edit': '改角色权限矩阵',
  'topic.review': '人工审核判定',
  'report.handle': '处理举报',
  'reward.verify': '打赏核验 / 改判',
  'mail.account.create': '新建发信账号',
  'mail.account.update': '改发信账号',
  'mail.account.archive': '归档发信账号',
  'site.setting.update': '改站点设置',
  'announcement.create': '新建公告',
  'announcement.update': '改公告',
  'banner.create': '新建横幅',
  'banner.update': '改横幅',
  'title.grant': '发头衔',
  'title.revoke': '收头衔',
  'title.manage': '改头衔目录',
  'audit.export': '导出审计',
};

const TARGETS = ['user', 'role', 'board', 'mail_account', 'site', 'reward', 'report', 'title', 'topic'];
const TARGET_LABEL: Record<string, string> = {
  user: '用户', role: '角色', board: '分区', mail_account: '发信账号', site: '站点',
  reward: '打赏', report: '举报', title: '头衔', topic: '主题',
};

export type AuditFilter = {
  collector: string;
  target_type: string;
  action: string;
  keyword: string;
  from: string;
  to: string;
};

export type AuditScreenProps = {
  items: AuditItem[];
  hasMore: boolean;
  loading?: boolean;
  error?: ReactNode;
  filter: AuditFilter;
  onFilterChange: (next: AuditFilter) => void;
  onLoadMore?: () => void;
  canView: boolean;
  canExport: boolean;
  /** 导出 CSV 的地址（宿主用 lib/api/admin 的 auditExportUrl 生成）；没有权限就不给 */
  exportHref?: string;
  receipt?: ReactNode;
};

export function AuditScreen({
  items, hasMore, loading = false, error = null, filter, onFilterChange, onLoadMore,
  canView, canExport, exportHref, receipt,
}: AuditScreenProps) {
  const [sort, setSort] = useState<Sort>(null);
  const escalation = items.filter((l) => ESCALATION_ACTIONS.includes(l.action));
  const actors = [...new Set(items.map((l) => l.actor?.handle).filter((h): h is string => Boolean(h)))];
  const actions = [...new Set(items.map((l) => l.action))];

  const columns = [
    {
      key: 'created_at', title: '时间', track: 'minmax(132px,1.1fr)', sortable: true, sortValue: (l: AuditItem) => l.created_at,
      render: (l: AuditItem) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='text-[12px] text-muted-foreground'>{fmtTime(l.created_at)}</span>
          <span className='truncate font-mono text-[10px] text-muted-foreground'>#{l.id}</span>
        </span>
      ),
    },
    {
      key: 'actor', title: '操作者', track: 'minmax(128px,1.1fr)',
      render: (l: AuditItem) => (l.actor
        ? <Username nickname={l.actor.nickname} handle={l.actor.handle} size='sm' badge='none' />
        : <Pill>系统 / CLI</Pill>),
    },
    {
      key: 'action', title: '动作', track: 'minmax(148px,1.3fr)',
      render: (l: AuditItem) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='flex items-center gap-1'>
            <Pill tone={ESCALATION_ACTIONS.includes(l.action) ? 'danger' : 'neutral'}>{ACTION_LABEL[l.action] ?? l.action}</Pill>
            {ESCALATION_ACTIONS.includes(l.action) ? <span className='text-[10px] text-destructive'>提权类</span> : null}
          </span>
          <span className='truncate font-mono text-[10px] text-muted-foreground'>{l.action}</span>
        </span>
      ),
    },
    {
      key: 'target', title: '目标', track: 'minmax(126px,1.1fr)',
      render: (l: AuditItem) => (
        <span className='flex min-w-0 flex-col leading-tight'>
          <span className='text-[12px] text-foreground'>{TARGET_LABEL[l.target_type] ?? l.target_type}</span>
          <span className='truncate font-mono text-[10px] text-muted-foreground'>{l.target_id}</span>
        </span>
      ),
    },
    {
      key: 'detail', title: '详情（jsonb 摘要）', track: 'minmax(168px,1.8fr)',
      render: (l: AuditItem) => (
        <span className='truncate font-mono text-[11px] text-muted-foreground' title={detailText(l)}>{detailText(l)}</span>
      ),
    },
    { key: 'ip', title: 'IP', track: '110px', render: (l: AuditItem) => <span className='font-mono text-[11px] text-muted-foreground'>{l.ip || '—'}</span> },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='审计日志'
        note='13.13：按操作者 / 目标类型 / 动作 / 时间；提权类操作一眼看得出来。detail 是 jsonb，本屏展示截断后的摘要。'
        actions={
          canExport && exportHref ? (
            /* 导出是**浏览器直接下文件**：必须是一个真链接，不能是「fetch 完再 blob 一下」 */
            <Button inline={false} icon={icon16(Download)} href={exportHref}>导出 CSV</Button>
          ) : null
        }
      />

      <StatRow>
        <Stat label='本页条数' value={items.length} hint='游标分页，不是总数' />
        <Stat label='本页提权类' value={escalation.length} tone={escalation.length ? 'danger' : 'neutral'} hint='改矩阵 / 分配角色 / 追加权限 / 封号' />
        <Stat label='系统任务写入' value={items.filter((l) => !l.actor).length} hint='actor_id 为 NULL（CLI 或后台任务）' />
        <Stat label='还有下一页' value={hasMore ? '是' : '否'} />
      </StatRow>

      {!canView ? <GateNote perm='audit.view'>整张日志表不渲染（只显示这一句）。</GateNote> : null}
      {!canExport && canView ? <GateNote perm='audit.export'>「导出 CSV」不渲染：能看日志不等于能把全站操作人行为带走（两个权限点分开）。</GateNote> : null}
      {receipt}
      {error}

      <Toolbar>
        <Select
          type={SelectType.INPUT}
          label='操作者'
          data={[{ key: 'all', label: '全部操作者' }, ...actors.map((h) => ({ key: h, label: h })), { key: 'system', label: '系统 / CLI' }]}
          selected={{ key: filter.collector, label: filter.collector === 'all' ? '全部操作者' : filter.collector === 'system' ? '系统 / CLI' : filter.collector }}
          onSelect={(item) => { if (item) onFilterChange({ ...filter, collector: String(item.key) }); }}
        />
        <Select
          type={SelectType.INPUT}
          label='目标类型'
          data={[{ key: 'all', label: '全部类型' }, ...TARGETS.map((t) => ({ key: t, label: TARGET_LABEL[t] ?? t }))]}
          selected={{ key: filter.target_type, label: filter.target_type === 'all' ? '全部类型' : (TARGET_LABEL[filter.target_type] ?? filter.target_type) }}
          onSelect={(item) => { if (item) onFilterChange({ ...filter, target_type: String(item.key) }); }}
        />
        <Select
          type={SelectType.INPUT}
          label='动作'
          data={[{ key: 'all', label: '全部动作' }, { key: 'escalation', label: '只看提权类' }, ...actions.map((a) => ({ key: a, label: (ACTION_LABEL[a] ?? a) + '（' + a + '）' }))]}
          selected={{ key: filter.action, label: filter.action === 'all' ? '全部动作' : filter.action === 'escalation' ? '只看提权类' : (ACTION_LABEL[filter.action] ?? filter.action) }}
          onSelect={(item) => { if (item) onFilterChange({ ...filter, action: String(item.key) }); }}
        />
        <Input label='关键词（目标 id）' value={filter.keyword} onChange={(e) => onFilterChange({ ...filter, keyword: e.target.value })} />
        <Input label='起始（RFC3339）' value={filter.from} onChange={(e) => onFilterChange({ ...filter, from: e.target.value })} placeholder='2026-10-01T00:00:00Z' />
        <Input label='截止（RFC3339）' value={filter.to} onChange={(e) => onFilterChange({ ...filter, to: e.target.value })} placeholder='2026-10-14T00:00:00Z' />
        {onLoadMore && hasMore ? <Button onClick={onLoadMore} disabled={loading}>加载下一页</Button> : null}
      </Toolbar>

      <DataTable
        columns={columns}
        rows={items}
        rowKey={(l) => String(l.id)}
        rowLabel={(l) => l.action}
        sort={sort}
        onSortChange={setSort}
        loading={loading}
        minWidth={900}
        density='compact'
        empty='没有符合条件的日志'
      />

      <div className='grid items-start gap-3 lg:grid-cols-2'>
        <Panel title='这一屏要能回答的问题'>
          <ul className='flex flex-col gap-1 text-[12px] text-muted-foreground'>
            <li>· 谁在什么时候把什么权限给了谁（9.8：提权是攻击者的第一目标）</li>
            <li>· 角色矩阵变更的前后值（detail jsonb 里的 before / after）</li>
            <li>· 打赏改判、举报处理这类「解释得清」的记录</li>
            <li>· 系统任务留下的行（actor 为 null）——它们没有操作人，但改动是真的</li>
          </ul>
        </Panel>
        <Panel title='导出与保留'>
          <p className='text-[12px] leading-relaxed text-muted-foreground'>
            导出走 `GET /admin/audit-logs/export?format=csv`（只要 csv，别的 format 后端会 400），
            权限点是 **audit.export**，与 audit.view 分开。
            「设置保留期」是系统级配置，这一屏不做。
          </p>
        </Panel>
      </div>
    </div>
  );
}

/** detail 是 jsonb：对象就序列化，null 就说 null（**不编一句中文**，那是 mock 才干的事）。 */
function detailText(l: AuditItem): string {
  if (l.detail == null) return '（没有 detail）';
  try {
    return JSON.stringify(l.detail);
  } catch {
    return '（detail 无法序列化）';
  }
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
