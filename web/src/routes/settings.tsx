import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Lock } from 'lucide-react';
import { UserBadge } from '@/ui/user/user-badge';
import { type UploadedImage } from '@/ui/rich/image-uploader';
import { NoticeSettings, type SettingRow } from '@/ui/message/notice-settings';
import { AccountPanel } from '@/devroom/pages/11-profile/account-panel';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { useSession } from '@/lib/perms';
import { api } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { logout } from '@/lib/api/auth';
import { clearAvatar, uploadAvatar } from '@/lib/api/user';
// 类型与组件同名，所以按全站口径起别名（messages.tsx 也是这么写的）
import {
  fetchNoticeSettings,
  updateNoticeSettings,
  type NoticeSettings as NoticeSettingsDTO,
} from '@/lib/api/social';
import { PageHeader } from './_parts/layout';
import { Empty, ErrorState, Loading } from './_parts/state';

// 个人设置（契约：PATCH /me、POST /me/password、POST /auth/logout、GET/PUT /notifications/settings）。
//
// 两项**照 DevRoom 11-profile 用房子件**（同一份实现，不是抄一份）：
//   · 头像 / 改密码 / 退出登录 → \`AccountPanel\`（原先这里是手写的三段，改密码那块还只是密码框 + 按钮）；
//   · 消息提醒 → \`NoticeSettings\`（通知设置四行，后端 2026-10-14 补的 GET/PUT /notifications/settings）。
// 只有「资料」（昵称 / 简介）还是本页自己的表单：那两个框是文字 Input，\`NoticeSettings\` 的三种行
// （radio / toggle / tags）都不是文本框，塞不进去 —— 硬塞就是把一个表单拆成三块假控件。
//
// 封面**没接**：库里没有 users 封面列、也没有对应端点，所以这一屏上没有那颗按钮（不做点了没反应的入口）。
// 收款码（/me/payment-channels）、登录设备列表（GET /me/sessions 有契约但本轮不排）同样没做，记进回报。
// 20 = users.nickname varchar(20) / auth.nicknameMaxLen（写死 32 会让 21-32 字的昵称在服务端被拒）
const NICK_MAX = 20;
const BIO_MAX = 200;

