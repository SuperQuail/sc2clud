import { useState, type ReactNode } from 'react';
import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
// ButtonSet 是**默认导出**（命名导出在这个包里不存在，typecheck 会直接报 TS2614）
import ButtonSet from '@jetbrains/ring-ui-built/components/button-set/button-set';
import { AlertTriangle, Clock3, History, Send, ShieldAlert } from 'lucide-react';
import { icon16 } from '@/ui/icons';
import { DesignActionNote } from './design-action';

// 帖子的审核态体现（作者视角）。来源：完全重构/后端设计/d7-ai-review.md §1 状态机 + 拍板 §10.4。
//
// 三条不能越界的约束（写在代码里，免得后来人加分支）：
//  1. review_state 只有这三个值（migrations/0004 的 ck_topics_review_state）：pending / approved / rejected；
//     **不要**把 visibility(locked/hidden) 混进来当「审核中」——那是另一根轴；
//  2. 非作者根本收不到 pending / rejected 的帖子（后端过滤，d7 §1）。
//     所以这里**没有**「游客看到审核中」这种分支：能渲染出这个横幅，就说明看的人就是作者；
//  3. 判定来源（ai / manual / trusted）**不在帖子页显示**，那是管理视角（拍板 §10.3）。
export type ReviewState = 'pending' | 'approved' | 'rejected' | 'revision_requested';

// 四档的配色：打回修改用**琥珀**（不是 rejected 的红）——
// 拍板 §L6 要求的正是「改改就能过」与「直接拒绝」在作者眼里必须不同，颜色是最快的那一层区分。
const TONE: Record<Exclude<ReviewState, 'approved'>, { box: string; icon: string }> = {
  pending: {
    box: 'border-primary/35 bg-primary/8',
    icon: 'text-primary',
  },
  rejected: {
    box: 'border-destructive/45 bg-destructive/8',
    icon: 'text-destructive',
  },
  // 打回修改用 primary（蓝），与 pending 同一套色、与 rejected 的红分开：
  // ① 语义上它确实是「还要再走一轮审核」，不是被拒；② tokens.css 里**没有** warning/amber 那一档，
  // 而 gate:tokens 不许写死颜色 —— 所以这里只用已有令牌，靠**文案与图标**把两档彻底分开。
  revision_requested: {
    box: 'border-primary/45 bg-primary/10',
    icon: 'text-primary',
  },
};

