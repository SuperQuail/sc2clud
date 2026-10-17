import Button from '@jetbrains/ring-ui-built/components/button/button';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import type { AdminACLItem, Role } from '@/lib/api/admin';
import type { AdminGroup, AdminGroupACLItem } from '@/lib/api/groups';
import { Panel, Pill } from '../bits';
import { ACL_CELL, aclConclusion, type AclField as ConclusionField } from './boards-acl-model';

// 角色 × 分区 与 组 × 分区 两张矩阵（D38 的按组名单 + D40 的超管行）。**表格化勾选**：一行一个身份、
// 四列开关、右侧直接给这个身份在本分区的结果。
//
// **prop 驱动 + 全量替换**：勾选改的是宿主的草稿（draft），保存时整张矩阵一次 PUT 上去
// （逐格 PATCH 会暴露「禁止优先」的中间态）。角色目录来自 GET /admin/roles、组目录来自
// GET /admin/groups —— 目录里没有对应的行就是「没给任何许可」（缺行 = 四个开关全关）。

export const FIELDS = ['can_post', 'can_reply', 'deny_post', 'deny_reply'] as const;
export type AclToggleField = (typeof FIELDS)[number];

const HEAD_ROW = (
  <div className={ACL_CELL + ' border-b border-border pb-1 text-[11px] text-muted-foreground'}>
    <span>身份（按行勾选）</span>
    <span className='text-center'>可发帖</span>
    <span className='text-center'>可回复</span>
    <span className='text-center text-destructive'>禁发帖</span>
    <span className='text-center text-destructive'>禁回复</span>
    <span className='pl-2'>这行身份在本分区的结果</span>
  </div>
);

function ToggleCells({ row, disabled, onSet, ariaName }: {
  row: Record<AclToggleField, boolean>;
  disabled: boolean;
  onSet: (f: AclToggleField, on: boolean) => void;
  ariaName: string;
}) {
  return (
    <>
      {FIELDS.map((f) => (
        <span key={f} className='flex justify-center'>
          <Checkbox
            aria-label={ariaName + ' ' + f}
            label={null}
            checked={row[f]}
            indeterminate={false}
            disabled={disabled}
            onChange={(e) => onSet(f, e.target.checked)}
          />
        </span>
      ))}
    </>
  );
}

export function BoardAclPanel({
  boardName, aclEnabled, roles, acl, draft, canEdit, dirty, saving, onSet, onSave,
}: {
  boardName: string;
  aclEnabled: boolean;
  /** 全站角色目录（GET /admin/roles）：矩阵的行就是它 */
  roles: Role[];
  /** 后端给的当前矩阵（GET /admin/boards/{id}/acl） */
  acl: AdminACLItem[];
  /** 宿主手里的草稿：role_id → 四格 */
  draft: Record<number, AdminACLItem>;
  /** 能改吗（没有 board.manage 或分区已归档就是只读） */
  canEdit: boolean;
  dirty: boolean;
  saving: boolean;
  onSet: (roleId: number, field: AclToggleField, on: boolean) => void;
  /** 宿主在保存前会滤掉超管的行（D40：矩阵不控制超管，写入同样不收） */
  onSave: () => void;
}) {
  const denied = roles.filter((r) => {
    const a = draft[r.id];
    return a && (a.deny_post || a.deny_reply);
  });

  return (
    <Panel
      title={'发言名单（按角色） · ' + boardName}
      note='给角色勾「允许」或「禁止」。「禁止」说了算：同一行勾了禁，另一边即使是允许也按禁止处理。'
      actions={(
        <>
          {dirty ? <Pill tone='warn'>有未保存的改动</Pill> : <Pill tone='ok'>与已保存的一致</Pill>}
          <Button inline={false} height={ControlsHeight.S} primary disabled={!canEdit || !dirty || saving} onClick={onSave}>
            {saving ? '保存中…' : '保存名单'}
          </Button>
        </>
      )}
    >
      {HEAD_ROW}
      {roles.map((r) => {
        const a = draft[r.id];
        const saved = acl.find((x) => x.role_id === r.id);
        const row: AdminACLItem = a ?? saved ?? { role_id: r.id, role_key: r.key, can_post: false, can_reply: false, deny_post: false, deny_reply: false };
        const blocked = row.deny_post || row.deny_reply;
        const post = aclConclusion(row as AdminACLItem, 'post' as ConclusionField, aclEnabled, r.key);
        const reply = aclConclusion(row as AdminACLItem, 'reply' as ConclusionField, aclEnabled, r.key);
        const isSuper = r.key === 'superadmin';
        return (
          <div
            key={r.id}
            className={ACL_CELL + ' border-b border-l-2 border-border py-1.5 last:border-b-0 ' + (blocked ? 'border-l-destructive bg-destructive/6' : 'border-l-transparent')}
          >
            <span className='flex min-w-0 flex-col leading-tight'>
              <span className='flex min-w-0 items-center gap-1.5'>
                <span className='truncate text-[12px] font-medium text-foreground'>{r.name}</span>
                {isSuper ? <Pill tone='outline'>全域继承</Pill> : null}
              </span>
              <span className='truncate text-[10px] text-muted-foreground'>{r.key}{saved ? '' : '（未配置行）'}</span>
            </span>
            <ToggleCells row={row} disabled={!canEdit || isSuper} onSet={(f, on) => onSet(r.id, f, on)} ariaName={r.name} />
            <span className='flex flex-col items-start gap-0.5 pl-2'>
              <Pill tone={post.tone}>发帖：{post.text}</Pill>
              <Pill tone={reply.tone}>回复：{reply.text}</Pill>
            </span>
            {isSuper ? (
              <span className='col-span-6 pl-2 text-[10px] leading-relaxed text-muted-foreground'>
                超级管理员在任何分区都拥有完整发言与管理权限（按账号身份直接放行），名单上的勾选只是占位、不会生效。
              </span>
            ) : null}
          </div>
        );
      })}
      <p className='mt-2 mb-0 text-[11px] leading-relaxed text-muted-foreground'>
        这一分区被勾了「禁止」的角色：{denied.length === 0 ? '无' : denied.map((r) => r.name).join('、')}{denied.length > 0 ? '（整行标红）' : ''}。
        开关关掉时（分区资料里的「按名单判定」）这张名单暂不生效，重新打开即恢复原勾选，不用重配。
        保存是整张名单一次替换：没给到的行会被删掉；同一行既「允许」又「禁止」会被拒绝。
      </p>
    </Panel>
  );
}

