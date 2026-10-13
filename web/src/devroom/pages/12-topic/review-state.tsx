import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
// ButtonSet 是**默认导出**（命名导出在这个包里不存在，typecheck 会直接报 TS2614）
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import { AlertTriangle, Clock3, Send, ShieldAlert } from 'lucide-react';
import { icon16 } from '@/ui/icons';

// 帖子的审核态体现（作者视角）。来源：完全重构/后端设计/d7-ai-review.md §1 状态机 + 拍板 §10.4。
//
// 三条不能越界的约束（写在代码里，免得后来人加分支）：
//  1. review_state 只有这三个值（migrations/0004 的 ck_topics_review_state）：pending / approved / rejected；
//     **不要**把 visibility(locked/hidden) 混进来当「审核中」——那是另一根轴；
//  2. 非作者根本收不到 pending / rejected 的帖子（后端过滤，d7 §1）。
//     所以这里**没有**「游客看到审核中」这种分支：能渲染出这个横幅，就说明看的人就是作者；
//  3. 判定来源（ai / manual / trusted）**不在帖子页显示**，那是管理视角（拍板 §10.3）。
export type ReviewState = 'pending' | 'approved' | 'rejected';

const TONE: Record<Exclude<ReviewState, 'approved'>, { box: string; icon: string }> = {
  pending: {
    box: 'border-primary/35 bg-primary/8',
    icon: 'text-primary',
  },
  rejected: {
    box: 'border-destructive/45 bg-destructive/8',
    icon: 'text-destructive',
  },
};

export function ReviewStateBanner({
  state,
  note,
  appeal,
  pendingHuman = false,
}: {
  state: ReviewState;
  note?: string | null;
  /** rejected 时的「申请人工复核」按钮：由调用方给，横幅只负责摆位置 */
  appeal?: ReactNode;
  /** 后端 review_pending_human：pending 是否已转人工。**只说「在不在等人」，不暴露谁判的** */
  pendingHuman?: boolean;
}) {
  if (state === 'approved') return null; // 正常帖：什么都不显示
  const tone = TONE[state];
  // 两档文案：AI 在跑就说几十秒，已转人工就别说几十秒（d7 §1 第 3 条：调用失败/拿不准 → 人工队列）
  const pendingTitle = pendingHuman
    ? '这篇正在审核中，已转人工审核，通过后其他人才能看到'
    : '这篇正在审核中，通过后其他人才能看到';
  const pendingNote = pendingHuman
    ? '已转人工审核，通常 1 个工作日内有结果；期间你可以继续编辑。'
    : '正在自动检查，通常几十秒内完成；期间你可以继续编辑。';
  return (
    <section
      aria-label={state === 'pending' ? '审核中' : '未通过审核'}
      className={'flex flex-col gap-1 rounded-lg border px-3 py-2.5 ' + tone.box}
    >
      <span className='flex flex-wrap items-center gap-2'>
        {state === 'pending' ? (
          <Clock3 aria-hidden className={'size-4 shrink-0 ' + tone.icon} />
        ) : (
          <ShieldAlert aria-hidden className={'size-4 shrink-0 ' + tone.icon} />
        )}
        <span
          className={
            'text-[14px] font-semibold ' + (state === 'pending' ? 'text-foreground' : 'text-destructive')
          }
        >
          {state === 'pending' ? pendingTitle : '未通过审核'}
        </span>
      </span>
      {state === 'pending' ? (
        <span className='text-[12px] text-muted-foreground'>{pendingNote}</span>
      ) : (
        <>
          {note ? (
            // 理由是 AI / 管理员写的中文句子，最长可到 varchar(500)、实际常见 100–200 字：
            // **不给单行截断**，整段换行展开（break-words 防长串英文/URL 溢出），行高放宽到 1.7 便于读
            <p className='text-[13px] leading-[1.7] break-words text-foreground'>
              <span className='text-muted-foreground'>审核理由：</span>
              {note}
            </p>
          ) : null}
          <span className='flex flex-wrap items-center gap-x-3 gap-y-2'>
            <span className='text-[12px] text-muted-foreground'>你可以修改后重新提交。</span>
            {appeal ? <span className='ml-auto'>{appeal}</span> : null}
          </span>
        </>
      )}
    </section>
  );
}

// 「申请人工复核」：本轮不做真实交互（后端也还没有对应端点），只给一次点击后的反馈。
// 未登录/非作者不会看到这个横幅，所以按钮不需要额外的权限前置判断。
export function ReviewAppealButton({ onAppeal }: { onAppeal?: () => void }) {
  return (
    <span className='w-fit'>
      <Button
        icon={icon16(AlertTriangle)}
        title='提交后进入人工复核队列，通常 1 个工作日内有结果'
        onClick={onAppeal}
      >
        申请人工复核
      </Button>
    </span>
  );
}

/** 审核态下「这篇只有你能看到」的提示：进度条里也有一个，两处同一种读法 */
export function AuthorOnlyHint() {
  return (
    <p className='flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground'>
      <ShieldAlert aria-hidden className='size-3.5 shrink-0' />
      当前只有你自己（与管理员）能看到这篇；通过审核后才会出现在分区列表里。
    </p>
  );
}

// DevRoom 专用：状态切换控件。真实页面没有它——review_state 是后端给的，不是用户选的。
// 放最上面（页头之上），出图时一眼能看出「下面这一屏是哪一种态」。
export function ReviewStateDemoBar({
  value,
  onChange,
  pendingHuman,
  onPendingHumanChange,
  onAppeal,
  appealNote,
}: {
  value: ReviewState;
  onChange: (v: ReviewState) => void;
  /** review_pending_human 的两档：只在 pending 时出现 */
  pendingHuman: boolean;
  onPendingHumanChange: (v: boolean) => void;
  onAppeal?: () => void;
  appealNote?: string | null;
}) {
  const [appealed, setAppealed] = useState(false);
  const LABEL: Record<ReviewState, string> = {
    pending: '审核中',
    approved: '正常',
    rejected: '未通过',
  };
  return (
    <section
      aria-label='审核态演示'
      className='flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed border-border px-3 py-2'
    >
      <span className='text-[11px] font-medium tracking-wide text-muted-foreground'>
        DevRoom 演示 · 审核态
      </span>
      <ButtonSet>
        {(['pending', 'approved', 'rejected'] as ReviewState[]).map((s) => (
          <Button key={s} active={s === value} onClick={() => onChange(s)}>
            {LABEL[s]}
          </Button>
        ))}
      </ButtonSet>
      {value === 'pending' ? (
        <ButtonSet>
          <Button active={!pendingHuman} onClick={() => onPendingHumanChange(false)}>
            自动检查中
          </Button>
          <Button active={pendingHuman} onClick={() => onPendingHumanChange(true)}>
            已转人工
          </Button>
        </ButtonSet>
      ) : null}
      {value === 'rejected' ? (
        <Button
          icon={icon16(Send)}
          disabled={appealed}
          onClick={() => {
            setAppealed(true);
            onAppeal?.();
          }}
        >
          {appealed ? '已进入人工队列' : '模拟「申请人工复核」'}
        </Button>
      ) : null}
      {appealNote ? (
        <span className='inline-flex items-center gap-1 text-[11px] text-muted-foreground'>
          <Send aria-hidden className='size-3 shrink-0' />
          {appealNote}
        </span>
      ) : null}
      <span className='ml-auto text-[11px] text-muted-foreground'>
        真实页面由后端 review_state 决定，没有这个控件
      </span>
    </section>
  );
}