export function ReviewStateBanner({
  state,
  note,
  appeal,
  resubmit,
  pendingHuman = false,
  resubmitted = false,
  revisionView,
}: {
  state: ReviewState;
  note?: string | null;
  /** rejected 时的「申请人工复核」按钮：由调用方给，横幅只负责摆位置 */
  appeal?: ReactNode;
  /** rejected 时的「重新提交审核」按钮：与下面那句「改完可以重新提交」成对出现 */
  resubmit?: ReactNode;
  /** 后端 review_pending_human：pending 是否已转人工。**只说「在不在等人」，不暴露谁判的** */
  pendingHuman?: boolean;
  /**
   * L7：**这一次 pending 是作者改完正文之后重提上来的**（不是首次投稿），由宿主给。
   * 为什么需要它：两种 pending 在 `review_state` 里是同一个值，而作者改完正文最想知道的恰恰是
   * 「我的改动到底有没有送去重审」—— 没有这一档，界面只回一句「正在审核中」，与首次投稿无法区分。
   */
  resubmitted?: boolean;
  /** L6：打回修改时「看最后一个过审版本」的入口（内容由宿主给，横幅只摆位置） */
  revisionView?: ReactNode;
}) {
  if (state === 'approved') return null; // 正常帖：什么都不显示
  const tone = TONE[state];
  // 三档文案：重提 > 已转人工 > 自动检查。重提优先，因为它是**作者刚做过的动作**的结果；
  // 「已转人工」与「几十秒」都是对「谁在判」的描述（d7 §1 第 3 条：调用失败/拿不准 → 人工队列）。
  const pendingTitle = resubmitted
    ? '已重新提交复审，通过后其他人才能看到'
    : pendingHuman
      ? '这篇正在审核中，已转人工审核，通过后其他人才能看到'
      : '这篇正在审核中，通过后其他人才能看到';
  const pendingNote = resubmitted
    ? '正文改动已送回审核队列（服务端把审核态从「未通过」打回了「审核中」）；等结果出来之前你可以继续编辑。'
    : pendingHuman
      ? '已转人工审核，通常 1 个工作日内有结果；期间你可以继续编辑。'
      : '正在自动检查，通常几十秒内完成；期间你可以继续编辑。';
  return (
    <section
      data-testid='review-banner'
      data-state={state}
      // 出图/断言用：resubmitted 是**同一 state 下的另一档**，只靠 data-state 分不出来
      data-resubmitted={state === 'pending' && resubmitted ? '1' : undefined}
      aria-label={state === 'pending' ? '审核中' : state === 'revision_requested' ? '需要修改' : '未通过审核'}
      className={'flex flex-col gap-1 rounded-lg border px-3 py-2.5 ' + tone.box}
    >
      <span className='flex flex-wrap items-center gap-2'>
        {/* 打回修改用 Clock3（还要再走一轮），不是 ShieldAlert（被挡下了）——
            图标与配色一起把「改改就能过」与「直接拒绝」分开（拍板 §L6 要的正是这个心理预期差别）。 */}
        {state === 'rejected' ? (
          <ShieldAlert aria-hidden className={'size-4 shrink-0 ' + tone.icon} />
        ) : (
          <Clock3 aria-hidden className={'size-4 shrink-0 ' + tone.icon} />
        )}
        <span
          className={
            'text-[14px] font-semibold ' + (state === 'rejected' ? 'text-destructive' : 'text-foreground')
          }
        >
          {state === 'pending' ? pendingTitle : state === 'revision_requested' ? '需要修改后再审' : '未通过审核'}
        </span>
      </span>
      {state === 'pending' ? (
        <span className='text-[12px] text-muted-foreground'>{pendingNote}</span>
      ) : (
        <>
          {state === 'revision_requested' ? (
            // 打回修改不是「拒绝」：说清「按意见改一版就能重新进队列」，并把上一次过审的内容放到手边 ——
            // 作者改坏之后唯一的参照就是它（拍板 §L6：原始版本已过审时显示它）。
            <span className='text-[12px] leading-relaxed text-muted-foreground'>
              这篇不是被拒绝：按下面的审核意见改一版，会重新进入审核队列；通过之前只有你自己能看到。
            </span>
          ) : null}
          {note ? (
            // 理由是 AI / 管理员写的中文句子，最长可到 varchar(500)、实际常见 100–200 字：
            // **不给单行截断**，整段换行展开（break-words 防长串英文/URL 溢出），行高放宽到 1.7 便于读
            <p className='text-[13px] leading-[1.7] break-words text-foreground'>
              <span className='text-muted-foreground'>审核理由：</span>
              {note}
            </p>
          ) : null}
          <span className='flex flex-wrap items-center gap-x-3 gap-y-2'>
            {/* 这句话原本是个**空头承诺**（盲审二号 13）：说「可以修改后重新提交」，界面上却没有修改入口。
                现在两件事都落地：动作条上的「编辑」（post.update_own）负责改，这里的按钮负责重新提交。 */}
            <span className='text-[12px] text-muted-foreground'>
              {state === 'revision_requested'
                ? '点动作条上的「编辑」改标题与正文，存完就自动回到「审核中」（不需要另点一次提交）。'
                : '改完可以重新提交：点动作条上的「编辑」改标题与正文，存完回来点右边的「重新提交审核」。'}
            </span>
            {revisionView}
            {resubmit ? <span className='ml-auto'>{resubmit}</span> : null}
            {appeal ? <span className={resubmit ? '' : 'ml-auto'}>{appeal}</span> : null}
          </span>
        </>
      )}
    </section>
  );
}

