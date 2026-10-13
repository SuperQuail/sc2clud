import { useState, type FormEvent } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Island from '@jetbrains/ring-ui-built/components/island/island';
import { LogOut, ShieldCheck, UserRound } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { PasswordField } from '@/ui/password-field';
import { ImageUploader } from '@/ui/rich/image-uploader';
import { COMPRESS_LABEL } from '@/ui/rich/image-pipeline';
import { roomHref } from '@/devroom/room-links';

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
  onAvatar: (url: string | null) => void;
  /** 上传器挂载后回调：open() 等于用户点了「更换头像」 */
  onAvatarReady?: (api: AvatarHandle | null) => void;
  /** 退出登录。真实页面：清会话 → 回登录页；这里是 mock 开关 */
  onLogout: () => void;
  /** 已退出登录后账号动作收起，只留「去登录」 */
  loggedOut?: boolean;
};

// 设计稿里的「当前密码」。为什么要有它：真实校验在服务端，房间里没有服务端，
// 而「当前密码错」与「两次不一致」必须是**两种可分辨的失败态**（盲审二号要求），
// 所以给一个演示口令，让两个分支都能真的走到。
const DEMO_PASSWORD = 'sc2clud';

export function AccountPanel({ avatar, onAvatar, onAvatarReady, onLogout, loggedOut = false }: AccountPanelProps) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; repeat?: string }>({});
  const [done, setDone] = useState(false);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // 分支顺序不是随意的：**先看「两次不一致」**（用户当场能自己改），再看「当前密码错」（得去回想或找回）。
    // 两条同时错时，先提示能自己解决的那条。
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
          <ImageUploader
            variant='avatar'
            label='上传头像'
            compress
            images={
              avatar
                ? [{ id: 'me', name: 'avatar.webp', size: 0, url: avatar, original: false, file: new Blob() }]
                : []
            }
            onChange={(list) => onAvatar(list[0]?.url ?? null)}
            onReady={onAvatarReady}
          />
          <span className='text-[11px] leading-relaxed text-muted-foreground'>
            方形图最好看。{COMPRESS_LABEL}；头像成品目标 ≤64KB（服务端硬上限 128KB），所以原图大一点也传得进来。
          </span>
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
          {done ? (
            <p role='status' data-testid='password-done' className='rounded-md bg-muted/60 px-3 py-2 text-[13px] leading-relaxed text-foreground'>
              密码已修改。所有设备（包括这一台）上的登录都已失效，请用新密码重新登录。真实页面在这里清 cookie 并跳到
              <a className='underline' href={roomHref('16-auth')}>
                登录页
              </a>
              。
            </p>
          ) : null}
          <span className='flex flex-wrap items-center gap-2'>
            <Button primary inline={false} type='submit' data-testid='password-save'>
              保存新密码
            </Button>
            <span className='text-[11px] text-muted-foreground'>设计稿口令是 {DEMO_PASSWORD}（真实校验在服务端）</span>
          </span>
        </form>
      </Island>
      )}

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
              <Button primary inline={false} href={roomHref('16-auth')} icon={icon16(LogOut)}>
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
    </div>
  );
}
