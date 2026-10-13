import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { Archive, ArrowDown, ArrowUp, Image as ImageIcon, Plus, Trash2 } from 'lucide-react';
import { assetUrl } from '@/lib/url';
import { icon16 } from '@/ui/icons';
import { UserBadge } from '@/ui/user/user-badge';
import { DataTable } from '../data-table';
import { ConfirmDialog, DangerAction } from '../confirm';
import { DisabledReason, GateNote, KV, Numbers, Panel, Pill, ScreenHead, Stat, StatRow } from '../bits';
import { aclOf, BOARD_MODERATORS, BOARDS, fmtDate, ROLES, type AdminBoard, type BoardAcl } from '../mock';
import { canInBoard, MOCK_MODERATED_BOARDS, useCan } from '../mock/perms';
import { BoardAclPanel } from './boards-acl';
import { NewBoardDialog, type NewBoard } from './boards-new';

// 屏 c：分区管理 + BoardACL（13.4 + 14.3–14.4 + D6）。
//
// F9 版式的教训：上一版把「分区列表」做成一张**全宽数据表**，每行塞进 上移/下移/Toggle/配置/归档 五个控件
// （7 行 = 35 个控件），而真正的编辑区（资料 / 矩阵 / 版主）在表格**下面**——900px 视口里根本看不见，
// 选中态只是行上一抹很淡的底色。管理员的心智是「选中一个分区 → 编辑它」；表格适合**筛选与并排比较**，
// 不适合承载「选中后去别处编辑」，所以这里改成与其它屏一致的**左列表 + 右详情**（users.tsx 同款 shell）：
//   · 左：一行一个分区（封面缩略图 + 名称 + slug + 权限/状态徽标），点一行即选中，xl:sticky 常驻；
//   · 右：选中分区的全部设置。行级动作全部收进右侧，列表里不再有按钮。
// acl_enabled 也从「表里一列的 7 个开关」收成**右侧一个开关 + 当前结论 + 后果说明**：这个开关影响面很大，
// 一个 Toggle 说不清（关掉 = 回到「登录即可发言」，矩阵整体失效，但 Sanction 仍拒）。

type Draft = Record<string, BoardAcl>;
type Pending = { kind: 'archive' | 'delete'; board: AdminBoard } | null;

