import { useEffect, useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Plus, Trash2, UserMinus } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { Username } from '@/ui/user/username';
import type { AdminGroup, AdminGroupMember } from '@/lib/api/groups';
import { ConfirmDialog, DangerAction } from '../confirm';
import { DisabledReason, Panel, Pill, ScreenHead, Stat, StatRow } from '../bits';
import { DataTable } from '../data-table';

// 屏 a2：用户组（D38）。建组、把指定用户拉进组；「这些组能不能在某个分区发言 / 回帖」
// 在分区管理屏的按组名单里配 —— 这一屏只管「组是什么、谁在里面」。
// 组名单是判定直接查的表（不进任何缓存），所以加人 / 移出当场生效。
//
// **prop 驱动**（照 users / boards）：数据与动作全由宿主给（routes/admin/groups.tsx）。屏里不 import mock。
// 候选人照 boards 屏同一条现实：只从用户列表第一页挑（没有「按 handle 搜人」的轻量读口），
// 目标不在第一页时屏上明写「先去用户管理搜到那个人」。

export type GroupsScreenProps = {
  groups: AdminGroup[];
  loading?: boolean;
  /** 取不到时的错误（宿主把 useQuery 的 error 原样传下来；屏里如实显示） */
  error?: { message: string; status: number } | null;
  groupId: string | null;
  onSelect: (id: string) => void;
  /** 建组（key 只有建的时候能给） */
  onCreate: (b: { key: string; name: string; description: string }) => void;
  /** 保存组资料：只把两个字段发上去（后端只收 name / description） */
  onSave: (id: string, patch: { name: string; description: string }) => void;
  /** 删组：成员与分区组行一起清掉（ ConfirmDialog 里收一句可选说明） */
  onDelete: (id: string) => void;
  /** 动作成功后宿主发号（每次 +1），屏据此把草稿对齐到落库值 */
  savedAt?: number;
  creating?: boolean;
  saving?: boolean;
  deleting?: boolean;
  /** 组员名单（最近入组的在前） */
  members: AdminGroupMember[];
  membersLoading?: boolean;
  /** 可入组的用户（用户列表第一页；拿不到时是空数组，屏上会说为什么） */
  candidates: { id: string; username: string; nickname: string }[];
  onAddMember: (userId: string) => void;
  onRemoveMember: (userId: string) => void;
  addingMember?: boolean;
  canManage: boolean;
  /** 候选人读口（user.ban） орг汀了这屏的闸；没有它屏只照名单给「去用户管理」的指引 */
  loadingCandidatesFailed?: boolean;
  busy?: boolean;
  receipt?: ReactNode;
};

const EMPTY_PICK = { key: "", label: "（选一个人）" };

