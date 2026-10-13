import { useMemo, useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { Ban, Search, ShieldCheck } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import { DataTable, TableFooter, type Sort } from '../data-table';
import { ConfirmDialog, DangerAction } from '../confirm';
import { DisabledReason, GateNote, KV, Numbers, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';
import { fmtDate, relTime, USERS, TITLES, type AdminUser } from '../mock';
import { useCan } from '../mock/perms';

// 屏 a：用户管理（13.2 用户管理 + 13.7 处罚 + 13.6 发头衔）。
// 磁盘配额**不做**：D2 已定案放弃网盘，quota_bytes / used_bytes 不迁（见 admin-map.md）。
// 前端权限只决定显不显示；真正的判定在后端（前端方案 §5.4 / 后端方案 §9.8）。

type StatusFilter = 'all' | 'normal' | 'pending_act' | 'banned' | 'unverified';
const STATUS_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全部状态' },
  { key: 'normal', label: '正常（已激活）' },
  { key: 'pending_act', label: '待激活（可读不可写）' },
  { key: 'banned', label: '已封禁' },
  { key: 'unverified', label: '邮箱未验证（不能登录）' },
];

type Patch = { status?: 'active' | 'banned'; activated?: boolean };

export function UsersScreen() {
  const canBan = useCan('user.ban');
  const canAssignRole = useCan('role.assign');
  const canGrantTitle = useCan('title.grant');

  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [roleFilter, setRoleFilter] = useState('all');
  const [selected, setSelected] = useState<string[]>([]);
  const [sort, setSort] = useState<Sort>({ key: 'created_at', dir: 'desc' });
  const [activeId, setActiveId] = useState<string | null>(USERS[0]!.id);
  const [patch, setPatch] = useState<Record<string, Patch>>({});
  const [pending, setPending] = useState<{ kind: 'ban' | 'unban'; ids: string[] } | null>(null);
  const [grantTo, setGrantTo] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);

  function view(u: AdminUser) {
    const p = patch[u.id];
    return {
      ...u,
      status: p?.status ?? u.status,
      activated_at: p?.activated === true ? '2026-10-12T13:40:00Z' : p?.activated === false ? null : u.activated_at,
    };
  }

  const rows = useMemo(() => {
    const text = q.trim().toLowerCase();
    return USERS.map(view).filter((u) => {
      if (text && !(u.username.toLowerCase().includes(text) || u.nickname.toLowerCase().includes(text) || u.email.toLowerCase().includes(text))) return false;
      if (roleFilter !== 'all' && u.role.key !== roleFilter) return false;
      if (status === 'normal' && !(u.status === 'active' && u.activated_at)) return false;
      if (status === 'pending_act' && u.activated_at) return false;
      if (status === 'banned' && u.status !== 'banned') return false;
      if (status === 'unverified' && u.email_verified_at) return false;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status, roleFilter, patch]);

  const activeUser = USERS.map(view).find((u) => u.id === activeId) ?? null;
  const bannedSelected = rows.filter((u) => selected.includes(u.id) && u.status !== 'banned');
  const activeSelected = rows.filter((u) => selected.includes(u.id) && u.status === 'banned');

  function applyPatch(ids: string[], next: Patch) {
    setPatch((prev) => {
      const copy = { ...prev };
      for (const id of ids) copy[id] = { ...copy[id], ...next };
      return copy;
    });
    setSelected([]);
  }

  // 列定义：数据驱动（列 + 行 + 排序 + 选中都交给 DataTable）。
  // 宽屏下这里只有 ~600px（左导航 + 右详情栏占掉了其余），所以列数压到 5 列：
  // 「帖子/回复 + 注册/最后登录」并进用户单元格的第二行，需要细看时看右栏。
  const columns = [
    {
      key: 'user', title: '用户', track: 'minmax(158px,1.5fr)', sortable: true, sortValue: (u: AdminUser) => u.nickname,
      render: (u: AdminUser) => (
        <span className='flex min-w-0 items-center gap-2'>
          <UserAvatar name={u.nickname} size='sm' />
          <span className='flex min-w-0 flex-col leading-tight'>
            <Username nickname={u.nickname} handle={u.username} size='sm' strong badge='none' />
            <span className='truncate text-[10px] text-muted-foreground'>{u.email}</span>
            <span className='truncate text-[10px] text-muted-foreground'>
              注册 {fmtDate(u.created_at)} · {u.topic_count} 帖子 / {u.reply_count} 回复
            </span>
          </span>
        </span>
      ),
    },
    {
      key: 'role', title: '角色', track: 'minmax(88px,0.8fr)', sortable: true, sortValue: (u: AdminUser) => u.role.priority,
      render: (u: AdminUser) => (
        <span className='flex min-w-0 flex-col gap-0.5 leading-tight'>
          <RoleBadge role={u.role} />
          {u.extra_permissions.length > 0 ? (
            <span className='text-[10px] text-muted-foreground'>+{u.extra_permissions.length} 追加</span>
          ) : null}
          {u.title ? <TitleBadge title={u.title} size='sm' /> : null}
        </span>
      ),
    },
    {
      key: 'status', title: '状态（三根轴）', track: 'minmax(126px,1.05fr)',
      render: (u: AdminUser) => (
        <span className='flex flex-wrap items-center gap-1'>
          <Pill tone={u.status === 'banned' ? 'danger' : 'ok'}>{u.status === 'banned' ? '已封禁' : u.status === 'deleted' ? '已注销' : '正常'}</Pill>
          <Pill tone={u.email_verified_at ? 'neutral' : 'warn'}>{u.email_verified_at ? '邮箱已验证' : '邮箱未验证'}</Pill>
          <Pill tone={u.activated_at ? 'neutral' : 'warn'}>{u.activated_at ? '已激活' : '待激活'}</Pill>
        </span>
      ),
    },
    {
      key: 'actions', title: '就地操作', track: 'minmax(186px,1.3fr)',
      render: (u: AdminUser) => {
        const self = u.username === 'demo-admin';
        const isSuper = u.role.key === 'superadmin';
        const banWhy = !canBan ? '本账号没有 user.ban'
          : self ? '不能停用当前登录的账号'
            : isSuper ? '超级管理员不可封禁（9.8：最后一个 superadmin 不可移除，service 层守卫）'
              : undefined;
        return (
          <span className='flex flex-wrap items-center gap-1.5' onClick={(e) => e.stopPropagation()}>
            {u.status === 'banned' ? (
              <DangerAction why={banWhy} disabled={Boolean(banWhy)} onClick={() => setPending({ kind: 'unban', ids: [u.id] })}>解封</DangerAction>
            ) : (
              <DangerAction why={banWhy} disabled={Boolean(banWhy)} onClick={() => setPending({ kind: 'ban', ids: [u.id] })}>停用</DangerAction>
            )}
            {canGrantTitle ? <Button onClick={() => setGrantTo(u.id)}>发头衔</Button> : null}
            {canAssignRole ? <Button onClick={() => {}}>改角色</Button> : null}
            <Button onClick={() => setActiveId(u.id)}>详情</Button>
          </span>
        );
      },
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='用户管理'
        note='13.2：搜索登录名 / 昵称 / 邮箱，行内激活与停用、发头衔、批量选择；磁盘配额随网盘放弃（D2），不做。'
        actions={
          <>
            <Button icon={icon16(Search)} onClick={() => setQ('')}>重置筛选</Button>
            <Button onClick={() => setSelected(rows.map((u) => u.id))}>全选本页</Button>
          </>
        }
      />

      <StatRow>
        <Stat label='用户总数' value={USERS.length} hint='mock 只放 12 条' />
        <Stat label='已封禁' value={USERS.filter((u) => u.status === 'banned').length} tone='danger' />
        <Stat label='待激活' value={USERS.filter((u) => !u.activated_at).length} hint='可读不可写（activated_at）' />
        <Stat label='邮箱未验证' value={USERS.filter((u) => !u.email_verified_at).length} hint='不能登录' />
        <Stat label='已选' value={selected.length} tone={selected.length ? 'info' : 'neutral'} hint='批量操作的对象' />
      </StatRow>

      {!canAssignRole ? (
        <GateNote perm='role.assign'>「改角色」与「批量改角色」按钮不渲染（9.8 明令：role.edit 与 role.assign 必须分成两个权限点，单持其一都不足以提权）。</GateNote>
      ) : null}

      <Toolbar>
        <Input
          label='搜索登录名 / 昵称 / 邮箱'
          icon={icon16(Search)}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder='例如 demo-admin / 示范管理员 / @example.com'
        />
        <Select
          type={SelectType.INPUT}
          label='状态'
          data={STATUS_OPTIONS}
          selected={STATUS_OPTIONS.find((o) => o.key === status) ?? null}
          onSelect={(item) => { if (item) setStatus(item.key); }}
        />
        <Select
          type={SelectType.INPUT}
          label='基线角色'
          data={[{ key: 'all', label: '全部角色' }, ...['user', 'creator', 'moderator', 'admin', 'superadmin'].map((k) => ({ key: k, label: k }))]}
          selected={{ key: roleFilter, label: roleFilter === 'all' ? '全部角色' : roleFilter }}
          onSelect={(item) => { if (item) setRoleFilter(String(item.key)); }}
        />
        {canBan ? (
          <>
            <DangerAction
              disabled={bannedSelected.length === 0 && activeSelected.length === 0}
              why={bannedSelected.length === 0 && activeSelected.length === 0 ? '先在列表里勾选要处理的用户' : undefined}
              onClick={() => setPending({ kind: bannedSelected.length > 0 ? 'ban' : 'unban', ids: (bannedSelected.length > 0 ? bannedSelected : activeSelected).map((u) => u.id) })}
            >
              批量{activeSelected.length > 0 && bannedSelected.length === 0 ? '解封' : '停用'}
            </DangerAction>
            <span className='text-[11px] text-muted-foreground'>{bannedSelected.length + activeSelected.length} 行已选</span>
          </>
        ) : null}
      </Toolbar>

      <div className='grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_252px]'>
        <div className='flex min-w-0 flex-col gap-2'>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(u) => u.id}
            rowLabel={(u) => u.nickname}
            selectable
            selected={selected}
            onSelectedChange={setSelected}
            selectDisabledReason={(u) => (u.role.key === 'superadmin' ? '超级管理员不参与批量操作' : null)}
            sort={sort}
            onSortChange={setSort}
            activeKey={activeId}
            onRowClick={(u) => setActiveId(u.id)}
            minWidth={604}
            empty='没有符合条件的用户'
          />
          <TableFooter total={rows.length} page={page} size={size} onPage={setPage} onSize={setSize} />
        </div>

        <div className='flex flex-col gap-2'>
          <Panel title='用户详情' note='右栏详情：三根状态轴分开显示，不合成一个「状态」'>
            {activeUser ? (
              <>
                <div className='mb-2 flex items-center gap-2'>
                  <UserAvatar name={activeUser.nickname} size='lg' />
                  <span className='flex min-w-0 flex-col leading-tight'>
                    <Username nickname={activeUser.nickname} handle={activeUser.username} strong badge='none' />
                    <span className='truncate text-[11px] text-muted-foreground'>{activeUser.email}</span>
                  </span>
                </div>
                <div className='mb-2 flex flex-wrap items-center gap-1'>
                  <RoleBadge role={activeUser.role} />
                  {activeUser.title ? <TitleBadge title={activeUser.title} /> : null}
                  {activeUser.trusted ? <Pill tone='ok'>trusted：发帖免审</Pill> : <Pill>发帖进审核队列</Pill>}
                </div>
                <KV k='登录名（不可改）' v={activeUser.username} hint='DB §4.1 不变量：注册后固定' />
                <KV k='封禁轴 status' v={activeUser.status} />
                <KV k='邮箱验证轴' v={activeUser.email_verified_at ? fmtDate(activeUser.email_verified_at) : '未验证 → 不能登录'} />
                <KV k='激活轴 activated_at' v={activeUser.activated_at ? fmtDate(activeUser.activated_at) : '未激活 → 能登录、写操作 403'} />
                <KV k='注册 / 最后登录' v={fmtDate(activeUser.created_at) + ' / ' + relTime(activeUser.last_login_at)} />
                <Numbers items={[{ label: '帖子', value: activeUser.topic_count }, { label: '回复', value: activeUser.reply_count }]} />
              </>
            ) : (
              <p className='text-[12px] text-muted-foreground'>在左侧列表里点一行查看详情。</p>
            )}
          </Panel>

          <Panel title='追加权限（user_permissions）' note='点对点追加：带 reason 与 expires_at；到期自动失效。只读展示——授予/回收需要 role.assign'>
            {activeUser && activeUser.extra_permissions.length > 0 ? (
              <div className='flex flex-col'>
                {activeUser.extra_permissions.map((p) => (
                  <KV key={p.key} k={p.key} v={p.expires_at ? fmtDate(p.expires_at) + ' 到期' : '永久'} hint={p.reason} />
                ))}
              </div>
            ) : (
              <p className='text-[12px] text-muted-foreground'>无追加权限（基线角色已够用；RBAC：不存在「加一个角色」的第二种语义）。</p>
            )}
          </Panel>

          <Panel title='处罚记录' note='13.7：分区级限期禁言；D6 判定顺序第 2 步命中即拒绝'>
            {activeUser && activeUser.sanctions.length > 0 ? (
              <div className='flex flex-col gap-1.5'>
                {activeUser.sanctions.map((s) => (
                  <div key={s.kind + s.until} className='rounded-sm border border-border px-2 py-1'>
                    <div className='flex items-center gap-1.5'>
                      <Pill tone='danger'>{s.kind === 'mute_post' ? '禁发帖' : '禁评论'}</Pill>
                      <span className='text-[12px] text-foreground'>{s.scope}</span>
                      <span className='text-[11px] text-muted-foreground'>至 {fmtDate(s.until)}</span>
                    </div>
                    <p className='text-[11px] text-muted-foreground'>{s.reason}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className='text-[12px] text-muted-foreground'>无处罚记录。</p>
            )}
          </Panel>

          {activeUser ? (
            <Panel title='危险动作'>
              <div className='flex flex-wrap items-center gap-2'>
                <DangerAction
                  disabled={!canBan || activeUser.status === 'banned'}
                  why={!canBan ? '本账号没有 user.ban' : activeUser.status === 'banned' ? '该用户已经是封禁状态' : undefined}
                  onClick={() => setPending({ kind: 'ban', ids: [activeUser.id] })}
                >
                  <span className='flex items-center gap-1'><Ban size={13} aria-hidden />停用账号</span>
                </DangerAction>
                <Button icon={icon16(ShieldCheck)} disabled={!canGrantTitle} onClick={() => setGrantTo(activeUser.id)}>发头衔</Button>
              </div>
              {!canGrantTitle ? <DisabledReason>没有 title.grant：发头衔按钮不可用</DisabledReason> : null}
            </Panel>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        show={pending !== null}
        label={pending?.kind === 'unban' ? '确认解封？' : '确认停用（封号）？'}
        danger={pending?.kind !== 'unban'}
        confirmText={pending?.kind === 'unban' ? '解封' : '停用并踢掉全部会话'}
        reasonLabel={pending?.kind === 'unban' ? '解封说明（可选，进审计）' : '封号理由（必填，进审计）'}
        reasonRequired={pending?.kind !== 'unban'}
        disabledReason={!canBan ? '本账号没有 user.ban，按钮不可用' : undefined}
        body={
          pending?.kind === 'unban'
            ? <span>解封后该用户可以重新登录；被封期间的全部会话已经失效，需要重新登录。</span>
            : <span>停用会立刻让 <b>{pending?.ids.length}</b> 个用户的全部会话失效（status=banned，401），并写入审计日志 <code>user.ban</code>。这是 13.7 的封号轴，与「降权」是两条独立通道。</span>
        }
        onClose={() => setPending(null)}
        onConfirm={() => {
          if (pending) applyPatch(pending.ids, pending.kind === 'ban' ? { status: 'banned' } : { status: 'active' });
          setPending(null);
        }}
      />

      <GrantTitleDialog userId={grantTo} onClose={() => setGrantTo(null)} />
    </div>
  );
}

/** 发头衔（13.6 的第二半）：目录是只读的，这里只能从目录里挑一个授予（title.grant）。 */
function GrantTitleDialog({ userId, onClose }: { userId: string | null; onClose: () => void }) {
  const [titleId, setTitleId] = useState(TITLES[0]!.id);
  const [done, setDone] = useState(false);
  const user = USERS.find((u) => u.id === userId) ?? null;
  if (!user) return null;
  const options = TITLES.filter((t) => !t.archived_at).map((t) => ({ key: t.id, label: t.name + '（' + t.holders + ' 人持有）' }));
  return (
    <Dialog show label='发头衔' onCloseAttempt={onClose} onOverlayClick={onClose} onEscPress={onClose}>
      <div className='flex w-[420px] max-w-full flex-col gap-3 p-4'>
        <p className='text-[13px] text-foreground'>
          给 <b>{user.nickname}</b>（@{user.username}）授予头衔。一个用户可以持多个头衔，佩戴的只有一个（DB §4.11）。
        </p>
        <Select
          type={SelectType.INPUT}
          label='头衔（已归档的不出现）'
          data={options}
          selected={options.find((o) => o.key === titleId) ?? null}
          onSelect={(item) => { if (item) setTitleId(String(item.key)); setDone(false); }}
        />
        <Checkbox label='同时设为佩戴头衔' checked indeterminate={false} onChange={() => {}} />
        {done ? <Pill tone='ok'>已授予（mock：真实实现走 POST /api/v1/admin/users/{'{id}'}/titles/{'{titleId}'}）</Pill> : null}
        <div className='flex items-center justify-end gap-2'>
          <Button onClick={onClose}>关闭</Button>
          <Button primary onClick={() => setDone(true)}>授予</Button>
        </div>
      </div>
    </Dialog>
  );
}