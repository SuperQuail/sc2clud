import Button from '@jetbrains/ring-ui-built/components/button/button';
import { UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { icon16 } from '@/ui/icons';
import { CountBadge } from '@/ui/message/count-badge';
import { NoticeRow } from '@/ui/message/notice-row';
import type { Conversation } from './types';

// 左栏：会话列表（对方头像 + 昵称 + 最后一条摘要 + 时间 + 未读角标，当前会话有选中态）。
// 行用共享件 NoticeRow（数据驱动），点击/键盘进入会话由这里的容器负责——NoticeRow 是纯展示件，
// 它自己没有整行点击（这一点在它的源码里写明：内容与动作由调用方给）。
// 卡片外壳没有用 NoticeList：它的内容容器没有 min-h-0/flex-1，会话多了会**裁掉**而不是滚动。
export function ConversationList({
  conversations,
  selectedHandle,
  onSelect,
  onOpenPicker,
}: {
  conversations: Conversation[];
  selectedHandle: string | null;
  onSelect: (handle: string) => void;
  onOpenPicker: () => void;
}) {
  const unread = conversations.reduce((n, c) => n + c.unread, 0);
  return (
    <div className='flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-background'>
      <header className='flex items-center gap-2 border-b border-border px-3 py-2.5'>
        <h2 className='text-[15px] font-semibold text-foreground'>私信</h2>
        {unread > 0 ? <CountBadge count={unread} /> : null}
        <span className='ml-auto'>
          <Button data-testid='open-peer-picker' icon={icon16(UserPlus)} onClick={onOpenPicker}>
            选择聊天对象
          </Button>
        </span>
      </header>

      <div className='flex min-h-0 flex-1 flex-col overflow-y-auto'>
        {conversations.length === 0 ? (
          <div className='flex flex-col items-center gap-2 px-4 py-12 text-center'>
            <span className='text-[15px] text-foreground'>还没有会话</span>
            <span className='text-[13px] text-muted-foreground'>点上面的「选择聊天对象」开始</span>
          </div>
        ) : (
          conversations.map((c) => (
            <ConversationRow
              key={c.peer.handle}
              conversation={c}
              selected={c.peer.handle === selectedHandle}
              onSelect={() => onSelect(c.peer.handle)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ConversationRow({
  conversation,
  selected,
  onSelect,
}: {
  conversation: Conversation;
  selected: boolean;
  onSelect: () => void;
}) {
  const { peer, summary, lastAt, unread } = conversation;
  return (
    <div
      role='button'
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      aria-label={'打开与 ' + peer.nickname + ' 的私信' + (unread > 0 ? '，' + unread + ' 条未读' : '')}
      data-testid={'conversation-' + peer.handle}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      // 左侧细条表达选中（不占额外横向空间，未选中时用透明边框占位，切换不跳字）
      className={cn(
        'cursor-pointer border-l-[3px] border-l-transparent outline-none transition-colors',
        'hover:bg-muted/50 focus-visible:ring-[3px] focus-visible:ring-ring/50',
        selected && 'border-l-primary bg-primary/8',
      )}
    >
      <NoticeRow
        actors={[{ nickname: peer.nickname, avatar: peer.avatar }]}
        action={summary}
        time={lastAt}
        trailing={unread > 0 ? <CountBadge count={unread} /> : undefined}
      />
    </div>
  );
}