export function GroupsScreen({
  groups, loading = false, error = null, groupId, onSelect,
  onCreate, onSave, onDelete, savedAt = 0, saving = false, deleting = false,
  members, membersLoading = false, candidates, onAddMember, onRemoveMember, addingMember = false,
  canManage, loadingCandidatesFailed = false, busy = false, receipt,
}: GroupsScreenProps) {
  const [showNew, setShowNew] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [pendingDelete, setPendingDelete] = useState(false);
  const [pickTo, setPickTo] = useState("");

  // 草稿在屏里：宿主用 key={group.id} 换组重挂载（boards 屏同一套），保存成功后用 savedAt 对齐落库值。
  const [draft, setDraft] = useState<{ name: string; description: string } | null>(null);
  useEffect(() => { if (savedAt > 0) setDraft(null); }, [savedAt]);

  const group = groups.find((g) => g.id === groupId) ?? groups[0] ?? null;
  const d = draft ?? (group ? { name: group.name, description: group.description } : { name: "", description: "" });
  const dirty = group != null && (d.name !== group.name || d.description !== group.description);

  const columns = [
    {
      key: "group",
      title: "用户组（点一行选中）",
      track: "minmax(0,1fr)",
      render: (g: AdminGroup) => (
        <span className='flex min-w-0 items-center gap-2'>
          <span className='flex min-w-0 flex-col leading-tight'>
            <span className='flex min-w-0 items-center gap-1.5'>
              <span className={"truncate text-[13px] font-medium " + (group && g.id === group.id ? "text-primary" : "text-foreground")}>{g.name}</span>
              {group && g.id === group.id ? <Pill tone='ok'>编辑中</Pill> : null}
            </span>
            <span className='truncate text-[11px] text-muted-foreground'>{g.key} · {g.member_count} 成员</span>
          </span>
        </span>
      ),
    },
  ];

  function create() {
    onCreate({ key: newKey.trim(), name: newName.trim(), description: newDesc.trim() });
    setShowNew(false);
    setNewKey("");
    setNewName("");
    setNewDesc("");
  }

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='用户组'
        note='把指定的用户拉进同一个组，再去分区管理里给这些组授「能不能发言 / 能不能回帖」。组员变动当场生效。'
        actions={(
          <>
            <Button primary inline={false} height={ControlsHeight.M} icon={icon16(Plus)} disabled={!canManage || busy} onClick={() => setShowNew((v) => !v)}>新建组</Button>
            {!canManage ? <DisabledReason>没有 user.ban：建组 / 拉人 / 移出都只读</DisabledReason> : null}
          </>
        )}
      />

      <StatRow>
        <Stat label='用户组' value={groups.length} hint="组本身不授任何权限；在分区名单里才生效" />
        <Stat label='组员合计' value={groups.reduce((s, g) => s + g.member_count, 0)} tone='info' hint='各组成员数合计（一人可进多个组）' />
      </StatRow>

      {error ? (
        <div role='alert' className='rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[12px] text-foreground'>
          用户组列表没能加载（HTTP {error.status}）：{error.message}
        </div>
      ) : null}
      {receipt}

      <div className='grid items-start gap-3 xl:grid-cols-[minmax(264px,304px)_minmax(0,1fr)]'>
        <div className='flex min-w-0 flex-col gap-2 xl:sticky xl:top-3'>
          <Panel title='组列表' note='按 key 排序；成员数会跟着名单变动'>
            <DataTable
              columns={columns}
              rows={groups}
              rowKey={(g) => g.id}
              rowLabel={(g) => g.name}
              activeKey={group ? group.id : null}
              onRowClick={(g) => onSelect(g.id)}
              loading={loading}
              minWidth={236}
              density='compact'
              empty='还没有用户组'
            />
            <p className='mt-2 mb-0 text-[11px] text-muted-foreground'>共 {groups.length} 个组</p>
          </Panel>
        </div>

        <div className='flex min-w-0 flex-col gap-3'>
          {!group ? (
            <Panel title='组资料' note='左边还没有可以选的组'>
              <p className='text-[12px] text-muted-foreground'>先建一个用户组（右上角「新建组」）。</p>
            </Panel>
          ) : (
            <>
              <Panel
                title={'组资料 · ' + group.name}
                note='改动后按「保存」生效；标识（key）建后不可改。'>
                {dirty ? <Pill tone='warn'>未保存</Pill> : <Pill tone='ok'>已保存</Pill>}
                <Button inline={false} height={ControlsHeight.S} primary disabled={!canManage || !dirty || busy} onClick={() => onSave(group.id, { name: d.name, description: d.description })}>
                  {saving ? '保存中…' : dirty ? '保存改动' : '没有改动'}
                </Button>
                <Input label='名称' value={d.name} disabled={!canManage} onChange={(e) => setDraft({ ...d, name: e.target.value })} />
                <Input label='标识（key）' value={group.key} disabled help='建后不可改：它是在分区名单里引用这个组的名字。' />
                <Input label='一句话说明（可选）' value={d.description} disabled={!canManage} onChange={(e) => setDraft({ ...d, description: e.target.value })} />
                <div className='mt-2 border-t border-border pt-2'>
                  <DisabledReason>组本身不授权：到分区管理的「按组名单」里给组授发言 / 回帖资格后，成员才会真正多出那条许可。</DisabledReason>
                </div>
              </Panel>

              <Panel
                title={'成员 · ' + group.name}
                note='最近入组的在前；移出后这个人在分区里立刻失去按组授予的资格。'>
                {canManage ? (
                  <Select
                    type={SelectType.INPUT}
                    label='从用户列表第一页选人入组（目标不在时先去用户管理搜）'
                    data={[EMPTY_PICK, ...candidates.map((u) => ({ key: u.id, label: u.nickname + '（' + u.username + '）' }))]}
                    selected={candidates.find((u) => u.id === pickTo) ? { key: pickTo, label: candidates.find((u) => u.id === pickTo)!.nickname } : EMPTY_PICK}
                    onSelect={(item) => { if (item) setPickTo(String(item.key)); }}
                  />
                ) : null}
                {candidates.length === 0 && canManage ? (
                  <DisabledReason>候选人列表是空的 —— 先去用户管理搜到那个人，再来这里拉人。</DisabledReason>
                ) : null}
                {candidates.length === 0 && loadingCandidatesFailed ? (
                  <DisabledReason>用户列表还没取到（读取用户列表需要 user.ban）。</DisabledReason>
                ) : null}
                <Button inline={false} height={ControlsHeight.S} icon={icon16(Plus)} disabled={!canManage || !pickTo || busy || addingMember} onClick={() => { onAddMember(pickTo); setPickTo(''); }}>
                  加入组
                </Button>
                {membersLoading ? <p className='text-[12px] text-muted-foreground'>正在取组员名单…</p> : null}
                {!membersLoading && members.length === 0 ? <p className='text-[12px] text-muted-foreground'>这个组还没有成员。</p> : null}
                <div className='flex flex-col gap-1.5'>
                  {members.map((m) => (
                    <div key={m.user_id} className='flex items-center justify-between gap-2 rounded-sm border border-border px-2 py-1'>
                      <Username nickname={m.nickname} handle={m.handle} size='sm' badge='none' />
                      <span className='flex items-center gap-1'>
                        <span className='text-[10px] text-muted-foreground'>{fmtDate(m.added_at)} 入组</span>
                        {canManage ? (
                          <DangerAction disabled={busy} onClick={() => onRemoveMember(m.user_id)}>
                            <span className='flex items-center gap-1'><UserMinus size={13} aria-hidden />移出</span>
                          </DangerAction>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel title='危险动作' note='删组会同时清掉成员与分区里这个组的授权行'>
                <DangerAction disabled={!canManage || busy} onClick={() => setPendingDelete(true)}>
                  <span className='flex items-center gap-1'><Trash2 size={13} aria-hidden />删除这个组</span>
                </DangerAction>
              </Panel>
            </>
          )}
        </div>
      </div>

      {showNew ? (
        <Panel title='新建用户组' className='max-w-md'>
          <Input label='标识（key）' value={newKey} onChange={(e) => setNewKey(e.target.value)} help='建后不可改：小写字母、数字与连字符。' />
          <Input label='名称' value={newName} onChange={(e) => setNewName(e.target.value)} />
          <Input label='说明（可选）' value={newDesc} onChange={(e) => setNewDesc(e.target.value)} />
          <div className='mt-2 flex items-center justify-end gap-2'>
            <Button onClick={() => setShowNew(false)}>取消</Button>
            <Button primary disabled={!canManage || busy} onClick={create}>建组</Button>
          </div>
        </Panel>
      ) : null}

      <ConfirmDialog
        show={pendingDelete}
        label='删除这个用户组？'
        disabledReason={deleting ? '删除进行中…' : undefined}
        danger
        confirmText='删除组'
        reasonLabel={'说明（可选，进审计）'}
        body={group ? <span><b>{group.name}</b> 会连同 {group.member_count} 名成员与分区里这个组的授权一起被删除。</span> : <span />}
        onClose={() => setPendingDelete(false)}
        onConfirm={() => { onDelete(group ? group.id : ""); setPendingDelete(false); }}
      />
    </div>
  );
}


function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
