import type { ReactNode } from 'react';
import { UserAvatar } from '@/ui/user/avatar';

// 会话视图（私信）。**纯展示**：谁发的、内容、时间都由调用方给；输入区通过 children 传入。
// 气泡只区分「我」和「对方」两种，不写业务语义。
export type ChatMessage = {
  id: string;
  /** me = 当前用户；other = 对方 */
  from: 'me' | 'other';
  nickname: string;
  avatar?: string | null;
  /** 已渲染的正文（HTML 片段） */
  html: ReactNode;
  time: string;
  /** 气泡下方的补充说明，例如「此条消息为自动回复」 */
  note?: string;
};

export function NoticeChat({
  messages,
  title,
  headerActions,
  renderActions,
  children,
}: {
  messages: ChatMessage[];
  title?: ReactNode;
  headerActions?: ReactNode;
  /**
   * 逐条动作槽位。**调用方决定哪几条有动作**（例如只有自己发的私信能撤回）——
   * 控件本身不知道业务语义，也不做权限判断。返回 null/undefined 时这一格不占位。
   */
  renderActions?: (message: ChatMessage) => ReactNode;
  /** 输入区 */
  children?: ReactNode;
}) {
  return (
    <section className='flex min-h-96 flex-col overflow-hidden rounded-lg border border-border bg-background'>
      {title ? (
        <header className='flex items-center gap-3 border-b border-border px-4 py-3'>
          <h2 className='text-[15px] font-semibold text-foreground'>{title}</h2>
          <span className='ml-auto'>{headerActions}</span>
        </header>
      ) : null}
      <div className='flex flex-1 flex-col gap-5 overflow-y-auto p-5'>
        <span className='mx-auto text-[12px] text-muted-foreground'>{messages[0]?.time ?? ''}</span>
        {messages.map((m) => {
          const mine = m.from === 'me';
          // 没有动作时**不渲染空节点**：宿主每条都调一次，返回 undefined 是常态
          const actions = renderActions?.(m);
          return (
            <div
              key={m.id}
              data-testid={'chat-' + m.from}
              className={'flex gap-3 ' + (mine ? 'flex-row-reverse' : '')}
            >
              <UserAvatar name={m.nickname} src={m.avatar} size='md' />
              <div className={'flex min-w-0 max-w-[36rem] flex-col gap-1 ' + (mine ? 'items-end' : 'items-start')}>
                <div
                  className={
                    'rounded-2xl px-4 py-2.5 text-[15px] leading-[1.6] text-foreground ' +
                    (mine ? 'bg-primary/10' : 'bg-muted')
                  }
                >
                  {m.html}
                </div>
                {m.note ? <span className='text-[12px] text-muted-foreground'>{m.note}</span> : null}
                {actions ? <span className='flex items-center gap-1'>{actions}</span> : null}
              </div>
            </div>
          );
        })}
      </div>
      {children}
    </section>
  );
}