const DEFAULT_GROUP_ROW = { can_post: false, can_reply: false, deny_post: false, deny_reply: false };

export function GroupAclPanel({
  boardName, groups, acl, draft, canEdit, dirty, saving, onSet, onSave,
}: {
  boardName: string;
  /** 全站组目录（GET /admin/groups）：矩阵的行就是它 */
  groups: AdminGroup[];
  /** 后端给的当前矩阵（GET /admin/boards/{id}/group-acl） */
  acl: AdminGroupACLItem[];
  draft: Record<string, AdminGroupACLItem>;
  canEdit: boolean;
  dirty: boolean;
  saving: boolean;
  onSet: (groupKey: string, field: AclToggleField, on: boolean) => void;
  onSave: () => void;
}) {
  const denied = groups.filter((g) => {
    const a = draft[g.id];
    return a && (a.deny_post || a.deny_reply);
  });
  return (
    <Panel
      title={'发言名单（按用户组） · ' + boardName}
      note='把某个组勾「允许」后，组里的每个人在本分区都多一条可以发帖 / 回复的路径；勾「禁止」则整组一律挡下（比角色行的允许优先）。'
      actions={(
        <>
          {dirty ? <Pill tone='warn'>有未保存的改动</Pill> : <Pill tone='ok'>与已保存的一致</Pill>}
          <Button inline={false} height={ControlsHeight.S} primary disabled={!canEdit || !dirty || saving} onClick={onSave}>
            {saving ? '保存中…' : '保存按组名单'}
          </Button>
        </>
      )}
    >
      {HEAD_ROW}
      {groups.map((g) => {
        const a = draft[g.key];
        const saved = acl.find((x) => x.group_key === g.key);
        const row: AdminGroupACLItem = a ?? saved ?? { group_key: g.key, ...DEFAULT_GROUP_ROW };
        const blocked = row.deny_post || row.deny_reply;
        return (
          <div
            key={g.id}
            className={ACL_CELL + ' border-b border-l-2 border-border py-1.5 last:border-b-0 ' + (blocked ? 'border-l-destructive bg-destructive/6' : 'border-l-transparent')}
          >
            <span className='flex min-w-0 flex-col leading-tight'>
              <span className='truncate text-[12px] font-medium text-foreground'>{g.name}</span>
              <span className='truncate text-[10px] text-muted-foreground'>{g.key}{saved ? '' : '（未配置行）'}</span>
            </span>
            <ToggleCells row={row} disabled={!canEdit} onSet={(f, on) => onSet(g.key, f, on)} ariaName={'组 ' + g.name} />
            <span className='flex items-start pl-2'>
              <Pill tone={blocked ? 'danger' : 'neutral'}>{g.member_count} 成员</Pill>
            </span>
          </div>
        );
      })}
      <p className='mt-2 mb-0 text-[11px] leading-relaxed text-muted-foreground'>
        被这个名单挡下的组：{denied.length === 0 ? '无' : denied.map((g) => g.name).join('、')}。
        组员以「用户组」屏的名单为准（加人 / 移出当场生效）；这一栏只在分区开了「按名单判定」时才算数。
      </p>
    </Panel>
  );
}
