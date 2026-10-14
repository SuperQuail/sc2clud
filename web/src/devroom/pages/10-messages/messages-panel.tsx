import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import type { ReactNode } from 'react';
import { ArrowLeft, Image, MessageSquarePlus, Smile, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { icon16 } from '@/ui/icons';
import { NoticeChat, type ChatMessage } from '@/ui/message/notice-chat';
import { NoticeComposer } from '@/ui/message/notice-composer';
import { ConversationList } from './conversation-list';
import type { Conversation } from './types';

// 私信面板：左栏会话列表 + 右栏聊天区（≥lg 并排，<lg 单栏：列表 → 聊天，可返回）。
// 全部由已有件组合：NoticeRow（会话行）/ NoticeChat（气泡）/ NoticeComposer（输入区）/ CountBadge / UserAvatar。
// 会话按**对方的 handle** 定位（与契约 GET /api/v1/messages/{handle} 一致）。
//
// **prop 驱动**（2026-10-14，照 12-topic/topic-view.tsx 的做法）：房间与真站渲染同一个组件。
// 数据（会话、当前会话、消息）与动作（选中、发送、搜人）全部由宿主给 —— 组件里没有 mock、没有 fetch，
// 所以 `src/routes/messages.tsx` 接真端点时不需要把这个文件抄一份（两份必然在加载态与字距上分叉）。
// 选人弹层（PeerPicker）也由宿主任一函数给：房间给本地目录，真站给 GET /search?type=users。

/** 编辑器给的是 HTML；契约里私信体是纯文本 body，所以入库前先剥标签（列表摘要用同一份）。宿主也用它。 */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function MessagesPanel({
  conversations,
  selectedHandle,
  messages,
  onSelect,
  onSend,
  onOpenPicker,
  picker,
  title,
  headerActions,
  placeholder,
  empty,
  busy,
}: {
  conversations: Conversation[];
  selectedHandle: string | null;
  /** 当前会话的消息（时间序，最早在上）—— 反序由宿主做，因为真站的接口给的是倒序 */
  messages: ChatMessage[];
  onSelect: (handle: string) => void;
  /** 发送：正文由 NoticeComposer 给 json + html；入库前怎么剥标签是宿主的事 */
  onSend: (payload: { json: string; html: string }) => void;
  onOpenPicker: () => void;
  /** 选人弹层；返回 null 表示没打开。由宿主决定内容（真站是搜人，房间是本地目录） */
  picker?: () => ReactNode;
  /** 聊天区标题（默认用对方昵称） */
  title?: ReactNode;
  /** 聊天区标题右侧 */
  headerActions?: ReactNode;
  placeholder?: string;
  /** 一条会话都没有时替换整个右栏（宿主给 Empty / Loading / ErrorState） */
  empty?: ReactNode;
  /** 发送中（禁用发送键） */
  busy?: boolean;
}) {
  const current = conversations.find((c) => c.peer.handle === selectedHandle) ?? null;
  const chat = title ?? (current ? '与 ' + current.peer.nickname + ' 的私信' : null);

  return (
    <>
      <div className='grid gap-4 lg:h-[min(680px,calc(100vh-340px))] lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]'>
        {/* 左栏：会话列表（<lg 选了会话后让位给聊天区） */}
        <div className={cn('flex min-h-0 flex-col', current && 'hidden lg:flex')}>
          <ConversationList
            conversations={conversations}
            selectedHandle={selectedHandle}
            onSelect={onSelect}
            onOpenPicker={onOpenPicker}
          />
        </div>

        {/* 右栏：聊天区 / 空态 */}
        <div className={cn('flex min-h-0 flex-col gap-3', !current && 'hidden lg:flex')}>
          {current ? (
            <>
              <div className='lg:hidden'>
                <Button inline={false} height={ControlsHeight.S} icon={icon16(ArrowLeft)} onClick={() => onSelect('')}>
                  返回会话列表
                </Button>
              </div>
              {/* grid 让 NoticeChat 自己撑满这一格（它是 flex 列，消息区才会内部滚动） */}
              <div className='grid min-h-0 flex-1'>
                <NoticeChat messages={messages} title={chat} headerActions={headerActions}>
                  <NoticeComposer
                    maxLength={500}
                    placeholder={placeholder ?? (messages.length === 0 ? '还没有消息，先打个招呼吧' : '请输入消息内容')}
                    onSubmit={busy ? undefined : onSend}
                    toolSlot={
                      <span className='flex items-center gap-1'>
                        <Button ghost icon={icon16(Image)} aria-label='发送图片' />
                        <Button ghost icon={icon16(Smile)} aria-label='表情' />
                      </span>
                    }
                    // 发送者只影响 aria 提示，真站的头像与昵称由宿主的会话数据给
                    me={{ nickname: '我' }}
                  />
                </NoticeChat>
              </div>
            </>
          ) : (
            (empty ?? <NoConversation onPick={onOpenPicker} />)
          )}
        </div>
      </div>

      {picker?.()}
    </>
  );
}

/** 一条会话都没有（或没选会话）时的右栏 */
function NoConversation({ onPick }: { onPick: () => void }) {
  return (
    <div className='flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-8 text-center'>
      <MessageSquarePlus aria-hidden className='size-7 text-muted-foreground' />
      <span className='text-[15px] font-medium text-foreground'>选一个聊天对象开始</span>
      <span className='max-w-[38ch] text-[13px] leading-relaxed text-muted-foreground'>
        在左边挑一个已有会话，或直接搜索站内用户发起新的私信；对方的昵称与主页会显示在聊天顶部。
      </span>
      <span className='mt-1'>
        <Button primary inline={false} height={ControlsHeight.M} icon={icon16(UserPlus)} onClick={onPick}>
          选择聊天对象
        </Button>
      </span>
    </div>
  );
}
