// 开发者房间的控件登记表 —— **唯一真源**。
// 规矩：没在这里登记过的 Ring UI 控件，禁止在业务代码里 import。
// 门禁：scripts/check-controls.ts（在 pnpm check 里）扫描 src/**（devroom 与 src/ui 除外）。
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
    page: '01-interactive',
    verifiedOn: '2026-10-12',
    props: [
      '变体：primary / danger / success / error / ghost / transparent / inline / short / active / loader / dropdown / disabled',
      'height：ControlsHeight.S | M | L（没有 size prop）',
      'icon / iconRight：官方 @jetbrains/icons 直接传；lucide 必须 icon16() 包装',
      'href：渲染成链接（导航用它）',
      'aria-label：仅图标按钮必填',
    ],
    notes: [
      '不许覆盖 Ring UI 的尺寸变量：曾覆盖 --ring-unit（8→4px），按钮高度是 calc(3 * var(--ring-unit))，所有控件缩一半、文字被挤出按钮。',
    ],
  },
  {
    name: 'input',
    path: '@jetbrains/ring-ui-built/components/input/input',
    page: '01-interactive',
    verifiedOn: '2026-10-12',
    props: [
      'label / error / help：控件自带，不要在外面拼标签与错误行',
      'icon（官方图标）/ multiline / disabled / height（ControlsHeight）',
      '受控用 value + onChange，非受控用 defaultValue',
    ],
    notes: [
      '错误文案来自服务端 error.fields，直接喂 error prop。',
      '原来的 field.tsx / label.tsx / input.tsx 已删除——重复了控件自带的能力。',
    ],
  },
  {
    name: 'tag',
    path: '@jetbrains/ring-ui-built/components/tag/tag',
    page: '07-user-render',
    verifiedOn: '2026-10-12',
    props: [
      'tagType：TagType.DEFAULT | MAIN | SUCCESS | WARNING | ERROR | PURPLE（预设色，自带半透明底）',
      'textColor / backgroundColor：直接传色值（backgroundColor 可传 color-mix 做半透明）',
      'outline：改为描边样式；readOnly / interactive / onClick',
      'rgTagTitle：悬停提示',
    ],
    notes: ['它是 Ring UI 里唯一能做「带色半透明小标签」的现成控件，权限徽标优先用它。'],
  },
];
