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
  {
    name: 'toggle',
    path: '@jetbrains/ring-ui-built/components/toggle/toggle',
    page: '01-interactive',
    verifiedOn: '2026-10-12',
    props: ['checked + onChange（受控；onChange 收事件 e => setX(e.target.checked)）', '标签用 children；另有 leftLabel / help', 'disabled', 'size（控件默认值）'],
    notes: ['紧凑型开关，适合发帖页/设置页这类密集表单。'],
  },
  {
    name: 'select',
    path: '@jetbrains/ring-ui-built/components/select/select',
    page: '01-interactive',
    verifiedOn: '2026-10-12',
    props: [
      'type：Type.INPUT（输入框外观，表单里用）/ BUTTON / INLINE / CUSTOM',
      'data：条目数组 [{ key, label }]；**selected 要传条目对象，不是 key**（传字符串会把泛型 T 推断成 string，类型直接报错）',
      'onSelect(item)：item 可能为 null，要判空',
      'label / filter / multiple 等按需',
    ],
    notes: ['A 系表单里的下拉用它；B 系用 src/ui/vivid/select（VividSelect）。'],
  },
  { name: 'dialog', path: '@jetbrains/ring-ui-built/components/dialog/dialog', page: '02-overlay', verifiedOn: '2026-10-12',
    props: ['show（受控）', 'label：必填，作为无障碍标题', 'onCloseAttempt / onOverlayClick / onEscPress', 'modal / trapFocus / dense / showCloseButton'],
    notes: ['遮罩点击、Esc、焦点陷阱都由控件负责，不要自己写弹层。'] },
  { name: 'tooltip', path: '@jetbrains/ring-ui-built/components/tooltip/tooltip', page: '02-overlay', verifiedOn: '2026-10-12',
    props: ['title（内容）', 'long：允许长文本换行', 'delay', 'hide', 'selfOverflowOnly'], notes: [] },
  { name: 'error-message', path: '@jetbrains/ring-ui-built/components/error-message/error-message', page: '02-overlay', verifiedOn: '2026-10-12',
    props: ['code / message / description', 'icon：须 icon16() 包装'], notes: ['页面级错误用它，不要自己拼红字。'] },
  { name: 'loader-inline', path: '@jetbrains/ring-ui-built/components/loader-inline/loader-inline', page: '02-overlay', verifiedOn: '2026-10-12',
    props: ['无独立 props（行内加载）'], notes: ['局部加载用它；整页加载用 LoaderScreen。'] },
  { name: 'checkbox', path: '@jetbrains/ring-ui-built/components/checkbox/checkbox', page: '01-interactive', verifiedOn: '2026-10-12',
    props: ['label / help（标签与说明用控件自己的属性，不要外面拼 label）', 'checked + onChange（收事件）', 'disabled / indeterminate'], notes: [] },
  { name: 'radio', path: '@jetbrains/ring-ui-built/components/radio/radio', page: '01-interactive', verifiedOn: '2026-10-12',
    props: ['同一 name 互斥', 'checked + onChange', 'children 作为标签'], notes: [] },
  { name: 'button-set', path: '@jetbrains/ring-ui-built/components/button-set/button-set', page: '01-interactive', verifiedOn: '2026-10-12',
    props: ['无自有 props：包住一组 Button 即可'], notes: ['连在一起的一组动作（全部/精华/待回复）。'] },
  { name: 'dropdown-menu', path: '@jetbrains/ring-ui-built/components/dropdown-menu/dropdown-menu', page: '01-interactive', verifiedOn: '2026-10-12',
    props: ['anchor：触发元素', 'data：[{ key, label }]', 'onSelect(item)', 'menuProps / children 函数形式'],
    notes: ['定位、点外部关闭、Esc、键盘导航都由它负责——不要自己写浮层。'] },
];
