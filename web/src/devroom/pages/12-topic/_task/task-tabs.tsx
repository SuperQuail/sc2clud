import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { CircleDot, FileText, type LucideIcon } from 'lucide-react';
import { icon16 } from '@/ui/icons';

// 帖子页顶部两个大按钮（照 GitHub 仓库页 Code / Issues 的位置与观感）。
// **数据驱动**：只认 value / onChange / onOpenIssue / issueCount，不认识「帖子」「反馈列表」这些业务。
// 无障碍：Ring UI Button（原生 <button>）自带键盘与焦点环，这里不覆盖它的任何外观与尺寸变量；
//   aria-current 标出当前视图，aria-label 把未关闭计数一起读出来，选中态另有 primary 填充色。
export type TopicTaskTab = 'content' | 'issue';

export type TopicTaskTabsProps = {
  value: TopicTaskTab;
  onChange: (value: TopicTaskTab) => void;
  /** 每次点「Issue」页签都会回调（未选中时先 onChange 再 onOpenIssue）；页面拿它做导航/滚动，不需要就传空函数 */
  onOpenIssue: () => void;
  /** 未关闭的 Issue 数；0 或 undefined 不显示（不显示空药丸） */
  issueCount?: number;
  /** 这个页面做不做「问题反馈」（默认做）。false = 连页签都不画：
   *  讨论帖没有可下载内容，也就没有「问题单」这回事（用户 2026-10-16 拍板）。
   *  显式开关而不是靠「宿主没传回调」来猜 —— 宿主传不传回调是另一件事（D5 的兜底）。 */
  issuesEnabled?: boolean;
};

// 文案不出现「Issue」：面向的是普通玩家，看不懂这个词（用户 2026-10-12 明确提过）。
// 内部 key 仍是 issue（与后端 post_issues 契约对齐），改名只改这张表。
const TABS: Array<{ key: TopicTaskTab; label: string; icon: LucideIcon }> = [
  { key: 'content', label: '帖子内容', icon: FileText },
  { key: 'issue', label: '问题反馈', icon: CircleDot },
];

export function TopicTaskTabs({ value, onChange, onOpenIssue, issueCount, issuesEnabled = true }: TopicTaskTabsProps) {
  function pick(key: TopicTaskTab) {
    if (key !== value) onChange(key);
    // 重复点 Issue 也再喊一次：页面可以把它当「回到 Issue 列表」用
    if (key === 'issue') onOpenIssue();
  }

  // **受控**：value 是唯一真源（真站把它接到 URL 的 ?view=，见 routes/issues.tsx 的 VIEW_PARAM）。
  // 这一层不自己记 state —— 自己记一份就会出现「地址说在反馈页、按钮还高亮着帖子内容」那种分叉。

  return (
    <nav
      data-testid='topic-tabs'
      aria-label='帖子页视图'
      className='flex flex-wrap items-center gap-2 border-b border-border pb-2'
    >
      {TABS.filter(({ key }) => key !== 'issue' || issuesEnabled).map(({ key, label, icon }) => {
        const selected = key === value;
        const count = key === 'issue' && issueCount ? issueCount : 0;
        return (
          <Button
            key={key}
            data-testid={'topic-tab-' + key}
            height={ControlsHeight.L}
            // 必须显式写 inline={false}：Ring UI 只要看到 icon 就把按钮按 inline（链接样式）排，
            // 顺带把 primary 也吃掉（button.js: isInline = inline ?? text ?? !!icon；primaryBlock = primary && !inline）。
            // 实测：不写这一行，两个页签会渲染成没有边框、没有填充的蓝字链接，选中态完全看不出来。
            inline={false}
            primary={selected}
            icon={icon16(icon)}
            onClick={() => pick(key)}
            aria-current={selected ? 'page' : undefined}
            aria-label={count > 0 ? label + '（' + count + ' 条还没处理）' : label}
          >
            <span className='inline-flex items-center gap-1.5'>
              {label}
              {count > 0 ? (
                <span
                  className={
                    'rounded-full px-1.5 text-[11px] leading-4 tabular-nums ' +
                    (selected ? 'bg-primary-foreground/20 text-primary-foreground' : 'bg-muted text-muted-foreground')
                  }
                >
                  {count}
                </span>
              ) : null}
            </span>
          </Button>
        );
      })}
    </nav>
  );
}
