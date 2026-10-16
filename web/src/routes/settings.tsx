import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input, { Size } from '@jetbrains/ring-ui-built/components/input/input';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { Lock, LogOut } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { UserBadge } from '@/ui/user/user-badge';
import { type UploadedImage } from '@/ui/rich/image-uploader';
import { NoticeSettings, type SettingRow } from '@/ui/message/notice-settings';
import { AccountPanel } from '@/devroom/pages/11-profile/account-panel';
import { CoverPicker } from '@/ui/cover-picker';
import { PaymentChannelsPanel } from '@/devroom/pages/11-profile/payment-channels';
import { useMyPaymentChannels } from '@/devroom/pages/11-profile/payment-channels-hook';
import { DonationRecordsPanel } from '@/devroom/pages/11-profile/records-panel';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { appPath, routePath } from '@/lib/url';
import { qk } from '@/lib/query/keys';
import { useSession } from '@/lib/perms';
import { api } from '@/lib/api/client';
import { apiErrorLine, isApiError } from '@/lib/api/errors';
import { logout } from '@/lib/api/auth';
import { clearAvatar, clearCover, fetchUserProfile, uploadAvatar, uploadCover } from '@/lib/api/user';
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
// 封面**已接**（2026-10-14 拍板 08 第二轮「壁纸替换」）：users.cover_hash（迁移 0030）+
// POST/DELETE /me/cover（media 域）+ ProfileHero 右上那颗「更换封面」。读的是公开资料
// （GET /users/{handle} 的 cover）而不是 /me —— /me 是会话快照，它不带封面这一列。
// 收款码**已接**（2026-10-14，L1）：POST/GET/DELETE /me/payment-channels 在 media 域，
// 整块在 @/devroom/pages/11-profile/payment-channels 里。登录设备列表（GET /me/sessions 有契约但本轮不排）仍未做。
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
  // 封面（0030）：与头像同一条通道，但**读的是公开资料**（/me 是会话快照，不带 cover 这一列）——
  // 查询键与主页同一个，所以换完封面主页那张图跟着变，不用等下一次进主页。
  // handle 可能为空（还没登录）：那时 enabled=false，不发请求。
  const contact = session.session?.handle ?? '';
  const coverQuery = useQuery({
    queryKey: qk.profile(contact),
    queryFn: ({ signal }) => fetchUserProfile(contact, signal),
    enabled: contact !== '',
  });
  // 换完封面**不存本地预览**：弹层里的预览位读的就是服务端那一张（换完 invalidate，回来即新图），
  // 存一份本地预览反而会多一个「传上去了但服务端回执还没到」的中间态要解释。
  const afterCover = () => void queryClient.invalidateQueries({ queryKey: qk.profile(contact) });
  const saveCover = useMutation({ mutationFn: (file: Blob) => uploadCover(file), onSuccess: afterCover });
  const removeCover = useMutation({ mutationFn: () => clearCover(), onSuccess: afterCover });
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
  // 收款码/赞赏设置的数据侧（D22 把它抽成一份：设置页这一格与个人主页那颗「设置我的收款码」弹层共用）
  const channels = useMyPaymentChannels();

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

      {/* 头像 + 改密码 = DevRoom 11-profile 的 AccountPanel（同一个件，不是抄一份）。
          三处与房间不同的地方都由 props 给：改密码发真请求（onSubmitPassword）、成功态等 200
          （passwordDone）、「去登录」指真站的 /login（loginHref）。
          D75：不传 onLogout —— 退出登录的动作移到本页**最底部**（下面的 footer），面板里不再画第二颗。 */}
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

      {/* 个人主页的封面 / 背景（0030 + POST/DELETE /me/cover）：与头像同一条图片通道、同一套控件。
          这一格在 /settings 里而不是只在主页上 —— 主页那颗「更换封面」是就地弹层（见 profile.tsx），
          这里是同一个动作的另一条路（设置页是用户找「改资料」时会来的地方）。 */}
      <section id='cover' className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'>
        <span className='flex flex-wrap items-center justify-between gap-2'>
          <h2 className='m-0 text-[15px] font-semibold text-foreground'>个人主页封面</h2>
          {/* 与主页那颗「更换封面」是**同一个弹层**（cover-picker.tsx），所以两处的限额文案与
              压缩口径不会各说一套。传上去就生效：读的是 GET /users/{handle} 的 cover。 */}
          <CoverPicker
            cover={coverQuery.data?.cover ?? null}
            pending={saveCover.isPending}
            label={coverQuery.data?.cover ? '更换封面' : '加个封面'}
            onPick={(file) => saveCover.mutate(file)}
            // 「清空封面」= DELETE /me/cover：主页回到默认站内素材（不是一片空白）。
            actions={coverQuery.data?.cover ? (
              <Button inline={false} height={ControlsHeight.S} disabled={removeCover.isPending} onClick={() => removeCover.mutate()}>
                {removeCover.isPending ? '清除中…' : '清空封面'}
              </Button>
            ) : (
              <span className='text-[11px] text-muted-foreground'>现在用的是默认素材。</span>
            )}
          />
        </span>
        <span className='text-[11px] leading-relaxed text-muted-foreground'>
          封面长在你的个人主页顶部；没设过时用站内默认素材。
        </span>
        {saveCover.isError ? <FormAlert tone='error' title='没能上传封面' description={errorText(saveCover.error)} /> : null}
        {removeCover.isError ? <FormAlert tone='error' title='没能清空封面' description={errorText(removeCover.error)} /> : null}
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

      {/* 赞赏与收款码（L1）：原先这里只写了一句「本轮不排」的注释 —— 后端 13 条端点一直都有，
          缺的是这一块客户端。版面在 payment-channels.tsx（View），取数在 payment-channels-hook.ts，
          设置页只负责把两者接起来（同一个 View 也被个人主页那颗「设置我的收款码」弹层用着）。 */}
      <PaymentChannelsPanel
        channels={channels.channels}
        pending={channels.channelsPending}
        error={channels.channelsError}
        settings={channels.settings}
        settingsPending={channels.settingsPending}
        settingsError={channels.settingsError}
        saveError={channels.saveError}
        notice={channels.notice}
        onNotice={channels.setNotice}
        onAdd={channels.onAdd}
        addPending={channels.addPending}
        addError={channels.addError}
        onDelete={channels.onDelete}
        removePending={channels.removePending}
        removeError={channels.removeError}
        onShowChannels={channels.onShowChannels}
      />
      <DonationRecordsPanel />

      {/* D75（用户原话）：退出登录放设置页**最下面**、按钮标红。动作仍是上面沿用那份 signOut
          （失败提示也在它原来的 FormAlert 位置），这里只是搬入口 + 危险色。 */}
      <footer className='flex flex-col items-center gap-2 py-8'>
        <Button danger inline={false} icon={icon16(LogOut)} data-testid='settings-logout' onClick={() => signOut.mutate()}>
          退出登录
        </Button>
        <span className='text-[12px] text-muted-foreground'>只退出这台设备（其它设备不受影响）。想把所有设备都退掉，去改密码。</span>
      </footer>
    </div>
  );
}

function errorText(e: unknown): string {
  return isApiError(e) ? apiErrorLine(e) : String(e);
}
