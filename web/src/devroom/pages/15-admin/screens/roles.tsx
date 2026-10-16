import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import { RoleBadge } from '@/ui/user/role-badge';
import type { Permission, Role } from '@/lib/api/admin';
import { ConfirmDialog } from '../confirm';
import { DisabledReason, GateNote, KV, Panel, Pill, ScreenHead, Toolbar } from '../bits';

// 屏 b：角色 × 权限矩阵（13.5 用户组管理 + §9.8 + RBAC权限树设计.md）。
// **prop 驱动**：取数在 routes/admin-screens.tsx 的容器里。
//
// 三个不能再造错的东西：
//   ① 角色是**树**，一个人只有一个基线角色（角色之间永不并集，只做「基线 ∪ 点对点追加」）；
//   ② 权限点的唯一真源是**后端代码常量**（permissions 表由迁移写入），后台不能新增权限点
//      —— 所以没有「新建权限点」，也没有「新建角色 / 删除角色」：**后端没有那两个端点**
//      （§5.2 只列了矩阵读法；mock 里那两颗按钮点了必然 404，所以直接不画）。
//   ③ `role.edit`（改矩阵）与 `role.assign`（给人分配）是两个权限点 —— 单持其一都不足以提权。
//
// 与旧版（mock）不同的两处：
//   · `RoleItem.id` 是**数字**（后端的自增主键），不是 mock 的字符串；
//   · **后端没有 `parent_id`** —— 它给的是 `depth` 与「已展开的并集」`perm_keys`。
//     所以「继承自父角色（写穿）」这条提示在这屏上做不到：拿不到父角色是谁。
//     （DB §12 自检 2「子 ⊇ 父」因此也只能在后端跑，屏上那一栏删掉了。）

export type RolesScreenProps = {
  roles: Role[];
  permissions: Permission[];
  loading?: boolean;
  error?: ReactNode;
  canEdit: boolean;
  /** 保存矩阵：**全量替换**（空数组 = 清空这个角色的权限） */
  onSave: (roleId: number, permKeys: string[]) => void;
  busy?: boolean;
  receipt?: ReactNode;
};