export function BoardsScreen() {
  const canManage = useCan('board.manage');
  // 列表 = 本地状态（上一版在 move() 里原地改 mock 数组，会污染模块级数据：切走再回来顺序就乱了）
  const [boards, setBoards] = useState<AdminBoard[]>(() => [...BOARDS].sort((a, b) => a.sort - b.sort));
  const [boardId, setBoardId] = useState(BOARDS[0]!.id);
  const [draft, setDraft] = useState<Draft>(() => Object.fromEntries(
    BOARDS.flatMap((b) => ROLES.map((r) => [b.id + ':' + r.id, aclOf(b.id, r.id)])),
  ));
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(BOARDS.map((b) => [b.id, b.acl_enabled])));
  // 未保存标记：**默认没有改动 = 已保存**（上一版用 !saved[id] 判断，一进页面就写着「未保存」）
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});
  const [pending, setPending] = useState<Pending>(null);
  const [showNew, setShowNew] = useState(false);

  const board = boards.find((b) => b.id === boardId) ?? boards[0]!;
  const index = boards.findIndex((b) => b.id === board.id);
  const aclEnabled = enabled[board.id] ?? false;
  const dirty = Boolean(dirtyMap[board.id]);
  const canEditAcl = canManage && board.status === 'active';
  const scoped = canInBoard(board.slug, 'board.moderate');
  const moderators = BOARD_MODERATORS.filter((m) => m.board_id === board.id);

  function markDirty() {
    setDirtyMap((p) => ({ ...p, [board.id]: true }));
  }

  function setAcl(roleId: string, field: keyof Omit<BoardAcl, 'board_id' | 'role_id'>, on: boolean) {
    setDraft((prev) => ({ ...prev, [board.id + ':' + roleId]: { ...prev[board.id + ':' + roleId]!, [field]: on } }));
    markDirty();
  }

  function move(dir: -1 | 1) {
    setBoards((list) => {
      const i = list.findIndex((b) => b.id === board.id);
      const j = i + dir;
      if (j < 0 || j >= list.length) return list;
      const next = [...list];
      const tmp = next[i]!;
      next[i] = next[j]!;
      next[j] = tmp;
      // 真实实现是 PATCH /admin/boards/{id} 的 sort（或批量排序端点）；这里重排后按 10 的间隔重写值
      return next.map((b, idx) => ({ ...b, sort: (idx + 1) * 10 }));
    });
    markDirty();
  }

  function createBoard(input: NewBoard) {
    const id = 'b_new_' + (boards.length + 1);
    const next: AdminBoard = {
      id, slug: input.slug, name: input.name, description: input.description,
      sort: (boards.length + 1) * 10, status: 'active', cover_file: 'starcraft/sc2-logo.webp',
      acl_enabled: false, topic_count: 0, post_count: 0, today_count: 0,
    };
    setBoards((list) => [...list, next]);
    setDraft((prev) => ({ ...prev, ...Object.fromEntries(ROLES.map((r) => [id + ':' + r.id, aclOf(id, r.id)])) }));
    setEnabled((prev) => ({ ...prev, [id]: false }));
    setDirtyMap((prev) => ({ ...prev, [id]: true }));
    setBoardId(id);
    setShowNew(false);
  }

  function applyPending() {
    if (!pending) return;
    const target = pending.board;
    if (pending.kind === 'archive') {
      setBoards((list) => list.map((b) => (b.id === target.id ? { ...b, status: 'archived' } : b)));
      markDirty();
    } else {
      const rest = boards.filter((b) => b.id !== target.id);
      setBoards(rest);
      setBoardId(rest[0] ? rest[0].id : '');
    }
    setPending(null);
  }

  // 左列表只有一列：一行一个分区，封面 + 名称 + slug + 权限/状态徽标。
  // 为什么不再分列：这是一个 300px 宽的**选择器**，不是用来并排比较数值的表——列一多就会挤成「文字逐字换行」。
  const listColumns = [
    {
      key: 'board',
      title: '分区（点一行选中）',
      track: 'minmax(0,1fr)',
      render: (b: AdminBoard) => (
        <span className='flex min-w-0 items-start gap-2'>
          <img src={assetUrl(b.cover_file)} alt='' width={32} height={32} className='mt-0.5 shrink-0 rounded-sm border border-border object-cover' />
          <span className='flex min-w-0 flex-col leading-tight'>
            <span className='flex min-w-0 items-center gap-1.5'>
              <span className={'truncate text-[13px] font-medium ' + (b.id === board.id ? 'text-primary' : 'text-foreground')}>{b.name}</span>
              {b.id === board.id ? <Pill tone='ok'>编辑中</Pill> : null}
            </span>
            <span className='truncate text-[11px] text-muted-foreground'>/{b.slug} · {b.topic_count} 主题</span>
            <span className='mt-0.5 flex flex-wrap items-center gap-1'>
              <Pill tone={enabled[b.id] ? 'ok' : 'warn'}>{enabled[b.id] ? '按 ACL' : '登录即可'}</Pill>
              {b.status === 'archived' ? <Pill tone='danger'>已归档</Pill> : null}
            </span>
          </span>
        </span>
      ),
    },
  ];

  const archiveWhy = !canManage ? '本账号没有 board.manage' : board.status === 'archived' ? '已经是归档状态' : undefined;
  const deleteWhy = !canManage
    ? '本账号没有 board.manage'
    : board.topic_count > 0
      ? '还有 ' + board.topic_count + ' 个主题：先迁移或归档，不能直接删（主题不能失去归属）'
      : undefined;

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='分区管理 · BoardACL'
        note='13.4 + D6：分区表驱动（新增分区零代码改动）；发言权限落在 board_acls 上，boards.acl_enabled 关闭时整张表不生效。'
        actions={
          <>
            <Button primary icon={icon16(Plus)} disabled={!canManage} onClick={() => setShowNew(true)}>
              新增分区
            </Button>
            {!canManage ? <DisabledReason>没有 board.manage：新增 / 归档 / 删除全部只读</DisabledReason> : null}
          </>
        }
      />

      <StatRow>
        <Stat label='分区' value={boards.length} hint='表驱动，非枚举' />
        <Stat label='启用 ACL' value={boards.filter((b) => enabled[b.id]).length} tone='info' hint='其余为「登录即可发言」' />
        <Stat label='归档' value={boards.filter((b) => b.status === 'archived').length} />
        <Stat label='主题总数' value={boards.reduce((s, b) => s + b.topic_count, 0)} />
        <Stat label='我管理的分区' value={MOCK_MODERATED_BOARDS.length} hint={MOCK_MODERATED_BOARDS.join('、')} />
      </StatRow>

      <div className='grid items-start gap-3 xl:grid-cols-[minmax(264px,304px)_minmax(0,1fr)]'>
        {/* 左：选择器。选中态三处一起给：底色 + 名称变主色 + 「编辑中」徽标，不靠一抹淡底色 */}
        <div className='flex min-w-0 flex-col gap-2 xl:sticky xl:top-3'>
          <Panel title='分区列表' note='列表顺序 = sort 值；改顺序在右侧「分区排序」里，上移/下移即可'>
            <DataTable
              columns={listColumns}
              rows={boards}
              rowKey={(b) => b.id}
              rowLabel={(b) => b.name}
              activeKey={board.id}
              onRowClick={(b) => setBoardId(b.id)}
              minWidth={236}
              density='compact'
              empty='还没有分区'
            />
            <p className='mt-2 mb-0 text-[11px] text-muted-foreground'>
              共 {boards.length} 个分区 · 其中 {boards.filter((b) => b.status === 'archived').length} 个已归档（归档分区只读）
            </p>
          </Panel>
        </div>

        {/* 右：选中分区的全部设置 */}
        <div className='flex min-w-0 flex-col gap-3'>
          <Panel
            title={'分区资料 · ' + board.name}
            note='分区是表驱动的一行数据。slug 改掉会让旧链接失效，真实实现里这一步要单独确认。'
            actions={
              <>
                {dirty ? <Pill tone='warn'>未保存</Pill> : <Pill tone='ok'>已保存</Pill>}
                <Button disabled={!canManage || !dirty} onClick={() => setDirtyMap((p) => ({ ...p, [board.id]: false }))}>保存</Button>
              </>
            }
          >
            {/* key 绑定分区 id：Input 是非受控的，切换分区时必须让它重新挂载，否则输入框里还留着上一个分区的值 */}
            <Input key={board.id + ':name'} label='名称' defaultValue={board.name} disabled={!canManage} onChange={markDirty} />
            <Input key={board.id + ':slug'} label='slug（URL 用，改动会让旧链接失效）' defaultValue={board.slug} disabled={!canManage} onChange={markDirty} />
            <Input key={board.id + ':desc'} label='一句话简介' defaultValue={board.description} disabled={!canManage} onChange={markDirty} />
            <div className='mt-1 flex items-center gap-2'>
              <span className='flex h-10 w-14 items-center justify-center overflow-hidden rounded-sm border border-border bg-muted'>
                <img src={assetUrl(board.cover_file)} alt='' width={56} height={40} className='object-cover' />
              </span>
              <Button icon={icon16(ImageIcon)} disabled={!canManage}>更换封面</Button>
              <span className='text-[11px] text-muted-foreground'>cover_hash → /img/hash（nginx 直出）</span>
            </div>
            <div className='mt-2 border-t border-border pt-2'>
              <Numbers items={[
                { label: '主题', value: board.topic_count },
                { label: '回复', value: board.post_count },
                { label: '今日', value: board.today_count },
                { label: '状态', value: board.status === 'archived' ? '已归档' : '正常' },
              ]} />
            </div>
          </Panel>

          <Panel
            title='分区排序'
            note='sort 是数字，但界面不让人手输：手输没法知道「10 和 20 之间还有没有位置」，上移/下移才是管理员的心智'
            // 这里不用 ButtonSet 包：ButtonSet 容器带 font-size:0（消 inline-block 间隙的老写法），
            // 而 Ring 的 inline 按钮是 font-size:inherit —— 文字会被算成 0 宽，只剩图标（实测：上移/下移 20px 宽）。
            actions={
              <span className='flex items-center gap-1'>
                <Button icon={icon16(ArrowUp)} disabled={!canManage || index === 0} onClick={() => move(-1)}>上移</Button>
                <Button icon={icon16(ArrowDown)} disabled={!canManage || index === boards.length - 1} onClick={() => move(1)}>下移</Button>
              </span>
            }
          >
            <KV k='当前位置' v={(index + 1) + ' / ' + boards.length} hint='分区页签从上到下就是这个顺序' />
            <KV k='sort 值' v={board.sort} hint='相邻留 10 的间隔，方便以后插队' />
            <div className='mt-1.5'>
              <DisabledReason>
                {!canManage
                  ? '没有 board.manage：排序只读'
                  : index === 0
                    ? '已经是第一个（最上面），上移已禁用'
                    : index === boards.length - 1
                      ? '已经是最后一个，下移已禁用'
                      : '真实实现：PATCH /admin/boards/{id} 的 sort（或批量排序端点），改动写审计'}
              </DisabledReason>
            </div>
          </Panel>

          {/* acl_enabled：开关 + 当前结论 + 后果，三件一起给。上一版只有表里一个 Toggle（写着「按 ACL / 登录即可」两个词），
              影响面说不清；它的解释还被藏在下方矩阵的横幅里，要滚过去才看得到。 */}
          <Panel
            title='发言权限（boards.acl_enabled）'
            note='这一个开关决定 board_acls 整张表生不生效——它是 D6 的第 3 步，比角色矩阵更早判定'
            actions={
              <Toggle
                checked={aclEnabled}
                disabled={!canEditAcl}
                onChange={(e) => {
                  setEnabled((p) => ({ ...p, [board.id]: e.target.checked }));
                  markDirty();
                }}
              >
                {aclEnabled ? '按 ACL 判定' : '登录即可发言'}
              </Toggle>
            }
          >
            <span className='flex flex-wrap items-center gap-2'>
              <Pill tone={aclEnabled ? 'ok' : 'warn'}>当前结论：{aclEnabled ? '按 ACL 判定' : '登录即可发言'}</Pill>
              <Pill tone='outline'>D6 第 {aclEnabled ? '4–6' : '3'} 步先命中</Pill>
              {board.status === 'archived' ? <Pill tone='danger'>分区已归档：开关只读</Pill> : null}
            </span>
            <div className='mt-2 flex flex-col gap-1 rounded-md border border-dashed border-border px-2.5 py-2 text-[12px] leading-relaxed text-muted-foreground'>
              <span className='font-medium text-foreground'>关掉这个开关 = 把分区交还给「登录即可发言」，具体是这三件事：</span>
              <span>① 任何登录用户都能发帖与回复——判定在第 3 步直接放行，后面的 ACL 不再看；</span>
              <span>② 下面那张角色矩阵整体失效（勾选保留，重新打开就恢复，不用重配）；</span>
              <span>③ 但分区级禁言（Sanction）仍然生效：它在第 2 步就更早判定（20.2 第 21 条）。</span>
            </div>
            {!canManage ? (
              <div className='mt-2'>
                <DisabledReason>没有 board.manage：开关只读（前端只决定显不显示，判定在后端 §9.8）</DisabledReason>
              </div>
            ) : null}
          </Panel>

          <BoardAclPanel board={board} aclEnabled={aclEnabled} draft={draft} canEdit={canEditAcl} onSet={setAcl} />

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

          <Panel title='危险动作' note='归档与删除都要写审计；删除比归档更狠，理由必填'>
            <div className='flex flex-wrap items-center gap-2'>
              <DangerAction disabled={!canManage || board.status === 'archived'} why={archiveWhy} onClick={() => setPending({ kind: 'archive', board })}>
                <span className='flex items-center gap-1'><Archive size={13} aria-hidden />归档分区</span>
              </DangerAction>
              <DangerAction disabled={!canManage || board.topic_count > 0} why={deleteWhy} onClick={() => setPending({ kind: 'delete', board })}>
                <span className='flex items-center gap-1'><Trash2 size={13} aria-hidden />删除分区</span>
              </DangerAction>
            </div>
            <p className='mt-2 mb-0 text-[11px] leading-relaxed text-muted-foreground'>
              为什么删除常常是灰的：分区下还有主题时删除会让主题失去归属，所以<strong className='font-medium text-foreground'>有主题的分区只能归档</strong>；
              归档是可逆的（改状态位），删除不可逆（§21.2 的 DELETE 只在空分区上开放）。
            </p>
          </Panel>
        </div>
      </div>

      {!canManage ? <DisabledReason>本账号没有 board.manage：分区增删改与 ACL 保存全部只读</DisabledReason> : null}

      <NewBoardDialog show={showNew} onClose={() => setShowNew(false)} onCreate={createBoard} />

      <ConfirmDialog
        show={pending !== null}
        label={pending && pending.kind === 'delete' ? '删除这个分区？' : '归档这个分区？'}
        danger
        confirmText={pending && pending.kind === 'delete' ? '删除分区' : '归档分区'}
        reasonLabel={pending && pending.kind === 'delete' ? '删除理由（必填，进审计）' : '归档理由（可选，进审计）'}
        reasonRequired={pending ? pending.kind === 'delete' : false}
        body={pending && pending.kind === 'delete' ? (
          <span>
            删除后 <b>{pending.board.name}</b> 的分区记录不复存在，<b>该操作不可撤销</b>；
            分区下没有主题才允许走到这一步。
          </span>
        ) : (
          <span>
            归档后 <b>{pending ? pending.board.name : ''}</b> 不再出现在分区列表，主题与回复保留可读；分区里的 ACL 勾选随之失效。
            归档是可逆的：需要时把 status 改回 active 即可。
          </span>
        )}
        onClose={() => setPending(null)}
        onConfirm={applyPending}
      />
    </div>
  );
}
