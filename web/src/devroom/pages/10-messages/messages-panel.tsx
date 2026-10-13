import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { ArrowLeft, Image, MessageSquarePlus, Settings, Smile, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { icon16 } from '@/ui/icons';
import { NoticeChat } from '@/ui/message/notice-chat';
import { NoticeComposer } from '@/ui/message/notice-composer';
import { UserAvatar } from '@/ui/user/avatar';
import { ConversationList } from './conversation-list';
import { PeerPicker } from './peer-picker';
import { CONVERSATIONS, DIRECTORY, ME } from './mock';
import type { Conversation, Peer } from './types';
import { roomHref } from '@/devroom/room-links';

// 私信面板：左栏会话列表 + 右栏聊天区（≥lg 并排，<lg 单栏：列表 → 聊天，可返回）。
// 全部由已有件组合：NoticeRow（会话行）/ NoticeChat（气泡）/ NoticeComposer（输入区）/ CountBadge / UserAvatar。
// 会话按**对方的 handle** 定位（与契约 GET /api/v1/messages/{handle} 一致），所以 URL 里也是 ?peer=<handle>。

/** 编辑器给的是 HTML；契约里私信体是纯文本 body，所以入库前先剥标签（列表摘要用同一份）。 */
function plainText(html: string): string {
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

export function MessagesPanel({ initialPeer }: { initialPeer: string | null }) {
  // 没给 peer（或给了不存在的）时默认选第一条会话，而不是空白
  const opening =
    initialPeer && CONVERSATIONS.some((c) => c.peer.handle === initialPeer)
      ? initialPeer
      : (CONVERSATIONS[0]?.peer.handle ?? null);
  // 打开会话即已读：从 URL 进来和点列表进来的结果必须一样
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    CONVERSATIONS.map((c) => (c.peer.handle === opening ? { ...c, unread: 0 } : c)),
  );
  const [peerHandle, setPeerHandle] = useState<string | null>(opening);
  const [picking, setPicking] = useState(false);

  const current = conversations.find((c) => c.peer.handle === peerHandle) ?? null;

  /** 打开会话＝把它的未读清掉（真实 IM 的行为） */
  function open(handle: string) {
    setPeerHandle(handle);
    setConversations((prev) => prev.map((c) => (c.peer.handle === handle ? { ...c, unread: 0 } : c)));
  }

  function pick(peer: Peer) {
    setPicking(false);
    setConversations((prev) =>
      prev.some((c) => c.peer.handle === peer.handle)
        ? prev
        : [{ peer, messages: [], summary: '还没有消息', lastAt: '刚刚', unread: 0 }, ...prev],
    );
    open(peer.handle);
  }

  function send(payload: { json: string; html: string }) {
    const handle = peerHandle;
    const text = plainText(payload.html);
    if (!handle || !text) return;
    setConversations((prev) => {
      const next = prev.map((c) =>
        c.peer.handle === handle
          ? {
              ...c,
              messages: [
                ...c.messages,
                {
                  id: 'local-' + Date.now(),
                  from: 'me' as const,
                  nickname: ME.nickname,
                  avatar: ME.avatar,
                  html: text,
                  time: '刚刚',
                },
              ],
              summary: text.replace(/\n/g, ' ').slice(0, 24),
              lastAt: '刚刚',
              unread: 0,
            }
          : c,
      );
      // 刚说过话的会话排到最前（真实 IM 的行为）
      const hit = next.find((c) => c.peer.handle === handle);
      return hit ? [hit, ...next.filter((c) => c.peer.handle !== handle)] : next;
    });
  }

  const empty = current === null;

  return (
    <>
      <div className='grid gap-4 lg:h-[min(680px,calc(100vh-340px))] lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)]'>
        {/* 左栏：会话列表（<lg 选了会话后让位给聊天区） */}
        <div className={cn('flex min-h-0 flex-col', current && 'hidden lg:flex')}>
          <ConversationList
            conversations={conversations}
            selectedHandle={peerHandle}
            onSelect={open}
            onOpenPicker={() => setPicking(true)}
          />
        </div>

        {/* 右栏：聊天区 / 空态 */}
        <div className={cn('flex min-h-0 flex-col gap-3', empty && 'hidden lg:flex')}>
          {current ? (
            <>
              <div className='lg:hidden'>
                <Button inline={false} height={ControlsHeight.S} icon={icon16(ArrowLeft)} onClick={() => setPeerHandle(null)}>
                  返回会话列表
                </Button>
              </div>
              {/* grid 让 NoticeChat 自己撑满这一格（它是 flex 列，消息区才会内部滚动） */}
              <div className='grid min-h-0 flex-1'>
                <NoticeChat
                  messages={current.messages}
                  title={'与 ' + current.peer.nickname + ' 的私信'}
                  headerActions={
                    <span className='flex items-center gap-3'>
                      <a
                        href={roomHref('11-profile')}
                        className='flex items-center gap-2 rounded-[3px] px-1 py-0.5 outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50'
                        title={'查看 ' + current.peer.nickname + ' 的主页'}
                      >
                        <UserAvatar name={current.peer.nickname} src={current.peer.avatar} size='sm' />
                        <span className='text-[13px] text-muted-foreground'>@{current.peer.handle}</span>
                      </a>
                      <Button ghost icon={icon16(Settings)} aria-label='会话设置' />
                    </span>
                  }
                >
                  <NoticeComposer
                    me={ME}
                    maxLength={500}
                    placeholder={current.messages.length === 0 ? '还没有消息，先打个招呼吧' : '请输入消息内容'}
                    onSubmit={send}
                    toolSlot={
                      <span className='flex items-center gap-1'>
                        <Button ghost icon={icon16(Image)} aria-label='发送图片' />
                        <Button ghost icon={icon16(Smile)} aria-label='表情' />
                      </span>
                    }
                  />
                </NoticeChat>
              </div>
            </>
          ) : (
            <NoConversation onPick={() => setPicking(true)} />
          )}
        </div>
      </div>

      {picking ? (
        <PeerPicker
          people={DIRECTORY}
          existing={conversations.map((c) => c.peer.handle)}
          onPick={pick}
          onClose={() => setPicking(false)}
        />
      ) : null}
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