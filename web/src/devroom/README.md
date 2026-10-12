# 开发者房间（DevRoom）

**这里逐个验证控件。业务代码只允许使用登记过的控件。**

## 规矩（硬性）

1. 要用一个 Ring UI 控件，**先在这个房间加一页**把它验证掉：
   把它的变体、尺寸、图标、禁用、加载、长文本、深浅色都渲染出来；
2. 出图**并且看图**（`pnpm preview:build` → `pnpm devroom` → 截图），确认没有错位、没有控制台告警；
3. 在 [`registry.ts`](./registry.ts) 里登记：实测可用的 props + 坑；
4. 之后业务代码才能 import。**没登记就 import 会被 `pnpm gate:controls` 挡下**（在 `pnpm check` 里）。

为什么这么严：本项目已经因为「凭记忆猜 API + 直接把 lucide 图标塞进 Ring UI」出过一次按钮与文字错位，
而且是**编译器不会报、测试也测不出**的那类问题（见下方「图标」一节）。

## 页面分类（按「交互类型」分页，不按控件一页一个）

为什么按交互类型分：同一类的控件共享**高度体系、焦点行为、键盘约定**，放一页才能看出它们彼此是否协调；
一个控件一页会让人只记住局部，拼页面时照样出错。

| 页 | 名称 | 放什么 | 状态 |
|---|---|---|---|
| **01** | **交互与表单** | Button、ButtonSet、Input、Select、Dropdown/PopupMenu、Toggle、Checkbox、Radio | ✅ 按钮 + Input 已验证 |
| 02 | 浮层与反馈 | Dialog、Popup、Tooltip、Alert、Confirm、Loader/LoaderInline、ErrorMessage | 待做 |
| 03 | 导航与结构 | Tabs、Breadcrumbs、Pager、Panel、Table、List、ContentLayout | 待做 |
| 04 | 展示与状态 | Tag、Avatar、AvatarStack、ProgressBar、Code、Markdown、骨架/空态/错误态（自建） | 待做 |
| 05 | 我们的组合件 | UserBadge（用户名/等级/头衔/角色）、Markdown 主题、将来的 TopicRow/TopicCard | 待做 |
| 99 | 隔离实验 | [isolate.tsx](./isolate.tsx)：只引 Ring UI、不引 Tailwind 与令牌，用来判断「是库的问题还是我们集成的问题」 | 工具页，长期保留 |

**一页之内的写法**：按场景分区（如「按钮·常见场景」「输入·Input」），每区一句说明 + 密集网格（`xl:grid-cols-4`），
每格 = 小标签 + 一句「为什么」+ 实物。不要再按控件切成一格一行。

**已删除的重复件**：`src/ui/` 里原有 shadcn 版 `button/input/label/field`，与 Ring UI 的控件职责重复（两套并存必然漂移），已全部删除。
`src/ui/` 现在只留 Ring UI **没有**的东西：`user-badge.tsx`（我们的组合件）、`icons.tsx`（lucide 尺寸包装）。
## 已登记的控件

| 控件 | 页面 | 验证日期 | 实测可用的 props |
|---|---|---|---|
| Button | [01-button](./pages/01-button.tsx) | 2026-10-12 | 变体见页面；`height: S\|M\|L`；`icon` / `iconRight`（须 `icon16()` 包装）；`href`；`aria-label` |

## 图标（最容易踩的一条）

Ring UI 的 `icon` prop 按图标的**固有尺寸**排版。lucide 图标默认 24×24，直接传会撑破按钮，
表现就是**图标比文字大、按钮被顶高、基线对不齐**——而且 TypeScript 一声不吭（类型上完全兼容）。

    // ❌ 错：24px 撑破按钮
    <Button icon={Plus}>新建</Button>

    // ✅ 对：统一 16px 固有尺寸
    import { icon16 } from '@/ui/icons';
    <Button icon={icon16(Plus)}>新建</Button>

另外：项目**没有**安装 `@jetbrains/icons`，所以不要用「字串图标名」那种传法。

## 令牌方向（重要）

**唯一真源是 Ring UI 自己的主题**：`src/styles/tokens.css` 只做**别名**，引用 Ring UI 的变量
（`--background: var(--ring-content-background-color)` 这种）。

    ❌ 不要写覆盖 Ring UI 的样式（那是「自己修库」）
    ✅ 只读它的变量，让我们自己的工具类跟随它

**为什么**：曾经反过来做（把 `--ring-*` 覆盖成我们的值），顺手覆盖了 `--ring-unit`（8px→4px），
而 Ring UI 的按钮高度是 `calc(3 * var(--ring-unit))` → 所有控件缩成一半、**文字被挤出按钮**。
更坑的是：TypeScript 不报、测试不测，只有实物截图能发现。

## 图标（两种正确路径）

    // ✅ 首选：官方图标，自带固有尺寸
    import add from '@jetbrains/icons/add-20px';
    <Button icon={add}>新建</Button>

    // ✅ 官方没有的：lucide + icon16() 包装
    import { icon16 } from '@/ui/icons';
    <Button icon={icon16(Plus)}>新建</Button>

    // ❌ 直接传 lucide（24px 撑破按钮）
    <Button icon={Plus}>新建</Button>

## 高度

`height` 只接受 `"S" | "M" | "L"`。**没有 `size` prop**——传了不生效（这一条是踩出来的）。

## 怎么加一页

1. `src/devroom/pages/0N-<控件>.tsx`，默认导出一个页面组件；
2. 在 [`app.tsx`](./app.tsx) 的 `PAGES` 里加一行（key 用 `0N-<控件>`）；
3. 出图：`cd web && pnpm preview:build && pnpm devroom`，然后
   `node scripts/shoot-previews.ts devroom='' ` 或在浏览器打开 `http://127.0.0.1:5202/devroom.html?page=0N-<控件>`；
4. 登记进 `registry.ts`。

## 页面写法约定

- 每一行 = 「左边说明 + 右边实物」，说明里写清**为什么**这么用；
- 关键对照（例如图标三种传法）要把**错的**也画出来并标注 ❌，否则以后没人知道为什么必须包装；
- 页面本身也要遵守 `gate:ui`（不许手写 HTML 控件）。
