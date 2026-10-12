import Button from '@jetbrains/ring-ui-built/components/button/button';
import { ControlsHeight } from '@jetbrains/ring-ui-built/components/global/controls-height';
import { ISSUE_KIND_ACCENT, ISSUE_KIND_ICON } from './kind-style';
import { ISSUE_KIND_META, type IssueKind } from './types';

// 四类反馈入口：一键开一类反馈（GitHub 的「New issue」模板选择那一步）。
// 文案面向普通玩家，界面上不出现「Issue」这个词（用户 2026-10-12 明确提过）。
// **数据驱动**：颜色与图标来自 kind-style（唯一真源），文案来自 ISSUE_KIND_META；按钮不认识业务。
// 无障碍：Ring UI Button = 原生 <button>，键盘可达、焦点环由控件负责，这里不覆盖它的外观与尺寸变量；
//   title 与 aria-label 是同一份完整说明（"报个 Bug：…"），鼠标/键盘/读屏拿到一样的信息。
export type IssueKindButtonSize = 'sm' | 'md' | 'lg';

export type IssueKindButtonProps = {
  kind: IssueKind;
  /** 点击回调（开面板用）；不传 = 纯展示（渲染出来但不可点） */
  onSelect?: (kind: IssueKind) => void;
  /** 导航用：传了就是链接（可新窗口打开、可右键复制地址），此时不要同时传 onSelect */
  href?: string;
  size?: IssueKindButtonSize;
};

const HEIGHT = { sm: ControlsHeight.S, md: ControlsHeight.M, lg: ControlsHeight.L } as const;

export function IssueKindButton({ kind, onSelect, href, size = 'md' }: IssueKindButtonProps) {
  const meta = ISSUE_KIND_META[kind];
  const Icon = ISSUE_KIND_ICON[kind];
  return (
    <Button
      height={HEIGHT[size]}
      className={ISSUE_KIND_ACCENT[kind]}
      href={href}
      onClick={!href && onSelect ? () => onSelect(kind) : undefined}
      title={meta.label + '：' + meta.description}
      aria-label={meta.label + '：' + meta.description}
    >
      <span className='inline-flex items-center gap-2'>
        <span className='grid size-5 shrink-0 place-items-center rounded-full bg-[color:color-mix(in_srgb,var(--k)_18%,transparent)] text-(--k)'>
          <Icon size={14} aria-hidden />
        </span>
        <span className='font-medium text-(--k)'>{meta.label}</span>
      </span>
    </Button>
  );
}
