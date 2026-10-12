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
  { name: 'tabs', path: '@jetbrains/ring-ui-built/components/tabs/tabs', page: '03-navigation', verifiedOn: '2026-10-12',
    props: ['**命名导出**：import { Tab, Tabs } from .../tabs/tabs（没有 default）', 'Tabs: selected + onSelect(id)（没有 onChange）', 'Tab: id / title / disabled / href（没有 selected）'], notes: [] },
  { name: 'breadcrumbs', path: '@jetbrains/ring-ui-built/components/breadcrumbs/breadcrumbs', page: '03-navigation', verifiedOn: '2026-10-12',
    props: ['children 为链接与文本'], notes: ['URL 必须走 appPath。'] },
  { name: 'pager', path: '@jetbrains/ring-ui-built/components/pager/pager', page: '03-navigation', verifiedOn: '2026-10-12',
    props: ['total / currentPage / pageSize', 'onPageChange / onPageSizeChange', 'pageSizes / visiblePagesLimit / disablePageSizeSelector'], notes: ['**默认是英文**（Previous / Next page / Last page / N per page）：中文界面必须传 perPage / firstPage / lastPage / nextPage / previousPage 这些文案。'] },
  { name: 'panel', path: '@jetbrains/ring-ui-built/components/panel/panel', page: '03-navigation', verifiedOn: '2026-10-12', props: ['无自有 props（无内边距容器）'], notes: [] },
  { name: 'island', path: '@jetbrains/ring-ui-built/components/island/island', page: '03-navigation', verifiedOn: '2026-10-12', props: ['narrow / withoutPaddings'], notes: [] },
  { name: 'avatar', path: '@jetbrains/ring-ui-built/components/avatar/avatar', page: '04-display', verifiedOn: '2026-10-12',
    props: ['size（数字或 Size 枚举）', 'url / username（无图时显示首字）', 'round / subavatar / info'], notes: ['**不要用它渲染用户头像**：它是给项目/组织用的色块首字。用户头像一律用 src/ui/user/avatar（UserAvatar）。'] },
  { name: 'avatar-stack', path: '@jetbrains/ring-ui-built/components/avatar-stack/avatar-stack', page: '04-display', verifiedOn: '2026-10-12', props: ['size + 子 Avatar'], notes: ['同上：项目/组织场景才用；用户「当前在线」这类排布请用 UserAvatar 重叠排。'] },
  { name: 'progress-bar', path: '@jetbrains/ring-ui-built/components/progress-bar/progress-bar', page: '04-display', verifiedOn: '2026-10-12', props: ['value / max / staticColor / global'], notes: ['不要自己拼 div 宽度当进度条。'] },
  { name: 'code', path: '@jetbrains/ring-ui-built/components/code/code', page: '04-display', verifiedOn: '2026-10-12', props: ['code / inline / language / softWrap'], notes: [] },
  { name: 'app-pager', path: '@/ui/pager', page: '03-navigation', verifiedOn: '2026-10-12',
    props: ['total / currentPage / pageSize / onPageChange / onPageSizeChange', 'pageSizes（默认 20/50/100）', 'showTotal（默认开）', 'labels：覆盖中文文案'],
    notes: ['**不要直接用 Ring 的 Pager**：它默认英文文案（Previous/Next page/Last page/N per page），中文界面会漏。'] },
  { name: 'count-badge', path: '@/ui/message/count-badge', page: '10-messages', verifiedOn: '2026-10-12', props: ['见组件注释：全部为数据驱动的通用 props'], notes: ['数字角标（展示件，非交互）'] },
  { name: 'notice-nav', path: '@/ui/message/notice-nav', page: '10-messages', verifiedOn: '2026-10-12', props: ['见组件注释：全部为数据驱动的通用 props'], notes: ['竖排导航：items/value/onChange，行用 Ring Button'] },
  { name: 'notice-row', path: '@/ui/message/notice-row', page: '10-messages', verifiedOn: '2026-10-12', props: ['见组件注释：全部为数据驱动的通用 props'], notes: ['一行通知：actors/action/body/excerpt/time/actions'] },
  { name: 'notice-list', path: '@/ui/message/notice-list', page: '10-messages', verifiedOn: '2026-10-12', props: ['见组件注释：全部为数据驱动的通用 props'], notes: ['列表容器：title/hint/empty/children'] },
  { name: 'notice-chat', path: '@/ui/message/notice-chat', page: '10-messages', verifiedOn: '2026-10-12', props: ['见组件注释：全部为数据驱动的通用 props'], notes: ['会话气泡：messages + children（输入区）'] },
  { name: 'notice-composer', path: '@/ui/message/notice-composer', page: '10-messages', verifiedOn: '2026-10-12', props: ['见组件注释：全部为数据驱动的通用 props'], notes: ['输入区：复用 MarkdownEditor(compact) + Ring Button'] },
  { name: 'notice-settings', path: '@/ui/message/notice-settings', page: '10-messages', verifiedOn: '2026-10-12', props: ['见组件注释：全部为数据驱动的通用 props'], notes: ['设置面板：模式驱动的 rows（radio/toggle/tags）'] },
  { name: 'notice-layout', path: '@/ui/message/notice-layout', page: '10-messages', verifiedOn: '2026-10-12', props: ['见组件注释：全部为数据驱动的通用 props'], notes: ['两栏骨架：nav + children'] },
];
