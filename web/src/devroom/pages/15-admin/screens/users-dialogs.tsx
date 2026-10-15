import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import Select, { Type as SelectType } from '@jetbrains/ring-ui-built/components/select/select';
import { errorLine } from '../bits';
import type { AdminUser, Role, Title } from '@/lib/api/admin';

// 用户管理屏的**三个动作弹层**（发头衔 / 改基线角色 / 重置密码）。
// 从 users.tsx 拆出来的理由是 gate:size：主体那一屏装不下这 140 行交互；
// 它们只服务这一张屏（参数全是屏的 props 链上的类型），所以住同一份文件、各自一个组件。

/** 发头衔（13.6 的第二半）：目录来自 GET /admin/titles，这里只能从目录里挑一个授予（title.grant）。 */
export function GrantTitleDialog({ user, titles, onClose, onGrant }: {
  user: AdminUser | null;
  titles: Title[];
  onClose: () => void;
  onGrant: (userId: string, titleId: string) => void;
}) {
  const [titleId, setTitleId] = useState<string>('');
  if (!user) return null;
  const options = titles.filter((t) => !t.archived_at).map((t) => ({ key: t.id, label: t.name + '（' + t.key + '）' }));
  const chosen = titleId || options[0]?.key || '';
  return (
    <Dialog show label='发头衔' onCloseAttempt={onClose} onOverlayClick={onClose} onEscPress={onClose}>
      <div className='flex w-[420px] max-w-full flex-col gap-3 p-4'>
        <p className='text-[13px] text-foreground'>
          给 <b>{user.nickname}</b>（@{user.username}）授予头衔。一个用户可以持多个头衔，佩戴的只有一个（DB §4.11）。
        </p>
        {options.length === 0 ? (
          <p className='m-0 rounded-md border border-border bg-muted/50 px-3 py-2 text-[12px] text-muted-foreground'>
            头衔目录是空的（或全在归档态）：先去「头衔目录」屏建一个。
          </p>
        ) : (
          <Select
            type={SelectType.INPUT}
            label='头衔（已归档的不出现）'
            data={options}
            selected={options.find((o) => o.key === chosen) ?? null}
            onSelect={(item) => { if (item) setTitleId(String(item.key)); }}
          />
        )}
        <div className='flex items-center justify-end gap-2'>
          <Button onClick={onClose}>关闭</Button>
          <Button primary disabled={!chosen} onClick={() => { onGrant(user.id, chosen); onClose(); }}>授予</Button>
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
          角色之间永不并集：这是替换，不是叠加（RBAC权限树设计.md §1）。
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
