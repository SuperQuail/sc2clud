import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { ArrowDown, ArrowUp, Image as ImageIcon, Trash2 } from 'lucide-react';
import { assetUrl } from '@/lib/url';
import { icon16 } from '@/ui/icons';
import { UserBadge } from '@/ui/user/user-badge';
import { DataTable, type Sort } from '../data-table';
import { ConfirmDialog, DangerAction } from '../confirm';
import { DisabledReason, GateNote, KV, Panel, Pill, ScreenHead, Stat, StatRow } from '../bits';
import { aclOf, BOARD_MODERATORS, BOARDS, fmtDate, ROLES, type AdminBoard, type BoardAcl } from '../mock';
import { canInBoard, MOCK_MODERATED_BOARDS, useCan } from '../mock/perms';

// 屏 c：分区管理 + BoardACL（13.4 + 14.3–14.4 + D6）。
// 重点是**禁止优先**的视觉表达：命中 deny 的角色行标红，并指出它在 D6 判定顺序的第 4 步先被拒绝。

type Draft = Record<string, BoardAcl>;

const D6_STEPS = [
  'actor.IsSuper → 放行',
  '有 Sanction 命中（20.2 第 21 条）→ 拒绝',
  'boards.acl_enabled = false → 放行（回到「登录即可发帖」）',
  '任一角色命中 deny_post / deny_reply → 拒绝',
  '任一角色命中 can_post / can_reply → 放行',
  '都没命中 → 拒绝（该分区是白名单制）',
];