export function RolesScreen({ roles, permissions, loading = false, error = null, canEdit, onSave, busy = false, receipt }: RolesScreenProps) {
  const [roleId, setRoleId] = useState<number | null>(roles[0]?.id ?? null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [confirmClear, setConfirmClear] = useState<Role | null>(null);

  const role = roles.find((r) => r.id === roleId) ?? roles[0] ?? null;
  const current = draft ?? role?.perm_keys ?? [];
  const saved = role?.perm_keys ?? [];
  const added = current.filter((p) => !saved.includes(p));
  const removed = saved.filter((p) => !current.includes(p));
  const dirty = added.length + removed.length > 0;
  const readOnly = !canEdit || Boolean(role?.is_super) || busy;

  const groups = [...new Set(permissions.map((p) => p.group))];
  const descOf = (key: string) => permissions.find((p) => p.key === key)?.name ?? '';
  const dangerousAdded = added.filter((p) => DANGEROUS.includes(p));

  function pick(next: number) {
    setRoleId(next);
    setDraft(null); // 换角色 = 丢弃未保存的草稿（它属于上一个角色）
  }

  function toggle(perm: string, on: boolean) {
    const set = new Set(current);
    if (on) set.add(perm); else set.delete(perm);
    setDraft([...set]);
  }

  function setGroup(grp: string, on: boolean) {
    const set = new Set(current);
    for (const p of permissions.filter((x) => x.group === grp)) {
      if (on) set.add(p.key); else set.delete(p.key);
    }
    setDraft([...set]);
  }

  return (
    <div className='flex flex-col gap-3'>
      <ScreenHead
        title='角色与权限矩阵'
        note='角色可以在后台配，权限点必须在代码里。矩阵按 group 分组；改完有「未保存 / 已保存」态与影响预览。新建与删除角色**后端没有端点**，所以这里没有那两颗按钮。'
      />

      {!canEdit ? <GateNote perm='role.edit'>整张矩阵只读：本账号没有 role.edit。</GateNote> : null}
      {receipt}
      {error}

      <div className='grid items-start gap-3 lg:grid-cols-[214px_minmax(0,1fr)]'>
        <Panel title='角色' note='按 depth / priority 排序（后端给的顺序）'>
          <div className='flex flex-col gap-0.5'>
            {roles.map((r) => (
              <span key={r.id} className='flex items-center gap-1'>
                <Button active={r.id === role?.id} onClick={() => pick(r.id)} className='justify-start'>{r.name}</Button>
                <span className='shrink-0 text-[10px] text-muted-foreground'>{r.user_count}</span>
              </span>
            ))}
          </div>
          <p className='mt-2 text-[11px] leading-relaxed text-muted-foreground'>
            内置角色：{roles.filter((r) => r.is_system).map((r) => r.key).join('、') || '—'}；
            自定义角色可增删改名 —— **但后端还没有那两个端点**，所以本屏只做矩阵。
          </p>
        </Panel>

        <div className='flex min-w-0 flex-col gap-2'>
          {role ? (
            <Panel
              title={'权限矩阵 · ' + role.name}
              note={role.description}
              actions={
                <>
                  <Pill tone={dirty ? 'warn' : 'ok'}>{dirty ? '未保存：+' + added.length + ' / −' + removed.length : '已保存'}</Pill>
                  <ButtonSet>
                    <Button disabled={readOnly || !dirty} onClick={() => setDraft(null)}>放弃改动</Button>
                    <Button primary disabled={readOnly || !dirty} onClick={() => onSave(role.id, current)}>保存矩阵</Button>
                  </ButtonSet>
                </>
              }
            >
              <div className='mb-2 flex flex-wrap items-center gap-2'>
                <RoleBadge role={{ key: role.key, name: role.name, color: role.badge_color }} />
                <Pill>{role.is_system ? '内置角色' : '自定义角色'}</Pill>
                <Pill>{role.user_count} 个用户在用</Pill>
                <Pill tone='outline'>depth {role.depth}</Pill>
                <Pill tone='outline'>{role.perm_keys.length} 个权限点</Pill>
              </div>
              {role.is_super ? (
                <DisabledReason>超管的矩阵只读：后端在 authz.Require 与中间件里都短路，矩阵对它没有意义，改它只会产生一个骗人的勾。</DisabledReason>
              ) : null}
              {!canEdit ? <DisabledReason>本账号没有 role.edit：整张矩阵只读</DisabledReason> : null}
              {busy ? <DisabledReason>正在保存…</DisabledReason> : null}

              <div className='flex flex-col gap-3 pt-2'>
                {loading && permissions.length === 0 ? <p className='text-[12px] text-muted-foreground'>正在加载权限点目录…</p> : null}
                {groups.map((grp) => {
                  const items = permissions.filter((p) => p.group === grp);
                  const on = items.filter((p) => current.includes(p.key)).length;
                  return (
                    <div key={grp} className='rounded-md border border-border p-2'>
                      <div className='mb-1 flex flex-wrap items-center justify-between gap-2'>
                        <span className='text-[12px] font-medium text-foreground'>
                          {grp}
                          <span className='ml-1 text-[11px] font-normal text-muted-foreground'>{on} / {items.length}</span>
                        </span>
                        <ButtonSet>
                          <Button disabled={readOnly} onClick={() => setGroup(grp, true)}>全选</Button>
                          <Button disabled={readOnly} onClick={() => setGroup(grp, false)}>清空</Button>
                        </ButtonSet>
                      </div>
                      <div className='grid gap-1.5 md:grid-cols-2'>
                        {items.map((p) => (
                          <Checkbox
                            key={p.key}
                            label={p.key}
                            help={p.name + (p.description ? '：' + p.description : '')}
                            checked={current.includes(p.key)}
                            indeterminate={false}
                            disabled={readOnly}
                            onChange={(e) => toggle(p.key, e.target.checked)}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          ) : (
            <Panel title='权限矩阵'><p className='text-[12px] text-muted-foreground'>还没有角色（后端一条都没返回）。</p></Panel>
          )}

          {role ? (
            <Panel title='影响预览' note='保存前先看清「这次变更会让谁多拿到什么」——提权是攻击者的第一目标'>
              <Toolbar className='mb-2'>
                <Pill tone='outline'>{role.user_count} 个用户在受影响范围内</Pill>
                <Pill tone='outline'>当前 {saved.length} 个点 → 保存后 {current.length} 个</Pill>
                {dangerousAdded.length > 0 ? <Pill tone='danger'>含提权类变更，会写审计 role.permissions.edit</Pill> : null}
                {current.length === 0 ? <Pill tone='danger'>空矩阵：保存后这个角色什么都不能做</Pill> : null}
              </Toolbar>
              {dirty ? (
                <div className='flex flex-col'>
                  {added.map((p) => <KV key={'a' + p} k={'+ ' + p} v={descOf(p)} />)}
                  {removed.map((p) => <KV key={'r' + p} k={'− ' + p} v='受影响用户下次请求即生效（权限缓存主动失效）' />)}
                  <KV
                    k='写穿自检'
                    v='这一屏做不到'
                    hint='后端 RoleItem 没有 parent_id（只给 depth 与已展开的并集），所以「子 ⊇ 父」只能在启动自检里跑'
                  />
                </div>
              ) : (
                <p className='text-[12px] text-muted-foreground'>还没有改动。勾选左侧任意权限点，这里会立刻给出影响范围。</p>
              )}
              <Toolbar className='mt-2'>
                <Button disabled={readOnly} onClick={() => setConfirmClear(role)}>清空该角色的全部权限点</Button>
              </Toolbar>
            </Panel>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        show={confirmClear !== null}
        label='把这个角色的权限清空？'
        danger
        confirmText='清空矩阵'
        reasonLabel='为什么要清空（可选，进审计）'
        body={
          <span>
            清空 <b>{confirmClear?.name}</b> 的全部 {saved.length} 个权限点后，<b>{confirmClear?.user_count}</b> 个用户
            会立刻失去这些能力（后端是全量替换：<code>perm_keys: []</code> 就是清空）。
            这不是删除角色 —— 后端没有删除角色的端点。
          </span>
        }
        onClose={() => setConfirmClear(null)}
        onConfirm={() => {
          if (confirmClear) setDraft([]);
          setConfirmClear(null);
        }}
      />
    </div>
  );
}

/** 提权类：这些权限点让持有者能改动**别人**的权力或影响面。照后端 authz 常量列。 */
const DANGEROUS = [
  'role.edit', 'role.assign', 'permission.grant',
  'user.ban', 'user.mute',
  'site.setting', 'mail.manage', 'audit.view', 'audit.export',
  'board.manage', 'title.grant', 'title.manage',
];
