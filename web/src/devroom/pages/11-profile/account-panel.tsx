import { useState, type FormEvent } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import { LogOut, ShieldCheck, UserRound } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { PasswordField } from '@/ui/password-field';
import type { UploadedImage } from '@/ui/rich/image-uploader';
import { roomHref } from '@/devroom/room-links';
import { AvatarSetting } from './avatar-setting';

// 本人主页 · 账号面板（**只有 isSelf 才渲染**，看别人主页时一行都不出现）。
// 补的是盲审二号报的第 ③ 类：控件都在、用户找不到入口（改密码 / 上传头像 / 退出登录）。
// 三件事放同一个面板，理由：它们同属「账号」，而「设置」标签页本来就是本人主页上的账号区，
// 不必新开一个 /settings 页面（房间里的站内跳转只能用 roomHref，见 room-links.tsx）。
//
// 接线口径（真实页面）：
//   改密码  PUT /api/v1/me/password —— 服务端一个事务里校验旧密码 + 换哈希 + **删掉全部会话**；
//   头像    POST /api/v1/me/avatar  —— 前端压到 ≤64KB 再传（image-pipeline 的 AVATAR_TARGET），
//           服务端 128KB 硬闸门 + 魔数复核（d1-platform.md §176）；
//   退出    POST /api/v1/auth/logout —— 删当前会话并清 cookie，然后回登录页。
// 三条接口都还没有，所以这是设计稿：动作有**可观察的结果**，但成功/失败由页面里的 mock 判定给出，不发请求。

/** 头像上传器挂载后回传的句柄：hero 上的「更换头像」用它代点，不必把上传器挪出设置面板 */
export type AvatarHandle = { open: () => void };

export type AccountPanelProps = {
  /** 当前头像（object URL 或服务端 /img/<hash>）。非空时上传器显示真图 */
  avatar?: string | null;
  /** 选中之后的预览 URL。**不传 = 面板自己存预览**（真站就属于这种：它只要下面那个文件回调） */
  onAvatar?: (url: string | null) => void;
  /** 上传器挂载后回调：open() 等于用户点了「更换头像」 */
  onAvatarReady?: (api: AvatarHandle | null) => void;
  /**
   * 头像**选中之后的真动作**。不传 = 房间口径（面板自己 setAvatar，选中即结果）；
   * 传了 = 交给调用方（真站要发 POST /me/avatar，所以它要的是文件而不是预览 URL）。
   * 与 onSubmitPassword 同一条理由：真站上不能把「本地选中 = 换好了」留在页面上。
   */
  onAvatarPick?: (next: UploadedImage[]) => void;
  /** 退出登录（D75）：真实页面的入口移到设置页**最底部**（那颗 danger 按钮在 routes/settings.tsx），
   *  真站不再传它 —— 本格不渲染，页面上就不会出现两颗「退出登录」；房间填上即是原样。 */
  onLogout?: () => void;
  /** 已退出登录后账号动作收起，只留「去登录」 */
  loggedOut?: boolean;
  /**
   * 改密码的**真提交**。不传 = 房间里那套本地演示校验（演示口令 sc2clud）；
   * 传了 = 交给调用方发请求（真站 POST /api/v1/me/password），本组件只负责先做两次一致性的本地拦截。
   * 为什么要有这个分支：真站复用同一个面板时，绝不能把「本地假口令通过 = 密码改了」留在页面上 ——
   * 用户会以为自己换了密码，而服务端那边压根没收到请求。
   */
  onSubmitPassword?: (body: { old_password: string; new_password: string }) => void;
  /** 提交中（真站用它禁按钮 + 转圈）；不传按房间口径处理 */
  passwordPending?: boolean;
  /** 成功态交给调用方（真站要等 200 才说「已修改」）；不传按房间口径处理 */
  passwordDone?: boolean;
  /** 「去登录」的落点。房间给 roomHref('16-auth')，真站给 appPath('login') */
  loginHref?: string;
};

// 设计稿里的「当前密码」。为什么要有它：真实校验在服务端，房间里没有服务端，
// 而「当前密码错」与「两次不一致」必须是**两种可分辨的失败态**（盲审二号要求），
// 所以给一个演示口令，让两个分支都能真的走到。
const DEMO_PASSWORD = 'sc2clud';