export function BoardsScreen() {
  const canManage = useCan('board.manage');
  const [boardId, setBoardId] = useState(BOARDS[0]!.id);
  const [draft, setDraft] = useState<Draft>(() => Object.fromEntries(
    BOARDS.flatMap((b) => ROLES.map((r) => [b.id + ':' + r.id, aclOf(b.id, r.id)])),
  ));
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(BOARDS.map((b) => [b.id, b.acl_enabled])));
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [archive, setArchive] = useState<AdminBoard | null>(null);
  const [sort, setSort] = useState<Sort>({ key: 'sort', dir: 'asc' });

  const board = BOARDS.find((b) => b.id === boardId)!;
  const aclEnabled = enabled[board.id] ?? false;
  const scoped = canInBoard(board.slug, 'board.moderate');
  const moderators = BOARD_MODERATORS.filter((m) => m.board_id === board.id);
  const anyDeny = ROLES.some((r) => {
    const a = draft[board.id + ':' + r.id]!;
    return a.deny_post || a.deny_reply;
  });

  function setAcl(roleId: string, field: keyof Omit<BoardAcl, 'board_id' | 'role_id'>, on: boolean) {
    setDraft((prev) => ({ ...prev, [board.id + ':' + roleId]: { ...prev[board.id + ':' + roleId]!, [field]: on } }));
    setSaved((p) => ({ ...p, [board.id]: false }));
  }

  function move(b: AdminBoard, dir: -1 | 1) {
    // mock 里只动本地顺序（真实实现是 PATCH /admin/boards/{id} 的 sort 或批量排序端点）
    const list = [...BOARDS].sort((x, y) => x.sort - y.sort);
    const i = list.findIndex((x) => x.id === b.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const tmp = list[i]!;
    list[i] = list[j]!;
    list[j] = tmp;
    list.forEach((x, idx) => { x.sort = (idx + 1) * 10; });
  }

  const columns = [
    {
      key: 'sort', title: '排序', track: '92px', sortable: true, sortValue: (b: AdminBoard) => b.sort,
      render: (b: AdminBoard) => (
        <span className='flex items-center gap-0.5'>
          <span className='w-6 text-[12px] text-muted-foreground'>{b.sort}</span>
          <Button transparent icon={icon16(ArrowUp)} aria-label='上移' disabled={!canManage || b.sort <= 10} onClick={() => move(b, -1)} />
          <Button transparent icon={icon16(ArrowDown)} aria-label='下移' disabled={!canManage} onClick={() => move(b, 1)} />
        </span>
      ),
    },
    {
      key: 'name', title: '分区', track: 'minmax(210px,1.5fr)', sortable: true, sortValue: (b: AdminBoard) => b.name,
      render: (b: AdminBoard) => (
        <span className='flex min-w-0 items-center gap-2'>
          <img src={assetUrl(b.cover_file)} alt='' width={34} height={24} className='rounded-sm object-cover' />
          <span className='flex min-w-0 flex-col leading-tight'>
            <span className='truncate text-[13px] font-medium text-foreground'>{b.name}</span>
            <span className='truncate text-[11px] text-muted-foreground'>/{b.slug} · {b.description}</span>
          </span>
        </span>
      ),
    },
    {
      key: 'stats', title: '主题 / 回复 / 今日', track: 'minmax(112px,0.9fr)', align: 'end' as const,
      render: (b: AdminBoard) => (
        <span className='text-[12px] text-muted-foreground'>{b.topic_count} / {b.post_count} / <span className='text-primary'>{b.today_count}</span></span>
      ),
    },
    {
      key: 'acl', title: 'acl_enabled', track: 'minmax(112px,0.9fr)',
      render: (b: AdminBoard) => (
        <span className='flex items-center gap-1' onClick={(e) => e.stopPropagation()}>
          <Toggle
            checked={enabled[b.id] ?? false}
            disabled={!canManage}
            onChange={(e) => { setEnabled((p) => ({ ...p, [b.id]: e.target.checked })); setSaved((p) => ({ ...p, [b.id]: false })); }}
          >
            {enabled[b.id] ? '按 ACL' : '登录即可'}
          </Toggle>
        </span>
      ),
    },
    {
      key: 'status', title: '状态', track: '84px',
      render: (b: AdminBoard) => <Pill tone={b.status === 'archived' ? 'warn' : 'ok'}>{b.status === 'archived' ? '已归档' : '正常'}</Pill>,
    },
    {
      key: 'actions', title: '就地操作', track: 'minmax(150px,1fr)',
      render: (b: AdminBoard) => (
        <span className='flex items-center gap-1.5' onClick={(e) => e.stopPropagation()}>
          <Button onClick={() => setBoardId(b.id)}>配置</Button>
          <DangerAction
            disabled={!canManage || b.status === 'archived'}
            why={!canManage ? '本账号没有 board.manage' : b.status === 'archived' ? '已经是归档状态' : undefined}
            onClick={() => setArchive(b)}
          >
            <span className='flex items-center gap-1'><Trash2 size={13} aria-hidden />归档</span>
          </DangerAction>
        </span>
      ),
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='分区管理 · BoardACL'
        note='13.4 + D6：分区表驱动（新增分区零代码改动）；发言权限落在 board_acls 上，boards.acl_enabled 关闭时整张表不生效。'
      />

      <StatRow>
        <Stat label='分区' value={BOARDS.length} hint='表驱动，非枚举' />
        <Stat label='启用 ACL' value={BOARDS.filter((b) => enabled[b.id]).length} tone='info' hint='其余为「登录即可发帖」' />
        <Stat label='归档' value={BOARDS.filter((b) => b.status === 'archived').length} />
        <Stat label='主题总数' value={BOARDS.reduce((s, b) => s + b.topic_count, 0)} />
        <Stat label='我管理的分区' value={MOCK_MODERATED_BOARDS.length} hint={MOCK_MODERATED_BOARDS.join('、')} />
      </StatRow>

      <DataTable
        columns={columns}
        rows={BOARDS}
        rowKey={(b) => b.id}
        rowLabel={(b) => b.name}
        sort={sort}
        onSortChange={setSort}
        activeKey={boardId}
        onRowClick={(b) => setBoardId(b.id)}
        minWidth={780}
        density='compact'
        empty='还没有分区'
      />

      <div className='grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_280px]'>
        <Panel
          title={'发言权限矩阵 · ' + board.name}
          note='角色 × 分区：can_post / can_reply / deny_post / deny_reply（禁止优先）'
          actions={
            <>
              {!saved[board.id] && canManage ? <Pill tone='warn'>未保存</Pill> : <Pill tone='ok'>已保存</Pill>}
              <ButtonSet>
                <Button disabled={!canManage} onClick={() => setSaved((p) => ({ ...p, [board.id]: true }))}>保存 ACL</Button>
              </ButtonSet>
            </>
          }
        >
          {!aclEnabled ? (
            <div className='mb-2 rounded-md border border-dashed border-border px-2 py-1.5 text-[11px] text-muted-foreground'>
              <b className='text-foreground'>acl_enabled = false</b>：下面这些勾选<b>全部不生效</b>，回到「登录即可发帖」的默认（D6 第 3 步）。
            </div>
          ) : null}

          <div className='grid grid-cols-[minmax(120px,1.2fr)_repeat(4,64px)_minmax(120px,1fr)] items-center gap-x-1 gap-y-1 border-b border-border pb-1 text-[11px] text-muted-foreground'>
            <span>角色</span>
            <span className='text-center'>发帖</span>
            <span className='text-center'>回复</span>
            <span className='text-center'>禁发帖</span>
            <span className='text-center'>禁回复</span>
            <span className='pl-2'>本分区结论（D6）</span>
          </div>

          {ROLES.map((r) => {
            const a = draft[board.id + ':' + r.id]!;
            const deny = a.deny_post;
            const allow = a.can_post;
            return (
              <div
                key={r.id}
                className={'grid grid-cols-[minmax(120px,1.2fr)_repeat(4,64px)_minmax(120px,1fr)] items-center gap-x-1 border-b border-border py-1.5 last:border-0 ' + (deny ? 'bg-destructive/6' : '')}
              >
                <span className='flex min-w-0 flex-col leading-tight'>
                  <span className='truncate text-[12px] font-medium text-foreground'>{r.name}</span>
                  <span className='truncate text-[10px] text-muted-foreground'>{r.key}</span>
                </span>
                {(['can_post', 'can_reply', 'deny_post', 'deny_reply'] as const).map((f) => (
                  <span key={f} className='flex justify-center'>
                    <Checkbox
                      aria-label={r.name + ' ' + f}
                      label={null}
                      checked={a[f]}
                      indeterminate={false}
                      disabled={!canManage || board.status === 'archived'}
                      onChange={(e) => setAcl(r.id, f, e.target.checked)}
                    />
                  </span>
                ))}
                <span className='flex items-center gap-1 pl-2'>
                  {deny ? (
                    <Pill tone='danger'>发帖：第 4 步先拒绝</Pill>
                  ) : allow ? (
                    <Pill tone='ok'>发帖：第 5 步放行</Pill>
                  ) : (
                    <Pill tone='warn'>发帖：第 6 步拒绝（白名单制）</Pill>
                  )}
                </span>
              </div>
            );
          })}

          <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>
            D6 写的是「<b>任一</b>角色命中 deny」，那是给旧站「一人多组」模型写的；本项目一个人只有一个基线角色
            （RBAC权限树设计.md §1），所以实际判定就是「该用户那一行」。这条口径见回报的存疑项。
          </p>
        </Panel>

        <div className='flex flex-col gap-2'>
          <Panel title='D6 判定顺序' note='service 层，不在中间件里（路由参数里没有 board id）'>
            <ol className='flex flex-col gap-1 text-[12px] text-foreground'>
              {D6_STEPS.map((s, i) => {
                const hot = (!aclEnabled && i === 2) || (aclEnabled && anyDeny && i === 3) || (aclEnabled && !anyDeny && i === 5);
                return (
                  <li key={s} className={'flex gap-2 rounded-sm px-1.5 py-1 ' + (hot ? 'bg-primary/10 text-primary' : 'text-muted-foreground')}>
                    <span className='shrink-0 font-medium'>{i + 1}</span>
                    <span>{s}</span>
                  </li>
                );
              })}
            </ol>
          </Panel>

          <Panel title='分区基础信息' note='分区是表驱动的：新增分区零代码改动（旧站写成枚举 + 静默丢弃未知 key）'>
            <Input label='名称' defaultValue={board.name} />
            <Input label='slug（URL 用，改动会让旧链接失效）' defaultValue={board.slug} />
            <Input label='一句话简介' defaultValue={board.description} />
            <div className='mt-1 flex items-center gap-2'>
              <span className='flex h-10 w-14 items-center justify-center overflow-hidden rounded-sm border border-border bg-muted'>
                <img src={assetUrl(board.cover_file)} alt='' width={56} height={40} className='object-cover' />
              </span>
              <Button icon={icon16(ImageIcon)} disabled={!canManage}>更换封面</Button>
            </div>
            <KV k='acl_enabled' v={aclEnabled ? '按 ACL 判定' : '登录即可发帖'} />
            <KV k='状态' v={board.status} />
          </Panel>

          <Panel title='分区版主任免' note='board_moderators（带期限）：作用域授权，与全局基线正交'>
            {scoped ? (
              <>
                {moderators.length === 0 ? <p className='text-[12px] text-muted-foreground'>该分区还没有版主。</p> : null}
                <div className='flex flex-col gap-1.5'>
                  {moderators.map((m) => (
                    <div key={m.user.handle} className='flex items-center justify-between gap-2 rounded-sm border border-border px-2 py-1'>
                      <UserBadge user={{ ...m.user, role: null, title: null }} size='sm' showHandle />
                      <span className='flex items-center gap-1'>
                        <span className='text-[10px] text-muted-foreground'>{m.expires_at ? fmtDate(m.expires_at) + ' 到期' : '长期'}</span>
                        <DangerAction why={undefined} onClick={() => {}}>免职</DangerAction>
                      </span>
                    </div>
                  ))}
                </div>
                <Button className='mt-2' disabled={!canManage}>添加版主</Button>
              </>
            ) : (
              <GateNote perm='board.moderate'>
                只对 board_moderators 命中的分区渲染任免入口。本账号命中的分区是 {MOCK_MODERATED_BOARDS.join('、')}，当前分区 /{board.slug} 不在其中。
              </GateNote>
            )}
          </Panel>
        </div>
      </div>

      {!canManage ? <DisabledReason>本账号没有 board.manage：分区增删改与 ACL 保存全部只读</DisabledReason> : null}

      <ConfirmDialog
        show={archive !== null}
        label='归档这个分区？'
        danger
        confirmText='归档分区'
        body={<span>归档后 <b>{archive?.name}</b> 不再出现在分区列表，主题与回复保留可读；分区里的 ACL 勾选随之失效。</span>}
        reasonLabel='归档理由（可选，进审计）'
        onClose={() => setArchive(null)}
        onConfirm={() => setArchive(null)}
      />
    </div>
  );
}