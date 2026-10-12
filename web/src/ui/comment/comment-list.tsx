import { useState } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { CommentItem } from './comment-item';
import { CommentReplies } from './comment-replies';
import { ReplyBox } from './reply-box';
import type { CommentData } from './types';

// 评论区（对照 B 站）：表头「评论 N」+ 最热｜最新；下面是常驻的评论编辑器；
// 每条评论点「回复」就地再出现一个编辑器（没有取消按钮，点别处即收）。
const SORTS = ['最热', '最新'] as const;

export function CommentList({
  comments,
  total,
  me,
  onSubmit,
}: {
  comments: CommentData[];
  total?: number;
  me: { nickname: string; avatar?: string | null };
  onSubmit?: (parentId: string | null, body: string) => void;
}) {
  const [sort, setSort] = useState<(typeof SORTS)[number]>('最热');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  return (
    <section className='flex flex-col gap-5'>
      <header className='flex flex-wrap items-center gap-4'>
        <h2 className='text-lg font-semibold text-foreground'>
          评论 <span className='tabular-nums'>{total ?? comments.length}</span>
        </h2>
        <span className='flex items-center gap-3'>
          {SORTS.map((s, i) => (
            <span key={s} className='flex items-center gap-3'>
              {i > 0 ? <span aria-hidden className='h-3 w-px bg-border' /> : null}
              <Button ghost active={sort === s} onClick={() => setSort(s)}>
                {s}
              </Button>
            </span>
          ))}
        </span>
      </header>

      <ReplyBox me={me} onSubmit={(body) => onSubmit?.(null, body)} />

      <div className='flex flex-col gap-6'>
        {comments.map((c) => (
          <CommentItem
            key={c.id}
            comment={c}
            onReply={() => setReplyingTo(replyingTo === c.id ? null : c.id)}
          >
            {c.replies && c.replies.total > 0 ? (
              <CommentReplies replies={c.replies} onReply={(id) => setReplyingTo(id)} />
            ) : null}
            {replyingTo === c.id ? (
              <div className='mt-3'>
                <ReplyBox
                  me={me}
                  replyingTo={c.author.nickname}
                  onSubmit={(body) => {
                    onSubmit?.(c.id, body);
                    setReplyingTo(null);
                  }}
                />
              </div>
            ) : null}
          </CommentItem>
        ))}
      </div>
    </section>
  );
}