export function AccountPanel({
  avatar,
  onAvatar,
  onAvatarReady,
  onAvatarPick,
  onLogout,
  loggedOut = false,
  onSubmitPassword,
  passwordPending = false,
  passwordDone,
  loginHref,
}: AccountPanelProps) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; repeat?: string }>({});
  const [done, setDone] = useState(false);
  // 没给 onAvatar 时自己存预览（真站只关心 onAvatarPick 拿到的文件）
  const [ownAvatar, setOwnAvatar] = useState<string | null>(null);
  const shownAvatar = avatar ?? ownAvatar;
  // 真站（给了 onSubmitPassword）：成功态由调用方决定 ——「改完了」只在服务端回了 200 之后才准显示
  const succeeded = passwordDone ?? done;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // 分支顺序不是随意的：**先看「两次不一致」**（用户当场能自己改），再看「新密码太短」，
    // 最后才轮到「当前密码错」（得去回想或找回）。几条同时错时，先提示能自己解决的那条。
    // 前两条是本地就能判的，所以真站也照做 —— 省一次必然 400 的往返。
    if (next !== repeat) {
      setErrors({ repeat: '两次输入的新密码不一样，请再输一遍确认' });
      setDone(false);
      return;
    }
    if (next.length < 8) {
      setErrors({ next: '新密码至少 8 位（设计稿里的本地即时校验）' });
      setDone(false);
      return;
    }
    if (onSubmitPassword) {
      // 真站：当前密码对不对只有服务端知道（它回 fields.old_password）；成功态也在调用方那边
      setErrors({});
      setDone(false);
      onSubmitPassword({ old_password: current, new_password: next });
      setCurrent('');
      setNext('');
      setRepeat('');
      return;
    }
    if (current !== DEMO_PASSWORD) {
      setErrors({ current: '当前密码不对，请重新输入' });
      setDone(false);
      return;
    }
    setErrors({});
    setDone(true);
    setCurrent('');
    setNext('');
    setRepeat('');
  }

  return (
    <div className='flex flex-col gap-4'>
      {/* 已退出时连头像入口一起收起：没有会话就没有可上传的去处 */}
      {loggedOut ? null : (
      <Island withoutPaddings>
        <div className='flex flex-col gap-3 px-4 py-4'>
          <span className='flex items-center gap-2'>
            <UserRound aria-hidden className='size-4 text-muted-foreground' />
            <h3 className='text-[15px] font-medium text-foreground'>头像</h3>
          </span>
          {/* 与真站 /settings 的「头像」是**同一份实现**（avatar-setting.tsx）：房间选中即预览，
              真站选中后还要点「保存头像」才发 POST /me/avatar —— 差别只在调用方给的那一半。 */}
          <AvatarSetting
            avatar={shownAvatar}
            onChange={(list) => {
              const url = list[0]?.url ?? null;
              if (onAvatarPick) onAvatarPick(list);
              else setOwnAvatar(url);
              onAvatar?.(url);
            }}
            onReady={onAvatarReady}
          />
        </div>
      </Island>
      )}

      {/* 已退出时整块收起：留着「改密码」表单会出现「你已退出登录，但请先输入当前密码」这种自相矛盾的状态 */}
      {loggedOut ? null : (
      <Island withoutPaddings>
        <form className='flex flex-col gap-4 px-4 py-4' onSubmit={submit}>
          <span className='flex flex-wrap items-center gap-2'>
            <ShieldCheck aria-hidden className='size-4 text-muted-foreground' />
            <h3 className='text-[15px] font-medium text-foreground'>修改密码</h3>
            <span className='text-[13px] text-muted-foreground'>改完所有设备都要重新登录</span>
          </span>
          <div className='flex max-w-[420px] flex-col gap-3'>
            <PasswordField label='当前密码' value={current} onChange={setCurrent} error={errors.current} />
            <PasswordField
              label='新密码'
              value={next}
              onChange={setNext}
              error={errors.next}
              help='8–128 位，建议用一句只有你记得住的话'
            />
            <PasswordField label='确认新密码' value={repeat} onChange={setRepeat} error={errors.repeat} />
          </div>
          {succeeded ? (
            <p role='status' data-testid='password-done' className='rounded-md bg-muted/60 px-3 py-2 text-[13px] leading-relaxed text-foreground'>
              密码已修改。所有设备（包括这一台）上的登录都已失效，请用新密码重新登录。
              {onSubmitPassword ? null : (
                <>
                  真实页面在这里清 cookie 并跳到
                  <a className='underline' href={loginHref ?? roomHref('16-auth')}>
                    登录页
                  </a>
                  。
                </>
              )}
            </p>
          ) : null}
          <span className='flex flex-wrap items-center gap-2'>
            <Button primary inline={false} type='submit' data-testid='password-save' loader={passwordPending} disabled={passwordPending}>
              保存新密码
            </Button>
            {onSubmitPassword ? null : (
              <span className='text-[11px] text-muted-foreground'>设计稿口令是 {DEMO_PASSWORD}（真实校验在服务端）</span>
            )}
          </span>
        </form>
      </Island>
      )}

      {/* 这格只在调用方给了 onLogout 或已退出时才画（D75）：真站把动作放设置页最底部，
          这里再画一颗就是页面上有两颗同一动作的入口；loggedOut 时仍要它（只剩「去登录」一条路）。 */}
      {onLogout || loggedOut ? (
      <Island withoutPaddings>
        <div className='flex flex-col gap-3 px-4 py-4'>
          <span className='flex items-center gap-2'>
            <LogOut aria-hidden className='size-4 text-muted-foreground' />
            <h3 className='text-[15px] font-medium text-foreground'>退出登录</h3>
          </span>
          <p className='text-[13px] leading-relaxed text-muted-foreground'>
            {loggedOut
              ? '你已经退出了：这台设备上的登录已失效，要重新登录才能发帖、回复、上传。'
              : '只退出这台设备（其它设备不受影响）。想把所有设备都退掉，去改密码。'}
          </p>
          <span className='flex items-center gap-2'>
            {loggedOut ? (
              <Button primary inline={false} href={loginHref ?? roomHref('16-auth')} icon={icon16(LogOut)}>
                去登录
              </Button>
            ) : (
              <Button inline={false} onClick={onLogout} icon={icon16(LogOut)} data-testid='logout'>
                退出登录
              </Button>
            )}
          </span>
        </div>
      </Island>
      ) : null}
    </div>
  );
}
