import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import Input from '@jetbrains/ring-ui-built/components/input/input';
import { DisabledReason } from '../bits';

// 新增分区（§21.2 POST /admin/boards，权限点 board.manage）。
// 为什么是一个弹层表单而不是「就地加一行空白行」：分区有 slug 这个**建好就改不了**的字段
// （改 slug 会让旧链接失效），先在弹层里把名称与 slug 定下来，比在列表里加一行再回来改安全。
// 控件全部复用：Dialog（焦点陷阱/Esc/遮罩由 Ring UI 负责）+ Input + Button。
export type NewBoard = { name: string; slug: string; description: string };

const SLUG = /^[a-z0-9][a-z0-9-]{1,31}$/;

export function NewBoardDialog({ show, onClose, onCreate }: {
  show: boolean;
  onClose: () => void;
  onCreate: (board: NewBoard) => void;
}) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  if (!show) return null;

  const slugBad = slug !== '' && !SLUG.test(slug);
  const blocked = name.trim() === '' || !SLUG.test(slug);
  return (
    <Dialog show label='新增分区' onCloseAttempt={onClose} onOverlayClick={onClose} onEscPress={onClose}>
      <div className='flex w-[460px] max-w-full flex-col gap-3 p-4'>
        <p className='m-0 text-[12px] leading-relaxed text-muted-foreground'>
          分区是表驱动的：新增一个分区零代码改动（DB §4.2 / 老站把分区写成枚举，未知 key 会被静默丢弃）。
          新分区默认 <code className='rounded-sm bg-muted px-1'>acl_enabled = false</code>，也就是「登录即可发言」。
        </p>
        <Input label='名称' value={name} onChange={(e) => setName(e.target.value)} />
        <Input
          label='slug（URL 用）'
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          help='小写字母、数字与连字符，2–32 位；建好之后不可改（它已经在旧链接里）'
          error={slugBad ? '只允许小写字母、数字、连字符，且不能以连字符开头' : undefined}
        />
        <Input label='一句话简介' value={description} onChange={(e) => setDescription(e.target.value)} />
        {blocked ? <DisabledReason>名称与合法 slug 都填上才能创建</DisabledReason> : null}
        <div className='flex items-center justify-end gap-2'>
          <Button onClick={onClose}>取消</Button>
          <Button
            primary
            disabled={blocked}
            onClick={() => {
              onCreate({ name: name.trim(), slug: slug.trim(), description: description.trim() });
              setName('');
              setSlug('');
              setDescription('');
            }}
          >
            创建分区
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
