import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { CommentActionsRow } from './comment-actions-row';
import { ReplyBox } from '@/ui/comment/reply-box';
import type { MentionCandidate } from '@/ui/comment/mention-types';
import type { CommentData } from '@/ui/comment/types';

// 帖子页的评论区：**复用 08 样板间的同一批件**（CommentItem/CommentActions/ReplyBox），
// 只把「发布」接上状态，并给自己的回复补两个悬挂动作（删除 / 举报）。
// 为什么动的是这一页而不是 08：08 是控件样板间，演示的是**控件本身**；
// 「发出去之后长什么样」是页面的事——所以状态与落点都在这里（缺陷处理总纲 §7：动作不许静默）。
//
// 三件事都必须有可观察的结果：
//   ① 发布 → 列表里真的多一条、表头计数 +1（原来是文本原地不动、计数不变）；
//   ② 删除自己的回复 → 原位留「该回复已删除」，计数 -1；
//   ③ 举报 → 按钮变「已举报」+ 一行回执（弹层由页面给，这里只把 target 发出去）。
export type NewComment = {
  id: string;
  author: CommentData['author'];
  body: string;
  createdAt: string;
  likes: number;
  dislikes: number;
};

export function TopicComments({
  comments,
  total,
  me,
  candidates,
  onSubmit,
  onVote,
  onDelete,
  reportedIds,
  onReport,
  newSeqs = {},
  receipt,
}: {
  comments: CommentData[];
  total: number;
  /** me.handle 用来判「这条是不是我的」——只有自己的回复才给删除入口 */
  me: { nickname: string; avatar?: string | null; handle: string };
  candidates: MentionCandidate[];
  /** parentId 为 null = 主楼；非空 = 楼中楼 */
  onSubmit: (parentId: string | null, body: { json: string; html: string }) => void;
  onVote: (id: string, value: 1 | -1) => void;
  /** 只删自己的：id = 被删的那条，parentId 非空 = 它长在哪个主楼下 */
  onDelete: (parentId: string | null, id: string) => void;
  reportedIds: string[];
  onReport: (target: { id: string; label: string }) => void;
  /** 新发的评论序号（id → seq）：新回复要置顶、要能在「最新」里排前面 */
  newSeqs?: Record<string, number>;
  /** 页面给的回执行（「已发布」「已删除」…）：评论区只负责把动作发出去 */
  receipt?: ReactNode;
}) {
  const [sort, setSort] = useState<'最热' | '最新'>('最热');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  // 楼中楼的「回复」与主楼内联框各用一个 key：两个都开着会让人不知道在回谁
  const [replyBoxFor, setReplyBoxFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);

  const seqOf = (c: CommentData) => newSeqs[c.id] ?? -1;
  const list = sort === '最热' ? comments : [...comments].sort((a, b) => seqOf(b) - seqOf(a));

  return (
    <section className='flex flex-col gap-5'>
      <header className='flex flex-wrap items-center gap-4'>
        <h2 className='text-lg font-semibold text-foreground'>
          评论 <span data-testid='comment-total' className='tabular-nums'>{total}</span>
        </h2>
        <span className='flex items-center gap-3'>
          {(['最热', '最新'] as const).map((s, i) => (
            <span key={s} className='flex items-center gap-3'>
              {i > 0 ? <span aria-hidden className='h-3 w-px bg-border' /> : null}
              <Button ghost active={sort === s} onClick={() => setSort(s)}>
                {s}
              </Button>
            </span>
          ))}
        </span>
      </header>

      <ReplyBox me={me} candidates={candidates} onSubmit={(body) => onSubmit(null, body)} />
      {receipt}

      <div className='flex flex-col gap-6'>
        {list.map((c) => (
          <div key={c.id} className='flex min-w-0 flex-1 flex-col'>
            <CommentActionsRow
              comment={c}
              mine={c.author.handle === me.handle}
              onLike={() => onVote(c.id, 1)}
              onDislike={() => onVote(c.id, -1)}
              onReply={() => setReplyingTo(replyingTo === c.id ? null : c.id)}
              onDelete={() => onDelete(null, c.id)}
              reported={reportedIds.includes(c.id)}
              onReport={() =>
                onReport({ id: c.id, label: '回复 · ' + c.author.nickname + '：' + strip(c.body).slice(0, 24) })
              }
            />

            <Replies
              parent={c}
              me={me}
              candidates={candidates}
              replyingTo={replyingTo}
              setReplyingTo={setReplyingTo}
              replyBoxFor={replyBoxFor}
              setReplyBoxFor={setReplyBoxFor}
              seqOf={seqOf}
              expanded={expanded.includes(c.id)}
              toggleExpanded={() =>
                setExpanded(expanded.includes(c.id) ? expanded.filter((x) => x !== c.id) : [...expanded, c.id])
              }
              onVote={onVote}
              onDelete={onDelete}
              reportedIds={reportedIds}
              onReport={onReport}
              onSubmit={onSubmit}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/** 主楼下挂的东西：楼中楼 + 「回复」内联框。 */
function Replies({
  parent,
  me,
  candidates,
  replyingTo,
  setReplyingTo,
  replyBoxFor,
  setReplyBoxFor,
  seqOf,
  expanded,
  toggleExpanded,
  onVote,
  onDelete,
  reportedIds,
  onReport,
  onSubmit,
}: {
  parent: CommentData;
  me: { nickname: string; avatar?: string | null; handle: string };
  candidates: MentionCandidate[];
  replyingTo: string | null;
  setReplyingTo: (v: string | null) => void;
  replyBoxFor: string | null;
  setReplyBoxFor: (v: string | null) => void;
  /** 新发的回复序号：刚发的那条必须立刻可见（哪怕它排在预览条数之外） */
  seqOf: (c: CommentData) => number;
  expanded: boolean;
  toggleExpanded: () => void;
  onVote: (id: string, value: 1 | -1) => void;
  onDelete: (parentId: string | null, id: string) => void;
  reportedIds: string[];
  onReport: (target: { id: string; label: string }) => void;
  onSubmit: (parentId: string | null, body: { json: string; html: string }) => void;
}) {
  const replies = parent.replies;
  // 楼中楼缩进 = 头像宽 40 + 间距 12（与 CommentItem 的 gap-3 同源），改一处就能对上
  const INDENT = 'ml-[52px]';
  if (!replies || replies.total === 0) {
    return replyingTo === parent.id ? (
      <div className='mt-3'>
        <ReplyBox
          me={me}
          candidates={candidates}
          replyingTo={parent.author.nickname}
          onSubmit={(body) => {
            onSubmit(parent.id, body);
            setReplyingTo(null);
          }}
        />
      </div>
    ) : null;
  }
  const preview = replies.previewCount ?? 2;
  // 新发的回复永远在可见那一段里：不然「发布」之后它落在预览条数之外，看起来还是没反应
  const fresh = replies.items.filter((r) => seqOf(r) >= 0);
  const rest = replies.items.filter((r) => seqOf(r) < 0);
  const shown = [...fresh, ...(expanded ? rest : rest.slice(0, Math.max(0, preview - fresh.length)))];
  const hidden = Math.max(0, replies.total - shown.length);

  return (
    <div className={'mt-3 flex flex-col gap-4 ' + INDENT}>
      {shown.map((r) => (
        <div key={r.id} className='flex min-w-0 flex-1 flex-col'>
          <CommentActionsRow
            comment={r}
            level='reply'
            mine={r.author.handle === me.handle}
            onLike={() => onVote(r.id, 1)}
            onDislike={() => onVote(r.id, -1)}
            onReply={() => setReplyBoxFor(replyBoxFor === r.id ? null : r.id)}
            onDelete={() => onDelete(parent.id, r.id)}
            reported={reportedIds.includes(r.id)}
            onReport={() =>
              onReport({ id: r.id, label: '回复 · ' + r.author.nickname + '：' + strip(r.body).slice(0, 24) })
            }
          />
          {replyBoxFor === r.id ? (
            <div className='mt-3'>
              <ReplyBox
                me={me}
                candidates={candidates}
                replyingTo={r.author.nickname}
                onSubmit={(body) => {
                  onSubmit(parent.id, body);
                  setReplyBoxFor(null);
                }}
              />
            </div>
          ) : null}
        </div>
      ))}
      {replies.total > preview ? (
        <div>
          <Button ghost onClick={toggleExpanded}>
            {expanded ? '收起' : '展开 ' + hidden + ' 条回复'}
          </Button>
        </div>
      ) : null}
      {replyingTo === parent.id ? (
        <div>
          <ReplyBox
            me={me}
            candidates={candidates}
            replyingTo={parent.author.nickname}
            onSubmit={(body) => {
              onSubmit(parent.id, body);
              setReplyingTo(null);
            }}
          />
        </div>
      ) : null}
    </div>
  );
}

/** 取正文的纯文字前若干字：举报回执与 aria 文案里要能认出是哪一条。 */
function strip(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
}
