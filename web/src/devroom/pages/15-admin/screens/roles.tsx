import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { RoleBadge } from '@/ui/user/role-badge';
import { ConfirmDialog, DangerAction } from '../confirm';
import { DisabledReason, GateNote, KV, Panel, Pill, ScreenHead, Toolbar } from '../bits';
import { PERMISSIONS, PERM_GROUPS, ROLES, ROLE_PERMS, type AdminRole } from '../mock';
import { useCan } from '../mock/perms';

// 屏 b：角色 × 权限矩阵（13.5 用户组管理 + 9.8 + RBAC权限树设计.md）。
// 三个不能再造错的东西：
//   ① 角色是**树**，一个人只有一个基线角色（角色之间永不并集，只做「基线 ∪ 点对点追加」）；
//   ② 权限点的唯一真源是**后端代码常量**，后台不能新增权限点（所以这里没有「新建权限点」按钮）；
//   ③ role.edit（改矩阵）与 role.assign（给人分配）是两个权限点 —— 单持其一都不足以提权。

const DANGEROUS = ['user.ban', 'role.edit', 'role.assign', 'board.manage', 'mail.manage', 'site.setting', 'system.settings', 'audit.view', 'title.manage'];

function ancestorsOf(roleId: string): AdminRole[] {
  const out: AdminRole[] = [];
  let cur = ROLES.find((r) => r.id === roleId)?.parent_id ?? null;
  while (cur) {
    const parent = ROLES.find((r) => r.id === cur);
    if (!parent) break;
    out.push(parent);
    cur = parent.parent_id;
  }
  return out;
}

