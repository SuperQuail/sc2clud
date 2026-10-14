import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Ban, Search, ShieldCheck } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';
import { RoleBadge } from '@/ui/user/role-badge';
import { TitleBadge } from '@/ui/user/title-badge';
import type { AdminUser, AdminUserDetail, Role, Title } from '@/lib/api/admin';
import { DataTable, TableFooter, type Sort } from '../data-table';
import { ConfirmDialog, DangerAction } from '../confirm';
import { DisabledReason, GateNote, KV, Numbers, Panel, Pill, ScreenHead, Stat, StatRow, Toolbar } from '../bits';

// 屏 a：用户管理（13.2 用户管理 + 13.7 处罚 + 13.6 发头衔）。
// 磁盘配额**不做**：D2 已定案放弃网盘，quota_bytes / used_bytes 不迁（见 admin-map.md）。
//
// **prop 驱动**（照 12-topic/topic-view.tsx 的做法）：数据与动作全部由宿主给，屏里不 import mock。
// 之前这一屏直接 import ../mock —— 于是整个后台是一张示例表，后端改了也没人看得见。
// 角色目录来自 GET /admin/roles（已实装）、头衔目录 GET /admin/titles（已实装）、
// 角色 / 封号 / 踢会话 / 发头衔四个动作都走 auth 与 title 域**已实装**的管理端点。
// **GET /admin/users 与 /admin/users/{id} 已落地**（C1）。列表项与详情是**两个形状**：
// 详情那三张表（sanctions / user_permissions / user_titles）只有 GET /admin/users/{id} 给，
// 所以右栏在选中一行之后才去取它 —— 不在列表接口上假装那些字段存在（这正是上一版类型的错法）。

export type StatusFilter = 'all' | 'normal' | 'pending_act' | 'banned' | 'unverified';

const STATUS_OPTIONS: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全部状态' },
  { key: 'normal', label: '正常（已激活）' },
  { key: 'pending_act', label: '待激活（可读不可写）' },
  { key: 'banned', label: '已封禁' },
  { key: 'unverified', label: '邮箱未验证（不能登录）' },
];

/** 三个筛选一起送后端（?q=&status=&role=）—— 过滤在服务端做，前端不拿全表筛。 */
export type UsersFilter = { q: string; status: StatusFilter; role: string };

export type UsersScreenProps = {
  users: AdminUser[];
  /** 选中那一行的详情（GET /admin/users/{id}）：三张关联表只有它有。没选中或还没到就是 null */
  detail: AdminUserDetail | null;
  detailLoading?: boolean;
  /** 点一行 → 宿主去取详情（右栏的三张表要它） */
  onSelect: (id: string) => void;
  /** 后端游标分页的累计条数（宿主给；拿不到就传 users.length） */
  total: number;
  loading?: boolean;
  /** 取不到时的错误（宿主把 useQuery 的 error 原样传下来；屏里如实显示，不假装成功） */
  error?: { message: string; status: number } | null;
  filter: UsersFilter;
  onFilterChange: (next: UsersFilter) => void;
  /** 角色目录（GET /admin/roles）：改角色与筛选都要它 */
  roles: Role[];
  /** 头衔目录（GET /admin/titles）：发头衔时只能从这里挑 */
  titles: Title[];
  canBan: boolean;
  canAssignRole: boolean;
  canGrantTitle: boolean;
  /** 封号 / 解封；reason 必填（危险动作走 ConfirmDialog 收集，绝不自己写弹层） */
  onBan: (ids: string[], action: 'ban' | 'unban', reason: string) => void;
  /** 踢掉全部会话（封号不带踢，这是独立动作） */
  onRevokeSessions: (id: string) => void;
  onSetRole: (id: string, roleId: number) => void;
  onGrantTitle: (userId: string, titleId: string) => void;
  /** 动作回执（宿主把请求结果放这里） */
  receipt?: ReactNode;
};

