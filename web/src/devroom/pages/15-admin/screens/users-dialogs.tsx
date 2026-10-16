import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Checkbox from '@jetbrains/ring-ui-built/components/checkbox/checkbox';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { qk } from '@/lib/query/keys';
import { fetchUserTitles } from '@/lib/api/title';
import { errorLine, Pill } from '../bits';
import type { AdminUser, Role, Title } from '@/lib/api/admin';

// 用户管理屏的**三个动作弹层**（头衔编辑 / 改基线角色 / 重置密码）。
// 从 users.tsx 拆出来的理由是 gate:size：主体那一屏装不下这 140 行交互；
// 它们只服务这一张屏（参数全是屏的 props 链上的类型），所以住同一份文件、各自一个组件。

/** 头衔编辑（13.6 的第二半）：一列复选框，勾上 = 授予、取消勾 = 撤销，**没有保存按钮**
 *  （与原来的撤销一致：每一下就是一次请求，少一套草稿/diff 状态）。
 *
 *  行 = 目录里未归档的 ∪ 该用户已持有的 —— 并集是必须的：用户可能持有**已归档**的头衔，
 *  那一行不在目录里，少了它就永远撤不掉。勾选态的真源是公共读 GET /users/{handle}/titles
 *  （handle = username 行字段）：宿主发真请求（onSet），成功后弹层自己失效 qk.userTitles
 *  —— handle 只有弹层知道，失效放在这里最短；失败把 errorLine 挂在清单旁边（D48 同策略），
 *  且**不做乐观翻转**（不失效缓存，勾选态就还是服务端真值）。任何一行 pending 期间禁用其它行。
 *
 *  外壳不挂钩子：user=null（弹层没开）就一个 null —— 屏与测试里没有 Provider 的直渲染也不炸。 */
export function TitleEditDialog(props: {
  user: AdminUser | null;
  titles: Title[];
  onClose: () => void;
  /** held=true 授予（POST /admin/users/{id}/titles/{titleId}）、false 撤销（DELETE 同路径）。
   *  拿 Promise 是为了就地 pending 与就地报错 */
  onSet: (userId: string, titleId: string, held: boolean) => Promise<void>;
}) {
  if (!props.user) return null;
  return <TitleEditDialogContent {...props} user={props.user} />;
}

function TitleEditDialogContent({ user, titles, onClose, onSet }: {
  user: AdminUser;
  titles: Title[];
  onClose: () => void;
  onSet: (userId: string, titleId: string, held: boolean) => Promise<void>;
}) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  // 持有清单：弹层一开（user 非空）才读；这里是公共读，不需要 title.grant 之外的权限
  const held = useQuery({
    queryKey: qk.userTitles(user.username),
    queryFn: ({ signal }) => fetchUserTitles(user.username, signal),
  });
  const heldItems = held.data?.items ?? [];
  const heldIds = new Set(heldItems.map((t) => t.id));
  // 目录里的未归档项打头，再补上「持有但不在目录里」的（已归档的持有项 / 目录是旧快照的情况）
  const catalog = titles.filter((t) => !t.archived_at);
  const inCatalog = new Set(catalog.map((t) => t.id));
  const rows = [...catalog, ...heldItems.filter((t) => !inCatalog.has(t.id))];
  const equipped = held.data?.equipped_id ?? '';
  const set = (titleId: string, next: boolean) => {
    setError(null);
    setPending(titleId);
    onSet(user.id, titleId, next)
      .then(() => { setPending(null); return void qc.invalidateQueries({ queryKey: qk.userTitles(user.username) }); })
      .catch((e) => { setPending(null); setError(errorLine(e) ?? '头衔没能改动'); });
  };
  return (
    <Dialog show label='头衔编辑' onCloseAttempt={onClose} onOverlayClick={onClose} onEscPress={onClose}>
      <div className='flex w-[420px] max-w-full flex-col gap-3 p-4'>
        <p className='m-0 text-[13px] text-foreground'>
          给 <b>{user.nickname}</b>（@{user.username}）编辑头衔。<b>勾选 = 授予，取消勾选 = 撤销</b>；
          一个用户可持多个头衔，佩戴的只有一个。
        </p>
        {held.isPending ? (
          <p className='m-0 text-[12px] text-muted-foreground'>正在读已持有的头衔…</p>
        ) : held.isError ? (
          <p role='alert' className='m-0 text-[12px] text-destructive'>持有清单没能加载：{errorLine(held.error)}</p>
        ) : rows.length === 0 ? (
          <p className='m-0 rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-muted-foreground'>
            头衔目录是空的（或全在归档态），这位用户也没持有任何头衔：先去「头衔目录」屏建一个。
          </p>
        ) : (
          <div className='flex flex-col gap-1'>
            {rows.map((t) => (
              <div key={t.id} className='flex items-center justify-between gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5'>
                <Checkbox
                  label={t.name + '（' + t.key + '）'}
                  checked={heldIds.has(t.id)}
                  indeterminate={false}
                  disabled={pending !== null}
                  onChange={(e) => set(t.id, e.target.checked)}
                />
                <span className='flex shrink-0 items-center gap-1'>
                  {t.id === equipped ? <Pill tone='ok'>佩戴中</Pill> : null}
                  {t.archived_at ? <Pill>已归档</Pill> : null}
                </span>
              </div>
            ))}
            {error ? <p role='alert' className='m-0 text-[12px] text-destructive'>{error}</p> : null}
          </div>
        )}
        <div className='flex items-center justify-end gap-2'>
          <Button onClick={onClose}>关闭</Button>
        </div>
      </div>
    </Dialog>
  );
}

