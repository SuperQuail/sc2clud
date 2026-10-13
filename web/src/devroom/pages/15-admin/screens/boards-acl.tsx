import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import { Panel, Pill } from '../bits';
import { ROLES, type AdminBoard, type BoardAcl } from '../mock';
import { ACL_CELL, D6_STEPS, aclConclusion } from './boards-acl-model';

// 角色 × 分区权限矩阵（D6）。**表格化勾选**：一行一个角色、四列开关、右侧直接给判定结论。
// 为什么不是「每个角色一个下拉选允许/禁止」：下拉要点开才知道里面是什么，
// 而这张表要回答的恰恰是「哪一行被 deny 挡住、挡住了哪一半（发帖/回复）」——一屏之内要看得见。
export function BoardAclPanel({ board, aclEnabled, draft, canEdit, onSet }: {
  board: AdminBoard;
  aclEnabled: boolean;
  draft: Record<string, BoardAcl>;
  /** 能改吗（没有 board.manage 或分区已归档就是只读） */
  canEdit: boolean;
  onSet: (roleId: string, field: keyof Omit<BoardAcl, 'board_id' | 'role_id'>, on: boolean) => void;
}) {
  const denied = ROLES.filter((r) => {
    const a = draft[board.id + ':' + r.id]!;
    return a.deny_post || a.deny_reply;
  });
  // 当前分区会走到哪几步（用来高亮下面的判定顺序）
  const hot = new Set<number>();
  if (!aclEnabled) hot.add(3);
  else {
    for (const r of ROLES) {
      const a = draft[board.id + ':' + r.id]!;
      hot.add(aclConclusion(a, 'post', true, r.key).step);
      hot.add(aclConclusion(a, 'reply', true, r.key).step);
    }
  }

  return (
    <Panel
      title={'角色 × 分区权限矩阵 · ' + board.name}
      note='board_acls：can_post / can_reply / deny_post / deny_reply。deny 优先——同一行勾了「禁发帖」，发帖就按第 4 步拒绝，不看右边的允许。'
    >
      <div className={ACL_CELL + ' border-b border-border pb-1 text-[11px] text-muted-foreground'}>
        <span>角色（基线，一人一个）</span>
        <span className='text-center'>可发帖</span>
        <span className='text-center'>可回复</span>
        <span className='text-center text-destructive'>禁发帖</span>
        <span className='text-center text-destructive'>禁回复</span>
        <span className='pl-2'>本分区结论（D6）</span>
      </div>

      {ROLES.map((r) => {
        const a = draft[board.id + ':' + r.id]!;
        const blocked = a.deny_post || a.deny_reply;
        const post = aclConclusion(a, 'post', aclEnabled, r.key);
        const reply = aclConclusion(a, 'reply', aclEnabled, r.key);
        return (
          <div
            key={r.id}
            className={ACL_CELL + ' border-b border-l-2 border-border py-1.5 last:border-b-0 ' + (blocked ? 'border-l-destructive bg-destructive/6' : 'border-l-transparent')}
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
