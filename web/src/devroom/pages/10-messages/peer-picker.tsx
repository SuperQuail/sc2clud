import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { Search, UserRoundSearch } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { UserBadge } from '@/ui/user/user-badge';
import type { Peer } from './types';

// 选聊天对象：Ring UI Dialog（遮罩点击 / Esc / 焦点陷阱都由控件负责）+ Input 过滤 + 每人一个动作按钮。
// 搜索是纯前端过滤（本页 mock）；结果是头像 + 昵称 + @handle，键盘 Tab 得到、输入即过滤。
export function PeerPicker({
  people,
  existing,
  onPick,
  onClose,
}: {
  people: Peer[];
  /** 已经有会话的 handle：这些人的动作是「打开会话」，其余是「发私信」 */
  existing: string[];
  onPick: (peer: Peer) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const key = q.trim().toLowerCase();
  const results = key
    ? people.filter((p) => p.nickname.toLowerCase().includes(key) || p.handle.toLowerCase().includes(key))
    : people;

  return (
    <Dialog
      show
      modal
      trapFocus
      label='选择聊天对象'
      showCloseButton
      onCloseAttempt={onClose}
      contentClassName='w-full max-w-[560px] p-5'
    >
      <div className='flex flex-col gap-4'>
        <div className='flex flex-col gap-1'>
          <h2 className='text-base font-semibold text-foreground'>选择聊天对象</h2>
          <p className='text-[12px] text-muted-foreground'>
            按昵称或 @handle 过滤，找到人后点「发私信」开始一对一私信。
          </p>
        </div>

        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          label='搜索昵称或 handle'
          placeholder='例：陆战队员 或 demo-marine'
          icon={icon16(Search)}
          autoFocus
        />

        <div className='flex max-h-[46vh] min-h-40 flex-col overflow-y-auto rounded-lg border border-border'>
          {results.length === 0 ? (
            <div className='flex flex-col items-center gap-1 px-4 py-10 text-center'>
              <UserRoundSearch aria-hidden className='size-6 text-muted-foreground' />
              <span className='text-[14px] font-medium text-foreground'>没有找到这个人</span>
              <span className='text-[12px] text-muted-foreground'>换个昵称，或试试对方的 @handle</span>
            </div>
          ) : (
            results.map((p) => (
              <div
                key={p.handle}
                className='flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-b-0'
              >
                <UserBadge user={p} size='md' showHandle className='min-w-0 flex-1' />
                <Button data-testid={'pick-peer-' + p.handle} onClick={() => onPick(p)}>
                  {existing.includes(p.handle) ? '打开会话' : '发私信'}
                </Button>
              </div>
            ))
          )}
        </div>

        <div className='flex items-center justify-end'>
          <Button onClick={onClose}>取消</Button>
        </div>
      </div>
    </Dialog>
  );
}
