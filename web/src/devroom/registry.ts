// 开发者房间的控件登记表 —— **唯一真源**。
// 规矩：没在这里登记过的 Ring UI 控件，禁止在业务代码里 import。
// 门禁：scripts/check-controls.ts（在 pnpm check 里）扫描 src/**（devroom 与 src/ui 除外），
//       发现未登记控件直接失败。要新增控件 → 先在 devroom 建一页验证 → 再登记。
export type VerifiedControl = {
  name: string;
  path: string;
  page: string;
  verifiedOn: string;
  props: string[];
  notes: string[];
};

export const VERIFIED: VerifiedControl[] = [
  {
    name: 'button',
    path: '@jetbrains/ring-ui-built/components/button/button',
    page: '01-button',
    verifiedOn: '2026-10-12',
    props: [
      'primary / danger / success / error / ghost / transparent / inline / short / active / loader / dropdown / disabled',
      'height: S | M | L',
      'icon / iconRight：必须用 icon16(lucideIcon) 包装后的组件',
      'href 渲染成链接（语义正确的导航）',
      'aria-label（仅图标按钮必填）',
    ],
    notes: [
      'height 用 ControlsHeight.S / M / L 枚举；没有 size 这个 prop。',
      '图标：优先用官方 @jetbrains/icons（自带固有尺寸，直接传）；lucide 必须 icon16() 包装（默认 24px 会撑破按钮）。',
      '仅图标按钮必须给 aria-label；导航用 href 而不是 onClick+location。',
      '【不许覆盖 Ring UI 的尺寸变量】曾经覆盖 --ring-unit（8px→4px），按钮高度是 calc(3 * var(--ring-unit))，结果所有控件缩成一半、文字被挤出按钮。',
    ],
  },
];