/**
 * L6：打回修改时的「查看最后过审版本」入口。
 * 为什么它是这个功能的**必要**一半：打回期间正文就是作者手上改的那一版，
 * 而「原始版本已过审就显示它」这句话如果没有入口，作者就只能靠自己回忆上次写了什么。
 */
export function ReviewRevisionButton({ onOpen }: { onOpen?: () => void }) {
  return (
    <Button
      inline={false}
      height={ControlsHeight.S}
      icon={icon16(History)}
      data-testid='topic-revision-view'
      onClick={onOpen}
    >
      查看最后过审版本
    </Button>
  );
}

// 「申请人工复核」：本轮不做真实交互（后端也还没有对应端点），只给一次点击后的反馈。
// 未登录/非作者不会看到这个横幅，所以按钮不需要额外的权限前置判断。
export function ReviewAppealButton({ onAppeal }: { onAppeal?: () => void }) {
  return (
    <span className='w-fit'>
      <Button
        inline={false}
        height={ControlsHeight.S}
        icon={icon16(AlertTriangle)}
        title='提交后进入人工复核队列，通常 1 个工作日内有结果'
        onClick={onAppeal}
      >
        申请人工复核
      </Button>
    </span>
  );
}

// 「重新提交审核」：改完（或选择不改）把帖子送回审核队列，横幅自己从「未通过」换成「审核中」。
// 与「申请人工复核」是**两条路**：这一条是改完重走自动检查，那一条是叫人来判。
export function ReviewResubmitButton({ onResubmit }: { onResubmit?: () => void }) {
  return (
    <span className='w-fit'>
      <Button
        inline={false}
        height={ControlsHeight.S}
        primary
        icon={icon16(Send)}
        title='重新提交后回到「审核中」，通过后其他人才能看到'
        data-testid='topic-resubmit'
        onClick={onResubmit}
      >
        重新提交审核
      </Button>
    </span>
  );
}

/** 审核态下「这篇只有你能看到」的提示：进度条里也有一个，两处同一种读法 */
export function AuthorOnlyHint() {
  return (
    <p
      data-testid='author-only-hint'
      className='flex flex-wrap items-center gap-1.5 text-[12px] text-muted-foreground'
    >
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
  onDesignAction,
}: {
  value: ReviewState;
  onChange: (v: ReviewState) => void;
  /** review_pending_human 的两档：只在 pending 时出现 */
  pendingHuman: boolean;
  onPendingHumanChange: (v: boolean) => void;
  onAppeal?: () => void;
  appealNote?: string | null;
  /** 设计稿按钮被点时通知页面（页面把它记进同一个回执行，免得两处各说一套） */
  onDesignAction?: () => void;
}) {
  const [appealed, setAppealed] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const LABEL: Record<ReviewState, string> = {
    pending: '审核中',
    approved: '正常',
    rejected: '未通过',
    revision_requested: '打回修改',
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
        {(['pending', 'approved', 'rejected', 'revision_requested'] as ReviewState[]).map((s) => (
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
          inline={false}
          height={ControlsHeight.S}
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
      {/* 这一条就是「设计稿按钮」的统一说法（其它页也照这个形式做）：
          点了原地出现一行 role=status 的文案，不做 toast、不做弹层。 */}
      <Button
        inline={false}
        height={ControlsHeight.S}
        icon={icon16(Send)}
        data-testid='design-action'
        onClick={() => {
          setRevealed(true);
          onDesignAction?.();
        }}
      >
        一个还没接线的按钮（设计稿）
      </Button>
      {revealed ? <DesignActionNote /> : null}
      <span className='ml-auto text-[11px] text-muted-foreground'>
        真实页面由后端 review_state 决定，没有这个控件
      </span>
    </section>
  );
}
