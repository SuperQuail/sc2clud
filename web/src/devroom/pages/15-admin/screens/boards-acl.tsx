import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import type { AdminACLItem, Role } from '@/lib/api/admin';
import { Panel, Pill } from '../bits';
import { ACL_CELL, D6_STEPS, aclConclusion } from './boards-acl-model';

// 角色 × 分区权限矩阵（D6）。**表格化勾选**：一行一个角色、四列开关、右侧直接给判定结论。
// 为什么不是「每个角色一个下拉选允许/禁止」：下拉要点开才知道里面是什么，
// 而这张表要回答的恰恰是「哪一行被 deny 挡住、挡住了哪一半（发帖/回复）」——一屏之内要看得见。
//
// **prop 驱动 + 全量替换**：勾选改的是宿主的草稿（draft），保存时整张矩阵一次 PUT 上去
// （逐格 PATCH 会暴露「禁止优先」的中间态）。角色目录来自 GET /admin/roles —— 后端给的是
// **全站角色**，矩阵里没有对应行的角色就是「这一分区没给它任何权限」（缺行 = 四个开关全关）。

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
  onSet: (roleId: number, field: 'can_post' | 'can_reply' | 'deny_post' | 'deny_reply', on: boolean) => void;
  onSave: () => void;
}) {
  const denied = roles.filter((r) => {
    const a = draft[r.id];
    return a && (a.deny_post || a.deny_reply);
  });
  // 当前分区会走到哪几步（用来高亮下面的判定顺序）
  const hot = new Set<number>();
  if (!aclEnabled) hot.add(3);
  else {
    for (const r of roles) {
      const a = draft[r.id];
      if (!a) continue;
      hot.add(aclConclusion(a, 'post', true, r.key).step);
      hot.add(aclConclusion(a, 'reply', true, r.key).step);
    }
  }

  return (
    <Panel
      title={'角色 × 分区权限矩阵 · ' + boardName}
      note='board_acls：can_post / can_reply / deny_post / deny_reply。deny 优先——同一行勾了「禁发帖」，发帖就按第 4 步拒绝，不看右边的允许。'
      actions={
        <>
          {dirty ? <Pill tone='warn'>有未保存的改动</Pill> : <Pill tone='ok'>与后端一致</Pill>}
          <Button inline={false} height={ControlsHeight.S} primary disabled={!canEdit || !dirty || saving} onClick={onSave}>
            {saving ? '保存中…' : '保存矩阵（全量替换）'}
          </Button>
        </>
      }
    >
      <div className={ACL_CELL + ' border-b border-border pb-1 text-[11px] text-muted-foreground'}>
        <span>角色（基线，一人一个）</span>
        <span className='text-center'>可发帖</span>
        <span className='text-center'>可回复</span>
        <span className='text-center text-destructive'>禁发帖</span>
        <span className='text-center text-destructive'>禁回复</span>
        <span className='pl-2'>本分区结论（D6）</span>
      </div>

      {roles.map((r) => {
        const a = draft[r.id];
        const saved = acl.find((x) => x.role_id === r.id);
        const row: AdminACLItem = a ?? saved ?? { role_id: r.id, role_key: r.key, can_post: false, can_reply: false, deny_post: false, deny_reply: false };
        const blocked = row.deny_post || row.deny_reply;
        const post = aclConclusion(row, 'post', aclEnabled, r.key);
        const reply = aclConclusion(row, 'reply', aclEnabled, r.key);
        return (
          <div
            key={r.id}
            className={ACL_CELL + ' border-b border-l-2 border-border py-1.5 last:border-b-0 ' + (blocked ? 'border-l-destructive bg-destructive/6' : 'border-l-transparent')}
          >
            <span className='flex min-w-0 flex-col leading-tight'>
              <span className='truncate text-[12px] font-medium text-foreground'>{r.name}</span>
              <span className='truncate text-[10px] text-muted-foreground'>{r.key}{saved ? '' : '（后端没这一行）'}</span>
            </span>
            {(['can_post', 'can_reply', 'deny_post', 'deny_reply'] as const).map((f) => (
              <span key={f} className='flex justify-center'>
                <Checkbox
                  aria-label={r.name + ' ' + f}
                  label={null}
                  checked={row[f]}
                  indeterminate={false}
                  disabled={!canEdit || r.key === 'superadmin'}
                  onChange={(e) => onSet(r.id, f, e.target.checked)}
                />
              </span>
            ))}
            <span className='flex flex-col items-start gap-0.5 pl-2'>
              <Pill tone={post.tone}>发帖：{post.text}</Pill>
              <Pill tone={reply.tone}>回复：{reply.text}</Pill>
            </span>
          </div>
        );
      })}

      <p className='mt-2 mb-0 text-[11px] leading-relaxed text-muted-foreground'>
        这一分区命中 deny 的角色：{denied.length === 0 ? '无' : denied.map((r) => r.name).join('、')}
        {denied.length > 0 ? '（整行被 deny 挡住，左侧色条标红）' : ''}。
        勾选只有在 acl_enabled = true 时才算数；关掉开关时上面的结论会变成「第 3 步放行」。
        保存是**整张矩阵一次 PUT**（后端全量替换：少给一行就真删掉；同一行既 can 又 deny、重复 role_id 都会 400）。
      </p>

      <div className='mt-3 border-t border-border pt-2'>
        <span className='text-[11px] text-muted-foreground'>D6 判定顺序（service 层，不在中间件里——路由参数里没有 board id）</span>
        <ol className='mt-1 mb-0 flex flex-col gap-0.5 pl-4 text-[12px]'>
          {D6_STEPS.map((s, i) => (
            <li key={s} className={'list-decimal rounded-sm px-1 ' + (hot.has(i + 1) ? 'bg-primary/10 text-primary' : 'text-muted-foreground')}>
              {s}
            </li>
          ))}
        </ol>
        <p className='mt-1 mb-0 text-[11px] leading-relaxed text-muted-foreground'>
          注意：D6 写的是「<b>任一</b>角色命中 deny」——那是给旧站「一人多组」写的；本项目一个人只有一个基线角色
          （RBAC权限树设计.md §1），所以实际判定就是「该用户那一行」。
        </p>
      </div>
    </Panel>
  );
}