export function RolesScreen() {
  const canEdit = useCan('role.edit');
  const canAssign = useCan('role.assign');

  const [roleId, setRoleId] = useState(ROLES[2]!.id);
  const [draft, setDraft] = useState<Record<string, string[]>>(() => ({ ...ROLE_PERMS }));
  const [savedAt, setSavedAt] = useState<string>('2026-10-12T02:00:00Z');
  const [confirmDelete, setConfirmDelete] = useState<AdminRole | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const role = ROLES.find((r) => r.id === roleId)!;
  const current = draft[role.id] ?? [];
  const saved = ROLE_PERMS[role.id] ?? [];
  const added = current.filter((p) => !saved.includes(p));
  const removed = saved.filter((p) => !current.includes(p));
  const dirty = added.length + removed.length > 0;
  // 父角色链上已有的权限点（写穿结果）与本角色缺了父角色的哪些点——后者是 DB §12 自检 2 的界面版
  const inherited = new Set(ancestorsOf(role.id).flatMap((a) => draft[a.id] ?? []));
  const parentMissing = [...inherited].filter((p) => !current.includes(p));
  const dangerousAdded = added.filter((p) => DANGEROUS.includes(p));
  const readOnlyMatrix = role.key === 'superadmin';

  function toggle(perm: string, on: boolean) {
    setDraft((prev) => {
      const set = new Set(prev[role.id] ?? []);
      if (on) set.add(perm); else set.delete(perm);
      return { ...prev, [role.id]: [...set] };
    });
  }

  function setGroup(grp: string, on: boolean) {
    const keys = PERMISSIONS.filter((p) => p.grp === grp).map((p) => p.key);
    setDraft((prev) => {
      const set = new Set(prev[role.id] ?? []);
      for (const k of keys) { if (on) set.add(k); else set.delete(k); }
      return { ...prev, [role.id]: [...set] };
    });
  }

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='角色与权限矩阵'
        note='9.8：角色可以在后台配，权限点必须在代码里。矩阵按 grp 分组；改完有「未保存 / 已保存」态与影响预览。'
        actions={
          <Toolbar>
            <Button onClick={() => setCreateOpen(true)}>新建自定义角色</Button>
            <DangerAction
              disabled={role.is_system || role.member_count > 0}
              why={role.is_system ? '内置角色不可删（service 层挡，不只是界面不显示按钮）' : role.member_count > 0 ? '还有 ' + role.member_count + ' 个用户在用（users.role_id 是 RESTRICT）' : undefined}
              onClick={() => setConfirmDelete(role)}
            >
              删除该角色
            </DangerAction>
          </Toolbar>
        }
      />

      {!canAssign ? (
        <GateNote perm='role.assign'>「把该角色分配给用户」这个入口不渲染。本账号能改矩阵（role.edit）、不能分配角色（role.assign）——这正是 9.8 要的结构：单持其一不足以给自己提权。</GateNote>
      ) : null}

      <div className='grid items-start gap-3 lg:grid-cols-[214px_minmax(0,1fr)]'>
        <Panel title='角色树' note='parent_id 层级；一个人只有一个基线角色'>
          <div className='flex flex-col gap-0.5'>
            {ROLES.slice().sort((a, b) => a.depth - b.depth || a.priority - b.priority).map((r) => (
              <span key={r.id} style={{ paddingLeft: r.depth * 12 }} className='flex items-center gap-1'>
                <Button active={r.id === roleId} onClick={() => setRoleId(r.id)} className='justify-start'>
                  {r.name}
                </Button>
                <span className='shrink-0 text-[10px] text-muted-foreground'>{r.member_count}</span>
              </span>
            ))}
          </div>
          <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>
            内置角色：{ROLES.filter((r) => r.is_system).map((r) => r.key).join('、')}；
            自定义角色可增删改名（这里只做 moderator 一个示例）。
          </p>
        </Panel>

        <div className='flex min-w-0 flex-col gap-2'>
          <Panel
            title={'权限矩阵 · ' + role.name}
            note={role.description}
            actions={
              <>
                <Pill tone={dirty ? 'warn' : 'ok'}>{dirty ? '未保存：+' + added.length + ' / −' + removed.length : '已保存'}</Pill>
                <ButtonSet>
                  <Button disabled={!canEdit || readOnlyMatrix || !dirty} onClick={() => { setDraft((p) => ({ ...p, [role.id]: [...saved] })); }}>放弃改动</Button>
                  <Button
                    primary
                    disabled={!canEdit || readOnlyMatrix || !dirty}
                    onClick={() => { setDraft((p) => ({ ...p, [role.id]: [...(p[role.id] ?? [])] })); setSavedAt('2026-10-12T13:45:00Z'); }}
                  >
                    保存矩阵
                  </Button>
                </ButtonSet>
              </>
            }
          >
            <div className='mb-2 flex flex-wrap items-center gap-2'>
              <RoleBadge role={role} />
              <Pill>{role.is_system ? '内置角色' : '自定义角色'}</Pill>
              <Pill>{role.member_count} 个用户在用</Pill>
              <span className='text-[11px] text-muted-foreground'>上次保存：{savedAt.slice(11, 16)} UTC（mock）</span>
            </div>
            {readOnlyMatrix ? (
              <DisabledReason>超管的矩阵只读：后端在 authz.Require 与中间件里都短路（9.8），矩阵对它没有意义，改它只会产生一个骗人的勾。</DisabledReason>
            ) : null}
            {!canEdit ? <DisabledReason>本账号没有 role.edit：整张矩阵只读</DisabledReason> : null}

            <div className='flex flex-col gap-3 pt-2'>
              {PERM_GROUPS.map((grp) => {
                const items = PERMISSIONS.filter((p) => p.grp === grp);
                const on = items.filter((p) => current.includes(p.key)).length;
                return (
                  <div key={grp} className='rounded-md border border-border p-2'>
                    <div className='mb-1 flex flex-wrap items-center justify-between gap-2'>
                      <span className='text-[12px] font-medium text-foreground'>
                        {grp}
                        <span className='ml-1 text-[11px] font-normal text-muted-foreground'>{on} / {items.length}</span>
                      </span>
                      <ButtonSet>
                        <Button disabled={!canEdit || readOnlyMatrix} onClick={() => setGroup(grp, true)}>全选</Button>
                        <Button disabled={!canEdit || readOnlyMatrix} onClick={() => setGroup(grp, false)}>清空</Button>
                      </ButtonSet>
                    </div>
                    <div className='grid gap-1.5 md:grid-cols-2'>
                      {items.map((p) => (
                        <span key={p.key} className='flex flex-col'>
                          <Checkbox
                            label={p.key}
                            help={p.description}
                            checked={current.includes(p.key)}
                            indeterminate={false}
                            disabled={!canEdit || readOnlyMatrix}
                            onChange={(e) => toggle(p.key, e.target.checked)}
                          />
                          {inherited.has(p.key) ? (
                            <span className='pl-6 text-[10px] text-muted-foreground'>继承自父角色（写穿）</span>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Panel>

          <Panel title='影响预览' note='保存前先看清「这次变更会让谁多拿到什么」——提权是攻击者的第一目标（9.8 审计）'>
            {dirty ? (
              <>
                <div className='flex flex-wrap items-center gap-2'>
                  <Pill tone={dangerousAdded.length > 0 ? 'danger' : 'warn'}>
                    影响 {role.member_count} 个用户
                  </Pill>
                  <Pill>新增 {added.length} 个权限点</Pill>
                  <Pill>移除 {removed.length} 个权限点</Pill>
                  {dangerousAdded.length > 0 ? <Pill tone='danger'>含提权类变更，会写审计 role.edit</Pill> : null}
                </div>
                <div className='mt-2 flex flex-col gap-1'>
                  {added.map((p) => <KV key={'a' + p} k={'+ ' + p} v={PERMISSIONS.find((x) => x.key === p)?.description ?? ''} />)}
                  {removed.map((p) => <KV key={'r' + p} k={'− ' + p} v='受影响用户下次请求即生效（权限缓存主动失效）' />)}
                  {parentMissing.length > 0 ? (
                    <KV k='写穿自检' v={'缺少父角色的 ' + parentMissing.length + ' 个权限点：' + parentMissing.join('、')} hint='DB §12 自检 2：子角色集合必须 ⊇ 父角色' />
                  ) : (
                    <KV k='写穿自检' v='通过：本角色集合 ⊇ 父角色集合' />
                  )}
                </div>
              </>
            ) : (
              <p className='text-[12px] text-muted-foreground'>还没有改动。勾选右侧任意权限点，这里会立刻给出影响范围。</p>
            )}
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        show={confirmDelete !== null}
        label='删除这个角色？'
        danger
        confirmText='删除角色'
        body={<span>删除 <b>{confirmDelete?.name}</b> 后 role_permissions 会级联删除；users.role_id 是 RESTRICT，仍有用户在用时数据库会直接拒绝——先给这些人换角色。</span>}
        disabledReason={confirmDelete?.is_system ? '内置角色不可删（service 层挡）' : undefined}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => setConfirmDelete(null)}
      />

      <CreateRoleDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateRoleDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [parentId, setParentId] = useState(ROLES[1]!.id);
  const parents = ROLES.map((r) => ({ key: r.id, label: r.name + '（depth ' + r.depth + '）' }));
  if (!open) return null;
  return (
    <Dialog show label='新建自定义角色' onCloseAttempt={onClose} onOverlayClick={onClose} onEscPress={onClose}>
      <div className='flex w-[420px] max-w-full flex-col gap-3 p-4'>
        <Input label='角色名' placeholder='例如：资源区维护' />
        <Input label='key（小写，不可改）' placeholder='resource_keeper' />
        <Select
          type={SelectType.INPUT}
          label='父角色（权限从它复制一份，之后各自维护）'
          data={parents}
          selected={parents.find((p) => p.key === parentId) ?? null}
          onSelect={(item) => { if (item) setParentId(String(item.key)); }}
        />
        <p className='text-[11px] leading-relaxed text-muted-foreground'>
          新建后要做的两件事（见 RBAC权限树设计.md §8）：① 复制父角色的权限集合；② 跑自检 2（子 ⊇ 父）。
          权限点不能在这里新增 —— 那是代码常量 + 迁移的事。
        </p>
        <div className='flex justify-end gap-2'>
          <Button onClick={onClose}>取消</Button>
          <Button primary onClick={onClose}>创建</Button>
        </div>
      </div>
    </Dialog>
  );
}