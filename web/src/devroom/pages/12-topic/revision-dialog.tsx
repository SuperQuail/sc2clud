import Button from '@jetbrains/ring-ui-built/components/button/button';
import Dialog from '@jetbrains/ring-ui-built/components/dialog/dialog';
import { CommentBody } from '@/ui/comment/comment-body';

// L6：「最后过审版本」的只读弹层。
//
// 为什么是弹层而不是把正文就地换掉：拍板 §L6 要的是「作者看到的是最后一个过审版本」，
// 而打回期间作者**要接着改**——正文区必须留给手上这一版（后端 `TopicDetailDTO.content_md` 给的就是它）。
// 把参照物放在一个随手能关的弹层里，两件事就不打架。
//
// 正文用 `CommentBody`（它内部是 @/ui/markdown）：后端给的是**清洗过的 HTML**，
// 与帖子正文、评论正文走同一条渲染路径（不自己 dangerouslySetInnerHTML）。
export function RevisionDialog({
  revision,
  onClose,
}: {
  /** 后端 `revision_of`：没有就不该调起这个弹层（调用方已经判过） */
  revision: { content_html: string; approved_at: string };
  onClose: () => void;
}) {
  return (
    <Dialog
      show
      modal
      trapFocus
      label='最后过审版本'
      showCloseButton
      onCloseAttempt={onClose}
      onOverlayClick={onClose}
      onEscPress={onClose}
      contentClassName='w-full max-w-[720px] p-5'
    >
      <div className='flex flex-col gap-4'>
        <div className='flex flex-col gap-1'>
          <h2 className='text-base font-semibold text-foreground'>最后过审版本</h2>
          <p className='m-0 text-[12px] leading-relaxed text-muted-foreground'>
            这一版是上一次通过审核时的正文
            {revision.approved_at ? '（通过于 ' + approvedText(revision.approved_at) + '）' : ''}。
            它是只读的参照：现在正文区里是你手上正在改的那一版，改完保存会自动回到「审核中」。
          </p>
        </div>
        <div className='max-h-[52vh] overflow-y-auto rounded-md border border-border bg-background px-3 py-2'>
          <CommentBody body={revision.content_html} className='text-[14px] text-foreground' />
        </div>
        <span className='flex items-center justify-end gap-2'>
          <Button inline={false} onClick={onClose}>
            关闭
          </Button>
        </span>
      </div>
    </Dialog>
  );
}

/** `approved_at` 是 RFC3339；页面上要的是「哪一天」——展示格式与 formatTime 的远日子一档一致。 */
function approvedText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium' }).format(d);
}