export function UsersScreen({
  users, detail, detailLoading = false, onSelect, total, loading = false, error = null, filter, onFilterChange,
  roles, titles, canBan, canAssignRole, canGrantTitle,
  onBan, onRevokeSessions, onSetRole, onGrantTitle, receipt,
}: UsersScreenProps) {
  const [selected, setSelected] = useState<string[]>([]);
  const [sort, setSort] = useState<Sort>({ key: 'created_at', dir: 'desc' });
  // 选中态就在列表里（不另存 state）：屏是无状态展示，详情由宿主持有 —— 少一处会与列表错位的状态
  const activeId = detail?.id ?? null;
  const [pending, setPending] = useState<{ kind: 'ban' | 'unban'; ids: string[] } | null>(null);
  const [grantTo, setGrantTo] = useState<string | null>(null);
  const [roleTo, setRoleTo] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [size, setSize] = useState(20);

  // 详情接口那一份优先（它多三张表）；回退到列表项只在「详情还没到」的空档里用
  const activeUser: AdminUserDetail | AdminUser | null = detail ?? null;
  const selectedUsers = users.filter((u) => selected.includes(u.id));
  const bannedSelected = selectedUsers.filter((u) => u.status !== 'banned');
  const activeSelected = selectedUsers.filter((u) => u.status === 'banned');
  const batchIds = (bannedSelected.length > 0 ? bannedSelected : activeSelected).map((u) => u.id);

  // 列定义：数据驱动（列 + 行 + 排序 + 选中都交给 DataTable）。
  // 宽屏下这里只有 ~600px（左导航 + 右详情栏占掉了其余），所以列数压到 4 列：
  // 「帖子/回复 + 注册/最后登录」并进用户单元格的第二行，需要细看时看右栏。
  const columns = [
    {
      key: 'user', title: '用户', track: 'minmax(158px,1.5fr)', sortable: true, sortValue: (u: AdminUser) => u.nickname,
      render: (u: AdminUser) => (
        <span className='flex min-w-0 items-center gap-2'>
          {/* 列表项 DTO 里没有 avatar（不给密码/会话/IP，也顺手不回头像）：这一格按昵称首字起色块 */}
          <UserAvatar name={u.nickname} src={null} size='sm' />
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
      // 没有 sortable：列表项的 role 只有 key/name/badge_color 三列（AdminUserRoleRef），
      // 没有 priority 可排 —— 上一版拿 RoleItem.priority 排，那字段在这一行根本不存在。
      key: 'role', title: '角色', track: 'minmax(88px,0.8fr)',
      render: (u: AdminUser) => (
        <span className='flex min-w-0 flex-col gap-0.5 leading-tight'>
          <RoleBadge role={{ key: u.role.key, name: u.role.name, color: u.role.badge_color }} />
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
        const isSuper = u.role.key === 'superadmin';
        const banWhy = !canBan ? '本账号没有 user.ban'
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
            {canAssignRole ? <Button onClick={() => setRoleTo(u.id)}>改角色</Button> : null}
            <Button onClick={() => onSelect(u.id)}>详情</Button>
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
        actions={<Button inline={false} height={ControlsHeight.S} icon={icon16(Search)} onClick={() => onFilterChange({ ...filter, q: '' })}>重置筛选</Button>}
      />

      <StatRow>
        <Stat label='本页用户' value={total} hint='后端游标分页不给总数（只有 next_cursor），所以这里只数本页' />
        <Stat label='本页已封禁' value={users.filter((u) => u.status === 'banned').length} tone='danger' />
        <Stat label='本页待激活' value={users.filter((u) => !u.activated_at).length} hint='可读不可写（activated_at）' />
        <Stat label='本页邮箱未验证' value={users.filter((u) => !u.email_verified_at).length} hint='不能登录' />
        <Stat label='已选' value={selected.length} tone={selected.length ? 'info' : 'neutral'} hint='批量操作的对象' />
      </StatRow>

      {!canAssignRole ? (
        <GateNote perm='role.assign'>「改角色」与「批量改角色」按钮不渲染（9.8 明令：role.edit 与 role.assign 必须分成两个权限点，单持其一都不足以提权）。</GateNote>
      ) : null}

      <Toolbar>
        <Input
          label='搜索登录名 / 昵称 / 邮箱'
          icon={icon16(Search)}
          value={filter.q}
          onChange={(e) => onFilterChange({ ...filter, q: e.target.value })}
          placeholder='例如 demo-admin / 示范管理员 / @example.com'
        />
        <Select
          type={SelectType.INPUT}
          label='状态'
          data={STATUS_OPTIONS}
          selected={STATUS_OPTIONS.find((o) => o.key === filter.status) ?? null}
          onSelect={(item) => { if (item) onFilterChange({ ...filter, status: item.key as StatusFilter }); }}
        />
        <Select
          type={SelectType.INPUT}
          label='基线角色'
          data={[{ key: 'all', label: '全部角色' }, ...roles.map((r) => ({ key: r.key, label: r.name + '（' + r.key + '）' }))]}
          selected={{ key: filter.role, label: filter.role === 'all' ? '全部角色' : filter.role }}
          onSelect={(item) => { if (item) onFilterChange({ ...filter, role: String(item.key) }); }}
        />
        {canBan ? (
          <>
            <DangerAction
              disabled={batchIds.length === 0}
              why={batchIds.length === 0 ? '先在列表里勾选要处理的用户' : undefined}
              onClick={() => setPending({ kind: bannedSelected.length > 0 ? 'ban' : 'unban', ids: batchIds })}
            >
              批量{bannedSelected.length > 0 ? '停用' : '解封'}
            </DangerAction>
            <span className='text-[11px] text-muted-foreground'>{batchIds.length} 行可批量处理</span>
          </>
        ) : null}
      </Toolbar>

      {receipt}

      <div className='grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_252px]'>
        <div className='flex min-w-0 flex-col gap-2'>
          {error ? (
            <div role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
              用户列表没能加载（HTTP {error.status}）：{error.message}
            </div>
          ) : null}
          <DataTable
            columns={columns}
            rows={users}
            rowKey={(u) => u.id}
            rowLabel={(u) => u.nickname}
            selectable
            selected={selected}
            onSelectedChange={setSelected}
            selectDisabledReason={(u) => (u.role.key === 'superadmin' ? '超级管理员不参与批量操作' : null)}
            sort={sort}
            onSortChange={setSort}
            activeKey={activeId}
            onRowClick={(u) => onSelect(u.id)}
            loading={loading}
            minWidth={604}
            empty='没有符合条件的用户'
          />
          <TableFooter total={total} page={page} size={size} onPage={setPage} onSize={setSize} />
        </div>

        <div className='flex flex-col gap-2'>
          <Panel title='用户详情' note='右栏详情：三根状态轴分开显示，不合成一个「状态」'>
            {activeUser ? (
              <>
                <div className='mb-2 flex items-center gap-2'>
                  <UserAvatar name={activeUser.nickname} src={null} size='lg' />
                  <span className='flex min-w-0 flex-col leading-tight'>
                    <Username nickname={activeUser.nickname} handle={activeUser.username} strong badge='none' />
                    <span className='truncate text-[11px] text-muted-foreground'>{activeUser.email}</span>
                  </span>
                </div>
                <div className='mb-2 flex flex-wrap items-center gap-1'>
                  <RoleBadge role={{ key: activeUser.role.key, name: activeUser.role.name, color: activeUser.role.badge_color }} />
                  {detail && detail.user_titles.length > 0 ? <TitleBadge title={detail.user_titles[0]!} /> : null}
                  {activeUser.trusted ? <Pill tone='ok'>trusted：发帖免审</Pill> : <Pill>发帖进审核队列</Pill>}
                </div>
                <KV k='登录名（不可改）' v={activeUser.username} hint='DB §4.1 不变量：注册后固定' />
                <KV k='封禁轴 status' v={activeUser.status} />
                <KV k='邮箱验证轴' v={activeUser.email_verified_at ? fmtDate(activeUser.email_verified_at) : '未验证 → 不能登录'} />
                <KV k='激活轴 activated_at' v={activeUser.activated_at ? fmtDate(activeUser.activated_at) : '未激活 → 能登录、写操作 403'} />
                <KV k='注册 / 最后登录' v={fmtDate(activeUser.created_at) + ' / ' + fmtTime(activeUser.last_login_at)} />
                <Numbers items={[{ label: '帖子', value: activeUser.topic_count }, { label: '回复', value: activeUser.reply_count }]} />
              </>
            ) : (
              <p className='text-[12px] text-muted-foreground'>在左侧列表里点一行查看详情。</p>
            )}
          </Panel>

          <Panel title='追加权限（user_permissions）' note='点对点追加：带 reason 与 expires_at，到期自动失效。这两列只有详情接口给（AdminGrantDTO）。'>
            {detailLoading ? <p className='text-[12px] text-muted-foreground'>正在取详情…</p>
              : detail && detail.user_permissions.length > 0 ? (
              <div className='flex flex-col'>
                {detail.user_permissions.map((g) => (
                  <KV key={g.key} k={g.name + '（' + g.key + '）'} v={g.expires_at ? fmtDate(g.expires_at) + ' 到期' : '永久'} hint={g.reason} />
                ))}
              </div>
            ) : (
              <p className='text-[12px] text-muted-foreground'>无追加权限（基线角色已够用；RBAC：不存在「加一个角色」的第二种语义）。</p>
            )}
          </Panel>

          <Panel title='处罚记录' note='13.7 / D6 第 2 步：含已过期的行——后台要能回答「这个人被处理过几次」，删掉历史就答不了。'>
            {detailLoading ? <p className='text-[12px] text-muted-foreground'>正在取详情…</p>
              : detail && detail.sanctions.length > 0 ? (
              <div className='flex flex-col gap-1.5'>
                {detail.sanctions.map((s) => (
                  <div key={String(s.id)} className='rounded-sm border border-border px-2 py-1'>
                    <div className='flex items-center gap-1.5'>
                      {/* action 的值域是 post | reply | all（DB 的 sanctions），不是 mock 里的 mute_post */}
                      <Pill tone='danger'>{s.action === 'post' ? '禁发帖' : s.action === 'reply' ? '禁回复' : '全站禁言'}</Pill>
                      <span className='text-[12px] text-foreground'>{s.board ? '/' + s.board.slug + ' ' + s.board.name : '全站'}</span>
                      <span className='text-[11px] text-muted-foreground'>{s.until ? '至 ' + fmtDate(s.until) : '永久'}</span>
                      <span className='text-[11px] text-muted-foreground'>开单 {fmtDate(s.created_at)}</span>
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
                <Button
                  inline={false}
                  height={ControlsHeight.S}
                  icon={icon16(ShieldCheck)}
                  disabled={!canBan}
                  onClick={() => onRevokeSessions(activeUser.id)}
                >
                  踢掉全部会话
                </Button>
              </div>
              {!canBan ? <DisabledReason>没有 user.ban：停用与踢会话都不可用</DisabledReason> : null}
            </Panel>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        show={pending !== null}
        label={pending?.kind === 'unban' ? '确认解封？' : '确认停用（封号）？'}
        danger={pending?.kind !== 'unban'}
        confirmText={pending?.kind === 'unban' ? '解封' : '停用'}
        reasonLabel={pending?.kind === 'unban' ? '解封说明（可选，进审计）' : '封号理由（必填，进审计）'}
        reasonRequired={pending?.kind !== 'unban'}
        disabledReason={!canBan ? '本账号没有 user.ban，按钮不可用' : undefined}
        body={
          pending?.kind === 'unban'
            ? <span>解封后该用户可以重新登录。这是 13.7 的封号轴，与「降权」是两条独立通道。</span>
            : <span>停用会让 <b>{pending?.ids.length}</b> 个用户立刻 401（status=banned）并写入审计 <code>user.ban</code>。
                被封期间已建立的会话要另外点「踢掉全部会话」才会失效。</span>
        }
        onClose={() => setPending(null)}
        onConfirm={(reason) => {
          if (pending) onBan(pending.ids, pending.kind, reason);
          setPending(null);
        }}
      />

      <GrantTitleDialog
        titles={titles}
        user={users.find((u) => u.id === grantTo) ?? null}
        onClose={() => setGrantTo(null)}
        onGrant={onGrantTitle}
      />
      <SetRoleDialog
        roles={roles}
        user={users.find((u) => u.id === roleTo) ?? null}
        onClose={() => setRoleTo(null)}
        onSet={onSetRole}
      />
    </div>
  );
}

/** 发头衔（13.6 的第二半）：目录来自 GET /admin/titles，这里只能从目录里挑一个授予（title.grant）。 */
function GrantTitleDialog({ user, titles, onClose, onGrant }: {
  user: AdminUser | null;
  titles: Title[];
  onClose: () => void;
  onGrant: (userId: string, titleId: string) => void;
}) {
  const [titleId, setTitleId] = useState<string>('');
  if (!user) return null;
  const options = titles.filter((t) => !t.archived_at).map((t) => ({ key: t.id, label: t.name + '（' + t.key + '）' }));
  const chosen = titleId || options[0]?.key || '';
  return (
    <Dialog show label='发头衔' onCloseAttempt={onClose} onOverlayClick={onClose} onEscPress={onClose}>
      <div className='flex w-[420px] max-w-full flex-col gap-3 p-4'>
        <p className='text-[13px] text-foreground'>
          给 <b>{user.nickname}</b>（@{user.username}）授予头衔。一个用户可以持多个头衔，佩戴的只有一个（DB §4.11）。
        </p>
        {options.length === 0 ? (
          <DisabledReason>头衔目录是空的（或全在归档态）：先去「头衔目录」屏建一个。</DisabledReason>
        ) : (
          <Select
            type={SelectType.INPUT}
            label='头衔（已归档的不出现）'
            data={options}
            selected={options.find((o) => o.key === chosen) ?? null}
            onSelect={(item) => { if (item) setTitleId(String(item.key)); }}
          />
        )}
        <div className='flex items-center justify-end gap-2'>
          <Button onClick={onClose}>关闭</Button>
          <Button primary disabled={!chosen} onClick={() => { onGrant(user.id, chosen); onClose(); }}>授予</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** 改基线角色：role.assign 与 role.edit 是分开的两个点，这里要的是前者。 */
function SetRoleDialog({ user, roles, onClose, onSet }: {
  user: AdminUser | null;
  roles: Role[];
  onClose: () => void;
  onSet: (id: string, roleId: number) => void;
}) {
  const [roleId, setRoleId] = useState<number | null>(null);
  if (!user) return null;
  // 列表项的 role 只有 key（AdminUserRoleRef），**没有 id** —— 当前值要用 key 去 /admin/roles 里换 id
  const current = roleId ?? roles.find((r) => r.key === user.role.key)?.id ?? 0;
  const options = roles.map((r) => ({ key: String(r.id), label: r.name + '（' + r.key + '）' }));
  return (
    <Dialog show label='改基线角色' onCloseAttempt={onClose} onOverlayClick={onClose} onEscPress={onClose}>
      <div className='flex w-[420px] max-w-full flex-col gap-3 p-4'>
        <p className='text-[13px] text-foreground'>
          把 <b>{user.nickname}</b> 的基线角色从 <b>{user.role.name}</b> 改到下面这个。
          角色之间永不并集：这是替换，不是叠加（RBAC权限树设计.md §1）。
        </p>
        <Select
          type={SelectType.INPUT}
          label='基线角色'
          data={options}
          selected={options.find((o) => o.key === String(current)) ?? null}
          onSelect={(item) => { if (item) setRoleId(Number(item.key)); }}
        />
        <div className='flex items-center justify-end gap-2'>
          <Button onClick={onClose}>取消</Button>
          <Button primary disabled={current === 0 || current === roles.find((r) => r.key === user.role.key)?.id} onClick={() => { onSet(user.id, current); onClose(); }}>保存</Button>
        </div>
      </div>
    </Dialog>
  );
}

// 时间戳的本地展示。**不再从 ../mock/core 引**：那是示例数据层，接了真端点就不该再依赖它。
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
