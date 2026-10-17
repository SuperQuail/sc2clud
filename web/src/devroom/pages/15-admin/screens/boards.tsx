import { useEffect, useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import Toggle from '@jetbrains/ring-ui-built/components/toggle/toggle';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { ArrowDown, ArrowUp, Archive, Plus } from 'lucide-react';
import { imagePath } from '@/lib/url';
import { icon16 } from '@/ui/icons';
import { Username } from '@/ui/user/username';
import type { AdminACLItem, AdminBoard, AdminModeratorItem, Role } from '@/lib/api/admin';
import type { AdminGroup, AdminGroupACLItem } from '@/lib/api/groups';
import { DataTable } from '../data-table';
import { ConfirmDialog, DangerAction } from '../confirm';
import { DisabledReason, KV, Numbers, Panel, Pill, ScreenHead, Stat, StatRow } from '../bits';
import { ImageUploader } from '@/ui/rich/image-uploader';
import { DefaultCover } from '@/ui/topic/default-cover';
import { BoardAclPanel, GroupAclPanel, type AclToggleField } from './boards-acl';
import { NewBoardDialog } from './boards-new';

// 屏 c：分区管理 + BoardACL（13.4 + 14.3–14.4 + D6）。
//
// F9 版式的教训：上一版把「分区列表」做成一张**全宽数据表**，每行塞进 上移/下移/Toggle/配置/归档 五个控件
// （7 行 = 35 个控件），而真正的编辑区（资料 / 矩阵 / 版主）在表格**下面**——900px 视口里根本看不见。
// 所以这里保持与其它屏一致的**左列表 + 右详情**：点一行选中，行级动作全在右侧。
//
// **prop 驱动**（照 users.tsx）：数据与动作全部由宿主给（routes/admin/boards.tsx）。屏里不 import mock。
// 四处**照后端改**（上一版是照 mock 写的，那几件后端根本没有）：
//  ① 列表项**没有 sort 字段**：排序键叫 `position`（后端 row_number()），重排走 POST /admin/boards/reorder
//     （**必须给全部 id**，少一个就会有分区留在原 sort 上与别人撞在一起）；界面不让人手输数字。
//  ② **没有删除分区端点**（§21.2 只列了 POST/PATCH/reorder）：所以「删除」那颗按钮不画，只有归档
//     （PATCH status='archived'，可逆）。画一颗点了必然 404 的按钮是最坏的一种「看着正常」。
//  ③ **slug 建后不可改**：PATCH 的 body 里后端连字段都不收（改 slug = 废掉所有外链），所以编辑态它是只读的。
//  ④ **封面没有上传端点**（W-D1 交回）：这里只能显示现状、只能清空；要换图得先走图片通道拿 hash，
//     所以要做得先有 POST /admin/boards/{id}/cover。界面如实写这句话，不画一颗假的上传按钮。
// 版主任免的用户选择：**只从 GET /admin/users 的第一页里挑**（后端没有「按 handle 搜用户」的轻量读口）——
// 目标不在这一页时，屏上明写「先去用户管理搜到那个人」，不假装能搜。

const SLUG_FALLBACK = { key: 'all', label: '（未知角色）' };

export type BoardsScreenProps = {
  boards: AdminBoard[];
  loading?: boolean;
  /** 取不到时的错误（宿主把 useQuery 的 error 原样传下来；屏里如实显示） */
  error?: { message: string; status: number } | null;
  boardId: string | null;
  onSelect: (id: string) => void;
  /** 保存：只把**改动过的字段**发上去（空对象表示没有改动，屏上按钮是灰的） */
  onSave: (patch: Partial<BoardPatch>) => void;
  saving?: boolean;
  /** 保存成功后宿主把**刚保存的那一行**的发号器（每次成功 +1）发下来，屏据此把草稿重置到落库值。
   *  只认发号器：这期间管理员又敲了新字时，重置会把它冲掉 —— 所以重置只在刚保存成功那一下发生，
   *  而「又敲了新字」的那一次由宿主在下次保存时一并带走（不静默丢弃）。 */
  savedAt?: number;
  /** 换封面：把选中的图片传上去（host 走 POST /me/cover 拿 hash，再 PATCH 本分区的 cover_hash）。
   *  **选完即换**（不经过「保存 N 项改动」）：封面是一张图，让它先停在草稿里、
   *  等管理员再点一次保存，等于给「点了没反应」留了一条路。 */
  onUploadCover?: (file: Blob) => void;
  /** 传封面的按钮现在是不是在传（禁用 + 文案） */
  coverUploading?: boolean;
  onMove: (ids: string[]) => void;
  reordering?: boolean;
  /** 全站角色目录（GET /admin/roles）：ACL 矩阵的行就是它 */
  roles: Role[];
  /** 当前分区的矩阵（GET /admin/boards/{id}/acl） */
  acl: AdminACLItem[];
  aclLoading?: boolean;
  /** 保存矩阵（全量替换：整张一次 PUT）。宿主会滤掉超管的行（D40：写入不收） */
  onAclSave: (acls: AdminACLItem[]) => void;
  aclSaving?: boolean;
  /** 用户组目录（GET /admin/groups）：按组名单的行就是它（D38） */
  groups: AdminGroup[];
  /** 当前分区的按组名单（GET /admin/boards/{id}/group-acl） */
  groupAcl: AdminGroupACLItem[];
  groupAclLoading?: boolean;
  /** 保存按组名单（全量替换：整张一次 PUT） */
  onGroupAclSave: (acls: AdminGroupACLItem[]) => void;
  groupAclSaving?: boolean;
  /** 版主任期（GET /admin/boards/{id}/moderators，**含已卸任的历史行**） */
  moderators: AdminModeratorItem[];
  /** 可任命的用户（GET /admin/users 第一页）。拿不到时是空数组，屏上会说为什么 */
  candidates: { id: string; username: string; nickname: string }[];
  onGrantModerator: (userId: string, expiresAt: string) => void;
  onRevokeModerator: (userId: string) => void;
  /** 建分区（slug 只有建的时候能给） */
  onCreate: (b: { slug: string; name: string; description: string }) => void;
  /** 归档 / 取消归档（后端没有删除） */
  onSetStatus: (status: 'active' | 'archived', reason: string) => void;
  canManage: boolean;
  busy?: boolean;
  receipt?: ReactNode;
};

export type BoardPatch = { name: string; description: string; status: string; acl_enabled: boolean; min_post_level: number; cover_hash: string };
export type AclField = 'can_post' | 'can_reply' | 'deny_post' | 'deny_reply';

export function BoardsScreen({
  boards, loading = false, error = null, boardId, onSelect,
  onSave, saving = false, savedAt = 0, onUploadCover, coverUploading = false, onMove, reordering = false,
  roles, acl, aclLoading = false, onAclSave, aclSaving = false,
  groups, groupAcl, groupAclLoading = false, onGroupAclSave, groupAclSaving = false,
  moderators, candidates, onGrantModerator, onRevokeModerator, onCreate, onSetStatus,
  canManage, busy = false, receipt,
}: BoardsScreenProps) {
  const [showNew, setShowNew] = useState(false);
  const [pending, setPending] = useState<'archive' | 'unarchive' | null>(null);
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantTo, setGrantTo] = useState('');
  const [grantUntil, setGrantUntil] = useState('');
  // 草稿在屏里，**靠 key={board.id} 在换分区时重挂载**（不写 useEffect 去同步：列表每次重取都是新对象，
  // 拿它当依赖就会在每次渲染后把管理员刚敲的字冲掉）。这是 users 屏那个 UserAvatar 教训的同一类。
  const [draft, setDraft] = useState<BoardPatch | null>(null);
  const [aclDraft, setAclDraft] = useState<Record<number, AdminACLItem> | null>(null);
  const [groupAclDraft, setGroupAclDraft] = useState<Record<string, AdminGroupACLItem> | null>(null);

  const board = boards.find((b) => b.id === boardId) ?? boards[0] ?? null;
  const index = board ? boards.findIndex((b) => b.id === board.id) : -1;
  const archived = board?.status === 'archived';
  const canEdit = canManage && !archived;

  // 初始化（以及保存后对齐落库值）：draft 为 null 时从后端那一行起手；宿主把 savedBoard 发下来时
  // 也只在「草稿还等于刚发出去的那一份」的情况下才对它 —— 见下面 save() 的那一处重置。
  const d: BoardPatch = draft ?? (board ? toPatch(board) : EMPTY);
  const aclRows = aclDraft ?? Object.fromEntries(acl.map((a) => [a.role_id, { ...a }]));
  const groupAclRows = groupAclDraft ?? Object.fromEntries(groupAcl.map((a) => [a.group_key, { ...a }]));

  // 只发改动过的字段（后端 PATCH 的 body 全是指针，没发的键不动；空 body 会 400）
  const patch: Partial<BoardPatch> = {};
  if (board) {
    if (d.name !== board.name) patch.name = d.name;
    if (d.description !== board.description) patch.description = d.description;
    if (d.status !== board.status) patch.status = d.status;
    if (d.acl_enabled !== board.acl_enabled) patch.acl_enabled = d.acl_enabled;
    if (d.min_post_level !== board.min_post_level) patch.min_post_level = d.min_post_level;
    // 封面也是「改动过的字段」：空串 = 清空（后端 nil 才是「没给」，见 UpdateBoard 的注释）。
    // 上一版这里没有这一行，所以就算屏上画出「清空封面」，点保存也不会把 cover_hash 发上去。
    if (d.cover_hash !== board.cover_hash) patch.cover_hash = d.cover_hash;
  }
  const changed = Object.keys(patch);

  // 保存成功后草稿回到「以后端为准」：draft=null 会让上面的 d 重新从 board 那一行起手
  // （后端会 trim 名称/简介，所以本地草稿本来就不等于落库值）。savedAt=0 时（还没保存过）不触发。
  // 依赖里不要带 board：那会让「列表每 5 秒重取一次」把草稿清空。board 的变化由宿主的 key 重挂载处理。
  useEffect(() => { if (savedAt > 0) setDraft(null); }, [savedAt]);

  const aclChanged = (() => {
    const rows = Object.values(aclRows);
    if (rows.length !== acl.length) return true;
    return rows.some((a) => {
      const s = acl.find((x) => x.role_id === a.role_id);
      return !s || s.can_post !== a.can_post || s.can_reply !== a.can_reply || s.deny_post !== a.deny_post || s.deny_reply !== a.deny_reply;
    });
  })();

  const groupAclChanged = (() => {
    const rows = Object.values(groupAclRows);
    if (rows.length !== groupAcl.length) return true;
    return rows.some((a) => {
      const s = groupAcl.find((x) => x.group_key === a.group_key);
      return !s || s.can_post !== a.can_post || s.can_reply !== a.can_reply || s.deny_post !== a.deny_post || s.deny_reply !== a.deny_reply;
    });
  })();

  function setAcl(roleId: number, field: AclField, on: boolean) {
    const cur = aclRows[roleId] ?? { role_id: roleId, role_key: '', can_post: false, can_reply: false, deny_post: false, deny_reply: false };
    const next = { ...cur, [field]: on };
    // 「允许」与「禁止」同一格互斥：两个都勾上后端必 400（ck_board_acls_no_contradiction + service 逐条校验），
    // 所以勾一边就把对面关掉 —— 让人先勾出来再被拒，等于把一条 400 留给用户去撞。
    const flip: Record<AclField, AclField> = { can_post: 'deny_post', can_reply: 'deny_reply', deny_post: 'can_post', deny_reply: 'can_reply' };
    if (on) next[flip[field]] = false;
    setAclDraft({ ...aclRows, [roleId]: next });
  }

  // 按组名单的同款互斥（同一行「允许」与「禁止」不能同时勾上，后端会拒）
  function setGroupAcl(groupKey: string, field: AclToggleField, on: boolean) {
    const cur = groupAclRows[groupKey] ?? { group_key: groupKey, can_post: false, can_reply: false, deny_post: false, deny_reply: false };
    const next = { ...cur, [field]: on };
    const flip: Record<AclToggleField, AclToggleField> = { can_post: 'deny_post', can_reply: 'deny_reply', deny_post: 'can_post', deny_reply: 'can_reply' };
    if (on) next[flip[field]] = false;
    setGroupAclDraft({ ...groupAclRows, [groupKey]: next });
  }

  // 上移/下移：把这一行与邻居换位，然后把**全部 id** 的完整新顺序发上去（后端要求全量）
  function move(dir: -1 | 1) {
    if (!board || index < 0) return;
    const j = index + dir;
    if (j < 0 || j >= boards.length) return;
    const next = [...boards];
    const tmp = next[index]!;
    next[index] = next[j]!;
    next[j] = tmp;
    onMove(next.map((b) => b.id));
  }

  const listColumns = [
    {
      key: 'board',
      title: '分区（点一行选中）',
      track: 'minmax(0,1fr)',
      render: (b: AdminBoard) => (
        <span className='flex min-w-0 items-start gap-2'>
          {/* 没有封面时落**全站唯一那份默认封面**（@/ui/topic/default-cover），不是一枚"坏图"虚框。
              真封面走**图片端点**（imagePath → /img/<hash>）；默认那张是 public/art 静态素材（assetUrl）。 */}
          {b.cover_hash
            ? <img src={imagePath('/img/' + b.cover_hash)} alt='' width={32} height={32} className='mt-0.5 shrink-0 rounded-sm border border-border object-cover' />
            : <span className='relative mt-0.5 h-8 w-8 shrink-0 overflow-hidden rounded-sm border border-border'><DefaultCover /></span>}
          <span className='flex min-w-0 flex-col leading-tight'>
            <span className='flex min-w-0 items-center gap-1.5'>
              <span className={'truncate text-[13px] font-medium ' + (board && b.id === board.id ? 'text-primary' : 'text-foreground')}>{b.name}</span>
              {board && b.id === board.id ? <Pill tone='ok'>编辑中</Pill> : null}
            </span>
            <span className='truncate text-[11px] text-muted-foreground'>/{b.slug} · {b.topic_count} 帖子</span>
            <span className='mt-0.5 flex flex-wrap items-center gap-1'>
              <Pill tone={b.acl_enabled ? 'ok' : 'warn'}>{b.acl_enabled ? '按名单' : '登录即可'}</Pill>
              {b.status === 'archived' ? <Pill tone='danger'>已归档</Pill> : null}
              {b.moderators.length > 0 ? <Pill tone='outline'>{b.moderators.length} 版主</Pill> : null}
            </span>
          </span>
        </span>
      ),
    },
  ];

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='分区管理'
        note='建分区、排序、换封面、启停发言名单；改动只作用于这一个分区。'
        actions={
          <>
            <Button primary inline={false} height={ControlsHeight.M} icon={icon16(Plus)} disabled={!canManage || busy} onClick={() => setShowNew(true)}>
              新增分区
            </Button>
            {!canManage ? <DisabledReason>没有 board.manage：新增 / 归档 / 矩阵全部只读</DisabledReason> : null}
          </>
        }
      />

      <StatRow>
        <Stat label='分区' value={boards.length} hint='含已归档的分区' />
        <Stat label='启用发言名单' value={boards.filter((b) => b.acl_enabled).length} tone='info' hint='其余分区登录即可发言' />
        <Stat label='归档' value={boards.filter((b) => b.status === 'archived').length} hint='归档的分区只能恢复，不能删除' />
        <Stat label='帖子总数' value={boards.reduce((s, b) => s + b.topic_count, 0)} hint='全部正常可见的帖子' />
        <Stat label='今日新增' value={boards.reduce((s, b) => s + b.today_count, 0)} hint='从今天 0 点起算' />
      </StatRow>

      {error ? (
        <div role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          分区列表没能加载（HTTP {error.status}）：{error.message}
        </div>
      ) : null}
      {receipt}

      <div className='grid items-start gap-3 xl:grid-cols-[minmax(264px,304px)_minmax(0,1fr)]'>
        <div className='flex min-w-0 flex-col gap-2 xl:sticky xl:top-3'>
          <Panel title='分区列表' note='点一行编辑；顺序在右侧「分区排序」里调整'>
            <DataTable
              columns={listColumns}
              rows={boards}
              rowKey={(b) => b.id}
              rowLabel={(b) => b.name}
              activeKey={board ? board.id : null}
              onRowClick={(b) => onSelect(b.id)}
              loading={loading}
              minWidth={236}
              density='compact'
              empty='还没有分区'
            />
            <p className='mt-2 mb-0 text-[11px] text-muted-foreground'>
              共 {boards.length} 个分区 · 其中 {boards.filter((b) => b.status === 'archived').length} 个已归档（归档分区只读）
            </p>
          </Panel>
        </div>

        <div className='flex min-w-0 flex-col gap-3'>
          {!board ? (
            <Panel title='分区资料' note='左边还没有可以选的分区'>
              <p className='text-[12px] text-muted-foreground'>先建一个分区（右上角「新增分区」），或者确认后端确实返回了分区列表。</p>
            </Panel>
          ) : (
            <>
              <Panel
                title={'分区资料 · ' + board.name}
                note='改动后按「保存」生效；未保存的改动会标注出来。'
                actions={
                  <>
                    {changed.length > 0 ? <Pill tone='warn'>未保存</Pill> : <Pill tone='ok'>已保存</Pill>}
                    <Button inline={false} height={ControlsHeight.S} primary disabled={!canEdit || changed.length === 0 || busy} onClick={() => onSave(patch)}>
                      {saving ? '保存中…' : changed.length === 0 ? '没有改动' : '保存 ' + changed.length + ' 项改动'}
                    </Button>
                  </>
                }
              >
                {/* 受控输入：草稿在宿主手里，切换分区时整份换掉（不会被上一个分区的值粘住） */}
                <Input label='名称' value={d.name} disabled={!canEdit} onChange={(e) => setDraft({ ...d, name: e.target.value })} />
                <Input label='分区地址（slug，建后不可改）' value={board.slug} disabled help='它是分区链接地址的一部分，建好后不能改。' />
                <Input label='一句话简介' value={d.description} disabled={!canEdit} onChange={(e) => setDraft({ ...d, description: e.target.value })} />
                <Input
                  label='最低发帖等级（0 = 不限）'
                  value={String(d.min_post_level)}
                  disabled={!canEdit}
                  onChange={(e) => setDraft({ ...d, min_post_level: Number(e.target.value.replace(/[^0-9]/g, '') || 0) })}
                />
                {/* 封面：**换与清都在这里**（拍板 08 第二轮「壁纸替换」）。
                    上一版这一格只有一段说明 —— 不是控件坏了，是后端把空串折成 nil（清空必然 400），
                    而上传通道也还没有，所以当时刻意不画按钮。0030 与那处修复之后两条路都通了。 */}
                <div className='mt-1 flex items-start gap-3'>
                  <span className='relative flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border bg-muted'>
                    {/* 预览位也落默认封面：这里原来是一枚 ImageIcon，看起来正好像"图裂了" */}
                    {d.cover_hash
                      ? <img src={imagePath('/img/' + d.cover_hash)} alt='' width={96} height={56} className='h-full w-full object-cover' />
                      : <DefaultCover />}
                  </span>
                  <div className='flex min-w-0 flex-col gap-1.5'>
                    <span className='flex flex-wrap items-center gap-2'>
                      {/* 没给 onUploadCover 时不画上传控件（房间那一页是设计稿，没有图片通道）——
                          画的必须是一颗真能用的按钮，否则就是「点了没反应」。 */}
                      {onUploadCover ? (
                        <ImageUploader
                          variant='cover'
                          label={d.cover_hash ? '更换封面' : '加个封面'}
                          compress
                          /* D59：与个人主页封面同一个裁切口径（横幅比例，可切） */
                          crop
                          cropAspect={21 / 9}
                          cropAspectOptions={[
                            { label: '21:9', value: 21 / 9 },
                            { label: '16:9', value: 16 / 9 },
                            { label: '3:2', value: 3 / 2 },
                          ]}
                          images={[]}
                          onChange={(list) => { const f = list[0]; if (f) onUploadCover(f.file); }}
                        />
                      ) : null}
                      {d.cover_hash ? (
                        <Button
                          inline={false}
                          height={ControlsHeight.S}
                          data-testid='board-cover-clear'
                          disabled={!canEdit || busy}
                          onClick={() => setDraft({ ...d, cover_hash: '' })}
                        >
                          清空封面
                        </Button>
                      ) : null}
                      {d.cover_hash !== board.cover_hash ? <Pill tone='warn'>封面改动还没保存</Pill> : null}
                    </span>
                    <span className='text-[11px] leading-relaxed text-muted-foreground'>
                      {coverUploading
                        ? '正在上传封面…'
                        : '更换封面选完即生效；清空封面要点「保存」后才会移除。'}
                    </span>
                  </div>
                </div>
                <div className='mt-2 border-t border-border pt-2'>
                  <Numbers items={[
                    { label: '帖子', value: board.topic_count },
                    { label: '回复', value: board.post_count },
                    { label: '今日', value: board.today_count },
                    { label: '状态', value: archived ? '已归档' : '正常' },
                  ]} />
                </div>
              </Panel>

              <Panel
                title='分区排序'
                note='上移 / 下移调整整个列表的顺序；保存以列表实际回到的顺序为准'
                actions={
                  <span className='flex items-center gap-1'>
                    <Button inline={false} height={ControlsHeight.S} icon={icon16(ArrowUp)} disabled={!canManage || reordering || index <= 0} onClick={() => move(-1)}>上移</Button>
                    <Button inline={false} height={ControlsHeight.S} icon={icon16(ArrowDown)} disabled={!canManage || reordering || index < 0 || index >= boards.length - 1} onClick={() => move(1)}>下移</Button>
                  </span>
                }
              >
                <KV k='当前位置' v={(index + 1) + ' / ' + boards.length} hint='分区页签从上到下就是这个顺序' />
                <div className='mt-1.5'>
                  <DisabledReason>
                    {!canManage
                      ? '没有 board.manage：排序只读'
                      : index === 0
                        ? '已经是第一个（最上面），上移已禁用'
                        : index === boards.length - 1
                          ? '已经是最后一个，下移已禁用'
                          : '保存后列表会按新顺序刷新显示'}
                  </DisabledReason>
                </div>
              </Panel>

              <Panel
                title='发言名单判定'
                note='打开后按下面的名单与等级门槛判定；关闭则任何登录用户都能在此发帖与回复。'
                actions={
                  <Toggle
                    checked={d.acl_enabled}
                    disabled={!canEdit}
                    onChange={(e) => setDraft({ ...d, acl_enabled: e.target.checked })}
                  >
                    {d.acl_enabled ? '按名单判定' : '登录即可发言'}
                  </Toggle>
                }
              >
                <span className='flex flex-wrap items-center gap-2'>
                  <Pill tone={d.acl_enabled ? 'ok' : 'warn'}>当前状态：{d.acl_enabled ? '按名单判定' : '登录即可发言'}</Pill>
                  {archived ? <Pill tone='danger'>分区已归档：开关只读</Pill> : null}
                  {d.acl_enabled !== board.acl_enabled ? <Pill tone='warn'>改动还没保存</Pill> : null}
                </span>
                <div className='mt-2 flex flex-col gap-1 rounded-md border border-dashed border-border px-2.5 py-2 text-[12px] leading-relaxed text-muted-foreground'>
                  <span className='font-medium text-foreground'>关掉这个开关后，会同时发生三件事：</span>
                  <span>① 任何登录用户都能在这里发帖与回复（名单与等级门槛都不再检查）；</span>
                  <span>② 下面两张名单（按角色 / 按用户组）暂不生效——勾选保留，重新打开即恢复，不用重配；</span>
                  <span>③ 被停言的用户依然不能发言（停言比名单更早判定）。</span>
                </div>
              </Panel>

              {aclLoading ? (
                <p className='text-[12px] text-muted-foreground'>正在取这一分区的权限矩阵…</p>
              ) : (
                <BoardAclPanel
                  boardName={board.name}
                  aclEnabled={d.acl_enabled}
                  roles={roles}
                  acl={acl}
                  draft={aclRows}
                  canEdit={canEdit}
                  dirty={aclChanged}
                  saving={aclSaving}
                  onSet={setAcl}
                  onSave={() => onAclSave(Object.values(aclRows).filter((a) => a.role_key !== 'superadmin'))}
                />
              )}

              {groupAclLoading ? (
                <p className='text-[12px] text-muted-foreground'>正在取按组名单…</p>
              ) : (
                <GroupAclPanel
                  boardName={board.name}
                  groups={groups}
                  acl={groupAcl}
                  draft={groupAclRows}
                  canEdit={canEdit}
                  dirty={groupAclChanged}
                  saving={groupAclSaving}
                  onSet={setGroupAcl}
                  onSave={() => onGroupAclSave(Object.values(groupAclRows))}
                />
              )}

              <Panel
                title='分区版主任免'
                note='任命可带期限；卸任的记录保留，历史任期在这里一并显示。'
                actions={
                  canManage
                    ? <Button inline={false} height={ControlsHeight.S} icon={icon16(Plus)} disabled={archived || busy} onClick={() => setGrantOpen((v) => !v)}>任命版主</Button>
                    : undefined
                }
              >
                {moderators.length === 0 ? <p className='text-[12px] text-muted-foreground'>该分区还没有版主（也没有历史任期）。</p> : null}
                <div className='flex flex-col gap-1.5'>
                  {moderators.map((m) => (
                    <div key={m.user_id + m.granted_at} className='flex items-center justify-between gap-2 rounded-sm border border-border px-2 py-1'>
                      <Username nickname={m.nickname} handle={m.handle} size='sm' badge='none' />
                      <span className='flex items-center gap-1'>
                        <span className='text-[10px] text-muted-foreground'>任命 {fmtDate(m.granted_at)}</span>
                        {m.grown_at
                          ? <Pill tone='neutral'>已卸任 {fmtDate(m.grown_at)}</Pill>
                          : <span className='text-[10px] text-muted-foreground'>{m.expires_at ? fmtDate(m.expires_at) + ' 到期' : '长期'}</span>}
                        {m.grown_at ? null : (
                          <DangerAction
                            disabled={!canManage || archived}
                            why={archived ? '分区已归档' : undefined}
                            onClick={() => onRevokeModerator(m.user_id)}
                          >
                            免职
                          </DangerAction>
                        )}
                      </span>
                    </div>
                  ))}
                </div>

                {grantOpen ? (
                  <div className='mt-2 flex flex-col gap-2 rounded-md border border-dashed border-border p-2'>
                    {candidates.length === 0 ? (
                      <DisabledReason>
                        候选人列表是空的（读取用户列表需要 user.ban）——先去用户管理搜到那个人，再回来任命。
                      </DisabledReason>
                    ) : (
                      <Select
                        type={SelectType.INPUT}
                        label='任命的用户（列表第一页可挑；要更精确先去用户管理里搜）'
                        data={[{ key: '', label: '（选一个人）' }, ...candidates.map((u) => ({ key: u.id, label: u.nickname + '（' + u.username + '）' }))]}
                        selected={candidates.find((u) => u.id === grantTo) ? { key: grantTo, label: candidates.find((u) => u.id === grantTo)!.nickname } : SLUG_FALLBACK}
                        onSelect={(item) => { if (item) setGrantTo(String(item.key)); }}
                      />
                    )}
                    <Input
                      label='任期到（可空 = 永久）'
                      value={grantUntil}
                      onChange={(e) => setGrantUntil(e.target.value)}
                      placeholder='2026-12-31'
                      help='填日期按当天结束时刻生效；必须是将来的日期。'
                    />
                    <div className='flex items-center justify-end gap-2'>
                      <Button onClick={() => setGrantOpen(false)}>取消</Button>
                      <Button primary disabled={!grantTo || busy} onClick={() => { onGrantModerator(grantTo, grantUntil.trim()); setGrantOpen(false); setGrantUntil(''); }}>
                        任命
                      </Button>
                    </div>
                  </div>
                ) : null}
              </Panel>

              <Panel title='危险动作' note='归档可以撤销；分区暂不支持删除'>
                <div className='flex flex-wrap items-center gap-2'>
                  {archived ? (
                    <Button inline={false} height={ControlsHeight.S} disabled={!canManage || busy} onClick={() => setPending('unarchive')}>取消归档（改回 active）</Button>
                  ) : (
                    <DangerAction disabled={!canManage || busy} why={!canManage ? '本账号没有 board.manage' : undefined} onClick={() => setPending('archive')}>
                      <span className='flex items-center gap-1'><Archive size={13} aria-hidden />归档分区</span>
                    </DangerAction>
                  )}
                </div>
                <p className='mt-2 mb-0 text-[11px] leading-relaxed text-muted-foreground'>
                  归档后分区不再出现在公开列表，帖子与回复保留可读；名单勾选原样保留，取消归档即恢复。
                  分区暂不支持删除。
                </p>
              </Panel>
            </>
          )}
        </div>
      </div>

      <NewBoardDialog show={showNew} onClose={() => setShowNew(false)} onCreate={(b) => { onCreate(b); setShowNew(false); }} />

      <ConfirmDialog
        show={pending !== null}
        label={pending === 'unarchive' ? '取消归档？' : '归档这个分区？'}
        danger={pending === 'archive'}
        confirmText={pending === 'unarchive' ? '改回 active' : '归档分区'}
        reasonLabel={pending === 'unarchive' ? '说明（可选，进审计）' : '归档理由（可选，进审计）'}
        reasonRequired={false}
        body={pending === 'unarchive'
          ? <span><b>{board ? board.name : ''}</b> 会重新出现在公开分区列表里；原来的 ACL 勾选原样生效。</span>
          : <span>归档后 <b>{board ? board.name : ''}</b> 不再出现在分区列表，帖子与回复保留可读；分区里的 ACL 勾选随之失效（内容不动）。归档是可逆的。</span>}
        onClose={() => setPending(null)}
        onConfirm={(reason) => { onSetStatus(pending === 'unarchive' ? 'active' : 'archived', reason); setPending(null); }}
      />
    </div>
  );
}

const EMPTY: BoardPatch = { name: '', description: '', status: 'active', acl_enabled: false, min_post_level: 0, cover_hash: '' };

const toPatch = (b: AdminBoard): BoardPatch => ({
  name: b.name, description: b.description, status: b.status,
  acl_enabled: b.acl_enabled, min_post_level: b.min_post_level, cover_hash: b.cover_hash,
});

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
