import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Lock } from 'lucide-react';
import { UserBadge } from '@/ui/user/user-badge';
import { PasswordField } from '@/ui/password-field';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { useSession } from '@/lib/perms';
import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { logout } from '@/lib/api/auth';
import { PageHeader } from './_parts/layout';
import { Empty, ErrorState, Loading } from './_parts/state';

// 个人设置（契约：PATCH /me、POST /me/password、POST /auth/logout）。
// 只做**有三个态、有真实端点**的几块：资料、密码、会话退出。
// 头像（POST /me/avatar，要字节与压缩管线）、收款码（/me/payment-channels）、登录设备列表
// （GET /me/sessions 有契约但本轮不排）都没做，记进回报 —— 不画点了没反应的入口。
// 20 = users.nickname varchar(20) / auth.nicknameMaxLen（写死 32 会让 21-32 字的昵称在服务端被拒）
const NICK_MAX = 20;
const BIO_MAX = 200;

export function SettingsPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [nickname, setNickname] = useState<string | null>(null);
  const [bio, setBio] = useState<string | null>(null);
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const save = useMutation({
    mutationFn: (body: { nickname?: string; bio?: string }) => api<void>('me', { method: 'PATCH', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.me() }),
  });
  const changePassword = useMutation({
    mutationFn: (body: { old_password: string; new_password: string }) =>
      api<void>('me/password', { method: 'POST', body }),
    onSuccess: () => {
      setOldPassword('');
      setNewPassword('');
      // 改密码会删掉该用户的全部会话（§21.2）：清干净缓存，别让界面停在「还登录着」的假象上
      queryClient.clear();
    },
  });
  const signOut = useMutation({
    mutationFn: () => logout(),
    onSuccess: () => queryClient.clear(),
  });

  if (session.isLoading) return <Loading what='账号信息' />;
  if (session.error) {
    return <ErrorState what='账号信息' error={session.error} onRetry={() => window.location.reload()} />;
  }
  if (!session.isLoggedIn) {
    return (
      <div className='flex flex-col gap-4'>
        <PageHeader title='个人设置' description='登录后才能改资料与密码。' />
        <Empty
          icon={Lock}
          title='你还没有登录'
          hint='设置页需要知道「你是谁」，登录后再回来；本页不会记住你填过的任何东西。'
          action={
            <Button primary href={appPath('login?next=' + encodeURIComponent(routePath('settings')))}>去登录</Button>
          }
        />
      </div>
    );
  }

  // session.session 的类型是 Session | null，而 TS 不会把上面的 isLoggedIn 判断带到这里，所以显式取一次
  const me = session.session!;
  const fieldError = (e: unknown, key: string): string | undefined => (isApiError(e) ? e.fields?.[key] : undefined);

  function submitProfile(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body: { nickname?: string; bio?: string } = {};
    if (nickname !== null) body.nickname = nickname;
    if (bio !== null) body.bio = bio;
    if (Object.keys(body).length === 0) return;
    save.mutate(body);
  }

  function submitPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    changePassword.mutate({ old_password: oldPassword, new_password: newPassword });
  }

  return (
    <div className='flex flex-col gap-4'>
      <PageHeader title='个人设置' description='资料、密码与会话。改完即时生效，不需要重新登录（改密码除外）。' />

      <section className='flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card p-4'>
        <UserBadge
          user={{ handle: me.handle, nickname: me.nickname, avatar: me.avatar, role: me.role }}
          size='lg'
          showHandle
        />
        <span className='flex flex-wrap items-center gap-3 text-[12px] text-muted-foreground'>
          <span>{me.email_verified ? '邮箱已激活' : '邮箱未激活（激活前不能发帖、回复、上传）'}</span>
          <Button inline={false} height={ControlsHeight.S} href={appPath('u/' + encodeURIComponent(me.handle))}>
            看我的主页
          </Button>
        </span>
      </section>

      <section className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'>
        <h2 className='m-0 text-[15px] font-semibold text-foreground'>资料</h2>
        {save.isSuccess ? (
          <FormAlert tone='success' title='已保存' description='主页上的昵称与简介现在就是新的了。' />
        ) : null}
        {save.isError ? <FormAlert tone='error' title='没能保存' description={errorText(save.error)} /> : null}
        <form onSubmit={submitProfile} className='flex flex-col gap-3' noValidate>
          <Input
            size={Size.FULL}
            label='昵称'
            name='nickname'
            autoComplete='nickname'
            maxLength={NICK_MAX}
            placeholder={me.nickname}
            value={nickname ?? me.nickname}
            onChange={(e) => setNickname(e.target.value)}
            error={fieldError(save.error, 'nickname')}
            help={'最多 ' + NICK_MAX + ' 字。@' + me.handle + ' 是登录名，改不了。'}
          />
          <Input
            size={Size.FULL}
            multiline
            rows={3}
            inputClassName='!h-[96px]'
            label='简介'
            name='bio'
            maxLength={BIO_MAX}
            placeholder='一句话说清你做什么：战役作者 / 地图 / 汉化 / 工具'
            value={bio ?? me.bio ?? ''}
            onChange={(e) => setBio(e.target.value)}
            error={fieldError(save.error, 'bio')}
            help={'最多 ' + BIO_MAX + ' 字，会显示在个人主页与帖子作者卡上。'}
          />
          <span className='flex flex-wrap items-center gap-2'>
            <Button type='submit' primary inline={false} loader={save.isPending} disabled={save.isPending}>
              保存资料
            </Button>
            <span className='text-[11px] text-muted-foreground'>换头像还没接（POST /me/avatar），见回报的端点清单。</span>
          </span>
        </form>
      </section>

      <section className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'>
        <h2 className='m-0 text-[15px] font-semibold text-foreground'>密码</h2>
        {changePassword.isSuccess ? (
          <FormAlert
            tone='success'
            title='密码已改，全部会话已失效'
            description='这台设备也退出了，重新登录一次即可（后端规定：改密码删掉该账号的全部会话）。'
          />
        ) : null}
        {changePassword.isError ? (
          <FormAlert tone='error' title='没能修改' description={errorText(changePassword.error)} />
        ) : null}
        <form onSubmit={submitPassword} className='flex flex-col gap-3' noValidate>
          <PasswordField
            label='当前密码'
            name='old_password'
            autoComplete='current-password'
            value={oldPassword}
            onChange={setOldPassword}
            error={fieldError(changePassword.error, 'old_password')}
          />
          <PasswordField
            label='新密码'
            name='new_password'
            autoComplete='new-password'
            value={newPassword}
            onChange={setNewPassword}
            error={fieldError(changePassword.error, 'new_password')}
            help='改完这台设备也会退出登录（后端会删掉该账号的全部会话）。'
          />
          <span>
            <Button
              type='submit'
              inline={false}
              loader={changePassword.isPending}
              disabled={changePassword.isPending || oldPassword === '' || newPassword === ''}
            >
              修改密码
            </Button>
          </span>
        </form>
      </section>

      <section className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'>
        <h2 className='m-0 text-[15px] font-semibold text-foreground'>会话</h2>
        {signOut.isError ? <FormAlert tone='error' title='退出失败' description={errorText(signOut.error)} /> : null}
        <p className='m-0 text-[12px] leading-relaxed text-muted-foreground'>
          退出只影响这台设备。别的设备列表（GET /me/sessions）有契约但这一版还没排，见回报的端点清单。
        </p>
        <span>
          <Button data-testid='logout' inline={false} loader={signOut.isPending} onClick={() => signOut.mutate()}>
            退出登录
          </Button>
        </span>
      </section>
    </div>
  );
}

function errorText(e: unknown): string {
  return isApiError(e) ? e.message + (e.requestId ? '（错误编号 ' + e.requestId + '）' : '') : String(e);
}
