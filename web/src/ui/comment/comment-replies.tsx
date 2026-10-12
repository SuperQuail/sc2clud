import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { CommentItem } from './comment-item';
import type { CommentReplies } from './types';

// 楼中楼。默认只显示 previewCount 条，其余靠 Ring UI Button 展开/收起。
// **不加左侧竖线**（试过，很丑）；层级靠头像缩进与间距表达。
export function CommentReplies({
  replies,
  onReply,
}: {
  replies: CommentReplies;
  onReply?: (id: string) => void;
}) {
  const preview = replies.previewCount ?? 2;
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? replies.items : replies.items.slice(0, preview);
  const hidden = Math.max(0, replies.total - shown.length);

  return (
    <div className='mt-3 flex flex-col gap-4'>
      {shown.map((r) => (
        <CommentItem
          key={r.id}
          comment={r}
          avatarSize='sm'
          onReply={() => onReply?.(r.id)}
        />
      ))}
      {replies.total > preview ? (
        <div>
          <Button ghost onClick={() => setExpanded((v) => !v)}>
            {expanded ? '收起' : '展开 ' + hidden + ' 条回复'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
