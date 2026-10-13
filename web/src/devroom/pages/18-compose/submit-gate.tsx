import { CheckCircle2, CircleAlert, Inbox } from 'lucide-react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { icon16 } from '@/ui/icons';
import { CommentBody } from '@/ui/comment/comment-body';
import { FormAlert } from '@/devroom/pages/16-auth/form-alert';
import { roomHref } from '@/devroom/room-links';
import { BOARD_NAME, tagLabel, type BoardKey } from './data';
import { visibleLength, type Draft } from './draft';

// 「不能提交」的判据在 draft.ts（它要能被测试直接调用），这里管的是**按下去会发生什么**：
// 提交区、结果态、预览卡。两件放在一起，是因为它们回答的是同一个问题 ——
// **按钮为什么是灰的 / 提交之后去哪**。分开写就会出现「禁用了但不说为什么」的洞
// （盲审合并结论 §2.7：十几个关键动作点了无反馈，人分不清「静默」与「坏了」）。

export function SubmitButton({ disabled, busy, onClick }: { disabled: boolean; busy: boolean; onClick: () => void }) {
  return (
    <Button
      data-testid='compose-submit'
      type='button'
      primary
      inline={false}
      height={ControlsHeight.L}
      disabled={disabled || busy}
      loader={busy}
      onClick={onClick}
    >
      {busy ? '提交中…' : '提交审核'}
    </Button>
  );
}

/** 表单底部的提交区：缺什么、为什么灰、以及没接上的那些动作（明说，不许静默）。 */
export function SubmitBar({ reason, busy, onSubmit }: { reason: string | null; busy: boolean; onSubmit: () => void }) {
  const blocked = reason !== null;
  return (
    <div className='flex flex-col gap-2 border-t border-border pt-3'>
      <div className='flex flex-wrap items-center gap-3'>
        <SubmitButton disabled={blocked} busy={busy} onClick={onSubmit} />
        <span className='text-[11px] text-muted-foreground'>草稿与自动保存还没定案（盲审合并结论 §7），这一版没有「存草稿」按钮。</span>
      </div>
      {blocked ? (
        <p data-testid='compose-missing' role='status' className='m-0 text-[12px] text-destructive'>
          {reason} —— 三项齐了才能提交。
        </p>
      ) : (
        <p className='m-0 text-[12px] text-muted-foreground'>三项齐了：标题、分区、正文。可以提交了。</p>
      )}
    </div>
  );
}

/** 提交后的结果态。**不许静默**：说清进的是哪条路径、去哪里看、这篇现在是什么状态。 */
export function SubmitResult({
  draft,
  trusted,
  onAgain,
  onBack,
}: {
  draft: Draft;
  /** trusted 作者直接发布（topics.status 的语义，与 15-admin 的审核队列同一套） */
  trusted: boolean;
  onAgain: () => void;
  onBack: () => void;
}) {
  const board = draft.board ? BOARD_NAME[draft.board] : '';
  return (
    <section data-testid='compose-result' className='flex flex-col gap-3 rounded-lg border border-border bg-card p-4'>
      <FormAlert
        tone='success'
        title={trusted ? '已提交，并已直接发布' : '已提交，进入审核'}
        description={
          trusted
            ? '你是 trusted 作者，这篇已发布：' + board + ' 分区现在就能看到它。'
            : '管理员通过后才会对其他人可见；审核期间只有你自己能看到这篇，位置在「我的主页 → 我的帖子」。'
        }
      />
      <div className='flex flex-wrap items-center gap-2'>
        {draft.tags.map((t) => (
          <span key={t} className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground'>
            {tagLabel(t)}
          </span>
        ))}
        <span className='text-[12px] text-muted-foreground'>
          {board} · 正文 {visibleLength(draft.html)} 字
        </span>
      </div>
      <h2 className='m-0 text-[15px] font-semibold text-foreground'>{draft.title.trim()}</h2>

      <ul className='m-0 flex list-none flex-col gap-1.5 p-0 text-[12px] text-muted-foreground'>
        <li className='flex items-start gap-1.5'>
          <Inbox aria-hidden className='mt-0.5 size-3.5 shrink-0' />
          {trusted
            ? '没有进审核队列：trusted 作者的帖子跳过人工审核。'
            : '审核队列在管理后台的「帖子审核」屏（15-admin 的 review），通过或驳回时你会收到通知。'}
        </li>
        <li className='flex items-start gap-1.5'>
          <CircleAlert aria-hidden className='mt-0.5 size-3.5 shrink-0' />
          被驳回时理由会显示在帖子页顶部（12-topic 的 rejected 态），改完可以重新提交 ——
          但「编辑帖子」本身的入口还没做（盲审合并结论 §3 第 13 条）。
        </li>
      </ul>

      <div className='flex flex-wrap items-center gap-2'>
        <Button primary inline={false} height={ControlsHeight.S} icon={icon16(CheckCircle2)} onClick={onAgain}>
          再写一篇
        </Button>
        <Button inline={false} height={ControlsHeight.S} onClick={onBack}>
          回到表单（内容还在）
        </Button>
      </div>
    </section>
  );
}

/** 预览卡：标题/分区/标签/正文与提交的是**同一份状态**，所以预览不会与发布结果漂移。 */
export function PreviewCard({ draft }: { draft: Draft }) {
  const title = draft.title.trim();
  const board = draft.board ? BOARD_NAME[draft.board] : '还没选分区';
  const empty = visibleLength(draft.html) === 0;
  return (
    <article className='flex flex-col gap-2 rounded-lg border border-border bg-card p-4'>
      <p className='m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground'>
        <span>{board}</span>
        {draft.tags.map((t) => (
          <span key={t} className='rounded-sm bg-muted px-1.5 py-0.5 text-[11px]'>
            {tagLabel(t)}
          </span>
        ))}
      </p>
      <h3 className={title ? 'm-0 text-[18px] leading-snug font-semibold break-words text-foreground' : 'm-0 text-[18px] font-semibold text-muted-foreground'}>
        {title || '（还没写标题）'}
      </h3>
      {empty ? (
        <p className='m-0 rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12px] text-muted-foreground'>
          写点正文，这里就是读者看到的样子（正文 HTML 与帖子页走同一个渲染件）。
        </p>
      ) : (
        <CommentBody body={draft.html} className='prose prose-sm max-w-none leading-[1.85] text-foreground' />
      )}
    </article>
  );
}

/** 从草稿退出去的两个口（房间内链接一律 ?page=，见 room-links.tsx）。 */
export function BackLinks({ board }: { board: BoardKey | null }) {
  return (
    <span className='flex flex-wrap items-center gap-3 text-[12px]'>
      <a
        href={roomHref('12-topic')}
        className='rounded-[3px] text-muted-foreground outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
      >
        返回帖子页
      </a>
      <a
        href={roomHref('14-home') + (board ? '&board=' + board : '')}
        className='rounded-[3px] text-muted-foreground outline-none hover:text-primary focus-visible:ring-[3px] focus-visible:ring-ring/50'
      >
        去首页信息流看分区
      </a>
    </span>
  );
}