export function SettingsPage() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [nickname, setNickname] = useState<string | null>(null);
  const [bio, setBio] = useState<string | null>(null);
  // 选好但还没上传的那张（ImageUploader 给的是压过的 blob + 本地预览 URL）
  const [picked, setPicked] = useState<UploadedImage[]>([]);

  const save = useMutation({
    mutationFn: (body: { nickname?: string; bio?: string }) => api<void>('me', { method: 'PATCH', body }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.me() }),
  });
  // 请求体字段名照后端：old_password / new_password（auth 的 changePasswordBody）。
  // 两次一致性与长度在 AccountPanel 里本地拦掉，这里只管发请求。
  const changePassword = useMutation({
    mutationFn: (body: { old_password: string; new_password: string }) =>
      api<void>('me/password', { method: 'POST', body }),
    onSuccess: () => {
      // 改密码会删掉该用户的全部会话（§21.2）：清干净缓存，别让界面停在「还登录着」的假象上
      queryClient.clear();
    },
  });
  // 上传成功后**清掉 picked**：预览换回服务端那张 /img/<hash>，避免停在「本地已选」的假象上。
  const saveAvatar = useMutation({
    mutationFn: (file: Blob) => uploadAvatar(file),
    onSuccess: () => {
      setPicked([]);
      void queryClient.invalidateQueries({ queryKey: qk.me() });
    },
  });
  const removeAvatar = useMutation({
    mutationFn: () => clearAvatar(),
    onSuccess: () => {
      setPicked([]);
      void queryClient.invalidateQueries({ queryKey: qk.me() });
    },
  });
  const signOut = useMutation({
    mutationFn: () => logout(),
    onSuccess: () => queryClient.clear(),
  });
  // 消息提醒四行：**字段名与值域照后端 noticeSettingDTO**（alert / reply_scope / mention_scope / like_alert）。
  // 值域只有 all | none —— 设计稿里那个「仅关注的人」选不中，因为本产品没有关注关系（拍板 §8.3）。
  // 表格没有 userId 之外的东西，所以 PUT 是全量四字段，不是「只改一个」的半更新。
  const [notice, setNotice] = useState<NoticeSettingsDTO | null>(null);
  const noticeQuery = useQuery({
    queryKey: ['notifications', 'settings'],
    queryFn: ({ signal }) => fetchNoticeSettings(signal),
    enabled: session.isLoggedIn,
  });
  const noticeSave = useMutation({
    mutationFn: (next: NoticeSettingsDTO) => updateNoticeSettings(next),
    // 用后端回执作为新的本地真值（不再 invalidate：缓存里那份是旧值，重拉要等一个往返，
    // 中间那一瞬界面会闪回旧选项 —— PUT 是幂等全量写，回执就是权威结果）
    onSuccess: (saved) => setNotice(saved),
  });
  const current = notice ?? noticeQuery.data ?? null;

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

  /** 通知设置的一行改了就整份保存（后端是 PUT 全量；没有「只改一个」的语义）。 */
  function saveNotice(patch: Partial<NoticeSettingsDTO>) {
    if (!current) return;
    noticeSave.mutate({ ...current, ...patch });
  }

  const noticeRows: SettingRow[] = current
    ? [
        {
          key: 'alert',
          kind: 'toggle',
          title: '总开关',
          hint: '关掉之后下面三项都不再产生通知',
          value: current.alert,
          onChange: (v) => saveNotice({ alert: v }),
        },
        {
          key: 'reply_scope',
          kind: 'radio',
          title: '回复我的消息提醒',
          hint: '谁回复你时给通知',
          // 只有 all / none 两档：设计稿的第三档「仅关注的人」在库里就被 CHECK 拒掉（本产品没有关注）
          options: [
            { key: 'all', label: '所有人' },
            { key: 'none', label: '不提醒' },
          ],
          value: current.reply_scope,
          onChange: (v) => saveNotice({ reply_scope: v as NoticeSettingsDTO['reply_scope'] }),
        },
        {
          key: 'mention_scope',
          kind: 'radio',
          title: '@ 我的消息提醒',
          hint: '谁在帖子里 @ 你时给通知',
          options: [
            { key: 'all', label: '所有人' },
            { key: 'none', label: '不提醒' },
          ],
          value: current.mention_scope,
          onChange: (v) => saveNotice({ mention_scope: v as NoticeSettingsDTO['mention_scope'] }),
        },
        {
          key: 'like_alert',
          kind: 'toggle',
          title: '点赞提醒',
          hint: '别人赞你的帖子时给通知',
          value: current.like_alert,
          onChange: (v) => saveNotice({ like_alert: v }),
        },
      ]
    : [];

  return (
    <div className='flex flex-col gap-4'>
      <PageHeader title='个人设置' description='资料、头像、密码、消息提醒与会话。改完即时生效，不需要重新登录（改密码除外）。' />

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

      {/* 头像 + 改密码 + 退出登录 = DevRoom 11-profile 的 AccountPanel（同一个件，不是抄一份）。
          三处与房间不同的地方都由 props 给：改密码发真请求（onSubmitPassword）、成功态等 200
          （passwordDone）、「去登录」指真站的 /login（loginHref）。 */}
      <AccountPanel
        avatar={picked[0]?.url ?? me.avatar ?? null}
        onAvatarPick={(list) => {
          // 真站要的是那份**文件**（POST /me/avatar 是 multipart，字段名 file），不是预览 URL
          setPicked(list);
          const f = list[0];
          if (f) saveAvatar.mutate(f.file);
        }}
        onSubmitPassword={(body) => changePassword.mutate(body)}
        passwordPending={changePassword.isPending}
        passwordDone={changePassword.isSuccess}
        onLogout={() => signOut.mutate()}
        loginHref={appPath('login')}
      />

      {/* AccountPanel 的密码表单不知道后端回了什么（它只做本地两条拦截），所以服务端的 fields 在这里说清：
          「当前密码不对」是服务端才判得了的那一条（fields.old_password）。 */}
      {changePassword.isError ? (
        <FormAlert
          tone='error'
          title='没能修改密码'
          description={
            fieldError(changePassword.error, 'old_password') ??
            fieldError(changePassword.error, 'new_password') ??
            errorText(changePassword.error)
          }
        />
      ) : null}
      {signOut.isError ? <FormAlert tone='error' title='退出失败' description={errorText(signOut.error)} /> : null}
      {saveAvatar.isError ? <FormAlert tone='error' title='没能上传头像' description={errorText(saveAvatar.error)} /> : null}
      {removeAvatar.isError ? <FormAlert tone='error' title='没能移除头像' description={errorText(removeAvatar.error)} /> : null}

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
          </span>
        </form>
      </section>

      <section className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'>
        <h2 className='m-0 text-[15px] font-semibold text-foreground'>消息提醒</h2>
        {noticeQuery.isPending ? (
          <Loading what='消息设置' className='py-4' />
        ) : noticeQuery.isError ? (
          <ErrorState what='消息设置' error={noticeQuery.error} onRetry={() => void noticeQuery.refetch()} />
        ) : (
          <>
            {noticeSave.isError ? (
              <FormAlert tone='error' title='没能保存提醒设置' description={errorText(noticeSave.error)} />
            ) : null}
            {noticeSave.isSuccess ? <FormAlert tone='success' title='提醒设置已保存' /> : null}
            <NoticeSettings rows={noticeRows} />
          </>
        )}
      </section>
    </div>
  );
}

function errorText(e: unknown): string {
  return isApiError(e) ? e.message + (e.requestId ? '（错误编号 ' + e.requestId + '）' : '') : String(e);
}
