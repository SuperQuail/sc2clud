import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { DropdownItem, DropdownPanel } from '@/ui/dropdown-panel';
import { UserAvatar } from '@/ui/user/avatar';
import { Username } from '@/ui/user/username';

// @ 提及选择器。需求：`GET /api/v1/users/search?q=`（按昵称前缀 + 用户名），重名要标记。
// 面板复用我们自己的 DropdownPanel（点外部/Esc 关闭、上下自适应），输入框用 Ring UI Input。
export type MentionCandidate = { id: string; nickname: string; handle: string; avatar?: string | null; role?: { key: string; name: string } | null };

export function MentionPicker({
  candidates,
  onPick,
}: {
  candidates: MentionCandidate[];
  onPick: (c: MentionCandidate) => void;
}) {
  const [q, setQ] = useState('');
  const matched = candidates.filter(
    (c) => c.nickname.toLowerCase().includes(q.toLowerCase()) || c.handle.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <DropdownPanel label='提及某人' width='w-72' trigger={<Button ghost>@ 提及</Button>}>
      <span className='px-1 pb-1'>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder='搜索昵称或用户名…' />
      </span>
      {matched.length === 0 ? (
        <span className='px-2 py-1.5 text-muted-foreground'>没有匹配的人</span>
      ) : (
        matched.map((c) => (
          <DropdownItem key={c.id} onClick={() => onPick(c)}>
            <span className='flex min-w-0 items-center gap-2'>
              <UserAvatar name={c.nickname} src={c.avatar} size='sm' />
              <Username nickname={c.nickname} />
              <span className='shrink-0 text-[11px] text-muted-foreground'>@{c.handle}</span>
            </span>
          </DropdownItem>
        ))
      )}
    </DropdownPanel>
  );
}
