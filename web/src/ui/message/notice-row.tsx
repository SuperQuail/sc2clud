import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import type { ReactNode } from 'react';
import { icon16 } from '@/ui/icons';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';

// 信息中心里的一行（回复我的 / @我的 / 收到的赞 / 系统通知 都用它）。
// **不针对任何业务**：谁说的话、什么动作、有什么动作按钮，全由调用方传入。
export type NoticeRowActor = { nickname: string; avatar?: string | null; color?: string | null };
export type NoticeRowAction = {
  key: string;
  label: string;
  icon?: Parameters<typeof icon16>[0];
  danger?: boolean;
  onClick?: () => void;
};

export function NoticeRow({
  actors,
  action,
  body,
  excerpt,
  time,
  actions = [],
  trailing,
  onActorClick,
}: {
  actors: NoticeRowActor[];
  /** 动作文字，例如「回复了我的评论」「在评论中@了我」 */
  action: string;
  /** 正文（支持已渲染的 HTML 片段） */
  body?: ReactNode;
  /** 被回复内容的引用样式 */
  excerpt?: ReactNode;
  time: string;
  actions?: NoticeRowAction[];
  /** 右侧缩略图等 */
  trailing?: ReactNode;
  onActorClick?: (nickname: string) => void;
}) {
  const shown = actors.slice(0, 2);
  return (
    <article className='flex gap-3 border-b border-border px-4 py-4 last:border-b-0'>
      <span className='flex shrink-0 items-center'>
        {shown.map((a, i) => (
          <span key={a.nickname} className={i === 0 ? '' : '-ml-2'}>
            <UserAvatar name={a.nickname} src={a.avatar} size='md' className='ring-2 ring-background' />
          </span>
        ))}
      </span>
      <div className='flex min-w-0 flex-1 flex-col gap-1.5'>
        <span className='flex flex-wrap items-baseline gap-x-2 gap-y-1'>
          {shown.map((a) => (
            <button
              key={a.nickname}
              type='button'
              onClick={() => onActorClick?.(a.nickname)}
              className='rounded-[3px] text-[15px] font-semibold text-foreground outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
            >
              {a.nickname}
            </button>
          ))}
          {actors.length > shown.length ? (
            <Username nickname={'等 ' + (actors.length - shown.length) + ' 人'} size='sm' />
          ) : null}
          <span className='text-[13px] text-muted-foreground'>{action}</span>
        </span>
        {body ? <div className='text-[15px] leading-[1.6] text-foreground'>{body}</div> : null}
        {excerpt ? (
          <div className='border-l-2 border-border pl-3 text-[13px] leading-[1.6] text-muted-foreground'>{excerpt}</div>
        ) : null}
        <span className='flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-muted-foreground'>
          <span className='tabular-nums'>{time}</span>
          {actions.map((a) => (
            // 动态文案（{a.label}）的按钮：**纯静态扫描看不出它会渲染文字**，会误判成纯图标。
            // 实测点击区 46x22（inline 把 padding 吃掉了），低于 24px 这一档 → 显式收口。
            <Button
              key={a.key}
              data-testid={'notice-action-' + a.key}
              inline={false}
              height={ControlsHeight.S}
              ghost
              icon={a.icon ? icon16(a.icon) : undefined}
              danger={a.danger}
              onClick={a.onClick}
            >
              {a.label}
            </Button>
          ))}
        </span>
      </div>
      {trailing ? <span className='shrink-0'>{trailing}</span> : null}
    </article>
  );
}