/** D56 重置密码：忘记密码的后台通道（自助的 forgot 邮件流在 16-auth）。
 *  密码留空 = 后端生成一次性临时密码，**只在弹层里显示一次**；
 *  成功不关弹层（关掉就再也拿不回那个密码）、失败也不关（错误挂到输入附近，同 D48 的策略）。 */
export function ResetPasswordDialog({ user, onClose, onReset }: {
  user: AdminUser | null;
  onClose: () => void;
  onReset: (userId: string, password: string) => Promise<{ password?: string; revoked: number }>;
}) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ password?: string; revoked: number } | null>(null);
  if (!user) return null;
  const submit = () => {
    setBusy(true);
    onReset(user.id, pw)
      .then((r) => { setDone(r); setBusy(false); })
      .catch((e) => { setError(errorLine(e) ?? '重置没能完成'); setBusy(false); });
  };
  return (
    <Dialog show label='重置密码' onCloseAttempt={onClose} onOverlayClick={onClose} onEscPress={onClose}>
      <div className='flex w-[420px] max-w-full flex-col gap-3 p-4'>
        {done ? (
          <>
            <p className='m-0 text-[13px] leading-relaxed text-foreground'>
              已给 <b>{user.nickname}</b> 设好新密码，其 <b>{done.revoked}</b> 个会话已全部失效（旧密码不再可用）。
            </p>
            {done.password ? (
              <div data-testid='pw-reset-once' className='rounded-md border border-border bg-muted/50 px-3 py-2'>
                <p className='m-0 mb-1 text-[11px] leading-relaxed text-muted-foreground'>
                  临时密码（<b>只显示这一次</b>，关掉就再也拿不回来）——当面交给这位用户：
                </p>
                <span className='font-mono text-[16px] font-semibold tracking-wider text-foreground'>{done.password}</span>
              </div>
            ) : (
              <p data-testid='pw-reset-once-explicit' className='m-0 text-[12px] leading-relaxed text-muted-foreground'>
                密码是你自己指定的（界面上不回显）——把它交给对方即可。
              </p>
            )}
            <div className='flex items-center justify-end gap-2'>
              <Button primary inline={false} height={ControlsHeight.S} onClick={onClose}>完成</Button>
            </div>
          </>
        ) : (
          <>
            <p className='m-0 text-[13px] leading-relaxed text-foreground'>
              给 <b>{user.nickname}</b>（@{user.username}）设置新登录密码。提交后该用户<b>全部会话</b>立刻失效、
              旧密码不再可用；动作写入审计 <code>user.password.reset</code>。
            </p>
            <Input
              label='新密码（8-128 字节；留空 = 自动生成一次性临时密码）'
              type='text'
              autoComplete='off'
              value={pw}
              onChange={(e) => setPw(e.target.value)}
            />
            {error ? <p role='alert' className='m-0 text-[12px] text-destructive'>{error}</p> : null}
            <div className='flex items-center justify-end gap-2'>
              <Button onClick={onClose}>取消</Button>
              <Button primary data-testid='pw-reset-submit' loader={busy} disabled={busy} onClick={submit}>重置密码</Button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}

/** 改基线角色：role.assign 与 role.edit 是分开的两个点，这里要的是前者。 */
export function SetRoleDialog({ user, roles, onClose, onSet }: {
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
          角色之间永不并集：这是替换，不是叠加。
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
