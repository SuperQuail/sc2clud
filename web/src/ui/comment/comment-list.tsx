import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { CommentItem } from './comment-item';
import { CommentReplies } from './comment-replies';
import { ReplyBox } from './reply-box';
import type { CommentData } from './types';

// 评论区：表头（数量 + 排序）＋ 顶层评论 ＋ 楼中楼 ＋ 就地回复框。
// 排序与展开都用 **Ring UI Button**（不引入新控件）。回复框只在被回复的那条下面出现。
const SORTS = ['最新', '最热'] as const;

export function CommentList({
  comments,
  total,
  headerExtra,
  onSubmitReply,
}: {
  comments: CommentData[];
  total?: number;
  headerExtra?: ReactNode;
  onSubmitReply?: (parentId: string, body: string) => void;
}) {
  const [sort, setSort] = useState<(typeof SORTS)[number]>('最新');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);

  return (
    <section className='flex flex-col gap-4'>
      <header className='flex flex-wrap items-center gap-3 border-b border-border pb-2'>
        <h2 className='text-sm font-semibold text-foreground'>
          {(total ?? comments.length)} 条评论
        </h2>
        <span className='flex items-center gap-1'>
          {SORTS.map((s) => (
            <Button key={s} ghost active={sort === s} onClick={() => setSort(s)}>
              {s}
            </Button>
          ))}
        </span>
        {headerExtra ? <span className='ml-auto'>{headerExtra}</span> : null}
      </header>

      <div className='flex flex-col gap-5'>
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
                  replyingTo={c.author.nickname}
                  onCancel={() => setReplyingTo(null)}
                  onSubmit={(body) => {
                    onSubmitReply?.(c.id, body);
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
