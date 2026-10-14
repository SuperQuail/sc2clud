import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ArrowRight, MessageSquareWarning } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { IssueKindButton } from './_task/issue-kind-button';
import type { IssueKind } from './_task/types';

// 帖子页的「问题反馈」入口。正文末尾与右栏共用同一个控件（以前这类引导各写一份，样式与文案很快就对不上）。
// **为什么四个按钮要长在帖子页上**：绝大多数用户不知道「Issue」是什么（用户 2026-10-12 明确提过），
// 所以不能用「去 Issue 页」这种黑话当唯一入口——四类反馈在这里直接可点，点哪一类就带去反馈页并预设该类型。
// 尺度：正文末尾那处**明显但不喧宾夺主**——虚线容器 + 一行小字 + 四个次要按钮，不用主色块压过正文。
//
// **去哪由宿主给**（href / onOpen 二选一）：
//   href   = 反馈页已经有真地址（房间用 ?page=13-issue；真站接上线后给真路径）；
//   onOpen = 还没有那一页 —— 点一下给一次回执，不留一条 404 的死链（缺陷处理总纲 §7）。
const KINDS: IssueKind[] = ['bug', 'feature', 'difficulty', 'other'];

export function IssueNudge({
  variant = 'inline',
  issueCount,
  href,
  onOpen,
}: {
  /** inline = 正文末尾的一整块；rail = 右栏里的一格 */
  variant?: 'inline' | 'rail';
  issueCount?: number;
  href?: string;
  onOpen?: (kind?: IssueKind) => void;
}) {
  const open = issueCount ?? 0;
  if (variant === 'rail') {
    return (
      <section
        data-testid='issue-nudge-rail'
        className='flex flex-col items-start gap-2 rounded-lg border border-dashed border-border p-4'
      >
        <span className='inline-flex items-center gap-2 text-[13px] font-medium text-foreground'>
          <MessageSquareWarning aria-hidden className='size-4 text-muted-foreground' />
          有问题？告诉我们
        </span>
        <p className='text-[12px] leading-relaxed text-muted-foreground'>
          回复区只聊玩法与设计；卡住、崩溃、难度不合适、想要什么功能，点开反馈页说清楚就行。
          {open > 0 ? '（还有 ' + open + ' 条在处理）' : ''}
        </p>
        <Button href={href} onClick={href ? undefined : () => onOpen?.()} iconRight={icon16(ArrowRight)}>
          去反馈页
        </Button>
      </section>
    );
  }
  return (
    <aside
      data-testid='issue-nudge-inline'
      className='flex flex-col gap-3 rounded-lg border border-dashed border-border px-3 py-3'
    >
      <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
        <MessageSquareWarning aria-hidden className='size-4 shrink-0 text-muted-foreground' />
        <span className='text-[13px] font-medium text-foreground'>遇到问题、想提建议？按一下，作者就能收到</span>
        {open > 0 ? <span className='text-[12px] text-muted-foreground'>· 还有 {open} 条在处理</span> : null}
        {/* 一个控件两种落点：有反馈页就是链接（新窗口/右键复制地址都在），没有就点一次给回执。
            用手写 <button> 会被 lint 挡（规矩：动作一律走登记过的控件）。 */}
        <Button
          ghost
          href={href}
          onClick={href ? undefined : () => onOpen?.()}
          className='ml-auto px-1 text-[12px]'
        >
          看全部反馈
        </Button>
      </div>
      <div className='flex flex-wrap gap-2'>
        {KINDS.map((k) => (
          <IssueKindButton key={k} kind={k} size='md' href={href} onSelect={href ? undefined : onOpen} />
        ))}
      </div>
    </aside>
  );
}
