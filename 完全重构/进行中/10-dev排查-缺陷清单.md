# 10 · dev 排查缺陷清单（2026-10-14 用户实测）

> 用户在 http://191.40.41.97/dev/ 上逐页点出来的问题。**每条给：现象 / 我判定的根因（标「待核」的是我推的，不是实测）/ 验收标准 / 归属**。
> 部署版本 `ea70667`（本轮设计对齐全部合并后的版本）。

## 0. 方法要求（**这一轮所有前端改动都必须遵守**）

用户原话：「**涉及前端变更，先改 devroom，并修改 devroom 写法，保证可以直接快捷应用到实际网站，保证同源，两个地方看同一个页面完全一样**」。

落到执行上只有一条形状 —— **页面 = prop 驱动的 View + 极薄宿主**：

| | 放哪 | 谁渲染 |
|---|---|---|
| **View**（版面、文案、交互、三态） | `web/src/devroom/pages/<页>` 里的 `xxx-view.tsx`，**只吃 props、不 fetch、不认路由** | DevRoom 页 + 产品路由**同一个组件** |
| **宿主**（取数、URL、权限、mutation） | `web/src/routes/xxx.tsx` | 只负责把数据与回调喂给 View |

**判据（可机器检查的）**：产品路由里**不许再出现版面代码**（flex/grid/间距/字号这类 class 只应出现在 View 里）。
改动流程固定为：**① 改 View → ② 在 DevRoom 页出图确认 → ③ 产品宿主跟着改（只改传参）→ ④ 产品页出图对照**。
两个入口看同一页必须**逐像素一致**（除数据不同）。

**§0.1 硬约束：View 里不许 `import` react-router**（FIX-IMG 2026-10-14 实测）。
DevRoom **不在 `RouterProvider` 里**，View 一旦 import react-router（`useNavigate` / `Link` / `useSearchParams`）
就在房间里整块抛 `Cannot destructure property 'basename' of 's.useContext(...)'` —— 而产品页正常，
所以这类错误**只在房间暴露**（这正是"先在房间改"的价值）。
**写法**：View 只收「链接注入器」这类纯 prop，落地件由宿主给 ——

```tsx
type LinkLike = (p: { href: string; children: ReactNode; className?: string }) => ReactNode;
// View：<LinkLike href={...} />，缺省实现是普通 <a>
// 宿主（产品）：link={(p) => <Link to={...} {...p} />}
```

已按这条落地的先例：`03-navigation/board-rail.tsx` 的 `link`、`10-messages/notice-center-view` 的同类注入。

**违反这条的典型**（本轮要顺手收掉的）：`routes/topic.tsx` 546 行里混着版面、`routes/issues.tsx` 540 行同理；
反例（做得对的）：`routes/topic.tsx` 的正文区、`10-messages` 的 `MessagesPanel`、`14-home` 的卡片族。

---

## 1. 缺陷清单

### 图片与上传

| # | 现象 | 根因（待核 = 我推的） | 验收标准 |
|---|---|---|---|
| **D1** | 收款码选 1.3MB 的图：**直接拒绝**，且**同一句提示出现两次** | 待核：① 收款码的限额走的是 `maxSize`（0.5MB）而**没走压缩通道**（`image-pipeline` 的 compress/目标字节没接）；② 重复提示 = `image-uploader` 内部 `error` 与宿主 `onError` **各渲染了一次** | 1.3MB 的图**自动压缩后加进来**（不再直接拒）；任何提示**只出现一次**；断言两条 + 出图 |
| **D2** ✅已修 | 个人主页头像能加载，**顶栏右上角头像裂图** | **实测确认（不是渲染问题）**：两条 URL 来源不同 —— 主页走 `user.Profile.Avatar`（media 的 `urlOf()` 拼 `/img/<hash>`），而 `GET /me` 直接下发**裸 64 位 hash**（`auth/account.go:507-508`），前端补 base 后变成 `/dev/<hash>` → 404。`shell.tsx` 不需要改。 | 已修：**后端** `auth.Deps` 加 `AvatarURL` 端口并用它（与 user 域同一份 media 实现 + 默认头像池回落）；**前端** `fetchMe` 对裸哈希也兜成 `img/<hash>`。契约断言（`auth.test.ts`）7/7 绿 |
| **D3** 渲染✅/数据❌ | 左侧分区列表**没有任何图片**；**非分区页面完全没有图片** | **口径已更正（FIX-IMG 实测，与我原来的推断相反）**：`GET /dev/api/v1/boards` 五个分区 `cover_hash` 全空，但「`数据迁移审计.md:504-513`」写着老站 `section_covers` **0 行**、`legacy-migration.sql` 的 boards INSERT 也没有该列 ⇒ **没有可回填的老数据，不是迁移漏了**。渲染侧已完成：`BoardRail` 拆成 View（`03-navigation/board-rail.tsx`，含封面位 + 首字兜底）+ 极薄宿主。 | 渲染已达标（无数据时是稳定占位、不是空白）。**要真封面只有一个办法（运维/管理动作）**：管理端「分区管理 → 换封面」逐区上传一次（链路已通：`POST /me/cover` → `PATCH /admin/boards/{id}`），素材在 `web/public/art/starcraft/nav-*.webp`。**不做也能上线** |

### 帖子内容页 / Issue

| # | 现象 | 根因（待核 = 我推的） | 验收标准 |
|---|---|---|---|
| **D4** | 「下载来源」块**太大、位置在正文下面**；点它**当前页跳转** | 待核：块在正文之后渲染，且用了大卡片；链接是站内 `<a>` 没有 `target=_blank` | 移到**正文上方**、紧凑一行（图标+名称+提取码，高度约一行）；`target=_blank rel=noopener` |
| **D5** | 点「问题反馈」页签**不切换**，仍停在帖子内容页 | 待核：`TopicTaskTabs` 的 `onOpenIssue` 在真站没接成导航（B2 只接了四个 kind 的 href，页签本身漏了） | 点页签真的切到该帖的反馈视图（或导航到 `/issues?topic=`）；断言 + 出图 |
| **D6** | Issue 详情**正文位置显示 Lexical JSON 原文** | 待核：Issue 的正文是 `body_md`（Lexical JSON），前端当纯文本渲染了；应渲染 `body_html`（列表 DTO 有没有 body_html 要核 `forum/internal/forum/dto.go`） | 正文正常渲染（不是 JSON）；断言「页面里不出现 `"root"`」 |
| **D7** | 新建反馈是**弹窗**，用户要求是**issue 页内的完整界面** | `new-issue-dialog.tsx` 是 Dialog | 改成页面内的表单区（不再是弹层）；保留原来的校验与提交 |
| **D8** | 帖子里**两个发帖者都点不进主页**（作者名/头像不可点）→ **导致私信等功能完全没法测** | 待核：帖子页的作者区与右栏作者卡都没给 `href`（`/u/<handle>`） | 作者名 + 头像都可点进 `/u/<handle>`（新标签页可选）；断言 + 出图 |
| **D9** | 右栏作者卡里「关注」按钮被徽章压住（截图里能看到重影） | 待核：绝对定位/叠层顺序 | 不重叠；出图 |

### 消息中心 / 搜索

| # | 现象 | 根因（待核 = 我推的） | 验收标准 |
|---|---|---|---|
| **D10** | 消息中心：点导航**URL 变了但选中态不变、右侧面板也不换** | 待核：`NoticeNav` 的 `value` 绑的是本地 state，而点击改的是 URL（或反之）——**两套真源** | 点哪一档：选中态、URL、右侧面板**三者同时变**；断言三处一致 |
| **D11** | 点顶栏「搜索」**跳回主页**；用户期望**在当前页顶部出搜索栏** | 现在 `/search` 是 `Navigate to '/'`，顶栏那颗只是链接 | 点搜索后**不换页/不跳走**：顶部就地展开搜索栏并聚焦；（首页内嵌搜索保持不变） |

### 后台 / DevRoom 入口

| # | 现象 | 根因（待核 = 我推的） | 验收标准 |
|---|---|---|---|
| **D12** | 管理页「AI 审核」里点**连通性测试 → 整页报错**（"出错了 / 页面出错了"） | 待核：`POST /admin/ai/test` 出错时前端**没兜住**（没配 key 或 500）→ 落进错误边界；应就地显示失败原因 | 点测试：成功显示回执、失败**就地**显示错误行（不整页崩）；两种态各出图 |
| **D13** | **自检面板**看起来是坏的（显示 404 + 一堆「—」） | 不是 bug：debug 关闭时后端**故意**回 404 `common.not_found`（C3 的设计）。但**呈现方式让它像坏了** | debug 关闭时**不画那张 404 卡与空指标格**，只留一句「自检面板默认关闭，需开启 debug」；开启时正常显示 |
| **D14** | 管理页顶部那行**「示范管理员 @demo-admin」不是当前登录账号** | 待核：`AdminShell` 的管理员卡**写死了 DevRoom 的 mock**，产品页没喂真 `session` | 显示**真实**登录者（昵称/@handle/角色）；拿不到时不显示而不是显示假的 |
| **D15** | **dev 下主页没有进入 DevRoom 的按钮** | 待核：`DevEntry` 由 `import.meta.env.VITE_DEVROOM` 控制，而 dev 制品**是用 `VITE_DEVROOM=1` 构建的**（`pack-dev.ts`）→ 理论上该显示；实测没有，两种可能：**被摇掉**（W-FI 的 F1 证据显示的是生产构建）或**渲染位置不可见** | dev 制品首页**看得见、点得进** DevRoom；生产制品**零痕迹**（F3 的门禁继续管） |

---

## 1b. 第二轮（用户 2026-10-14 21:55 实测，附作者卡截图）

| # | 现象 | 根因（**已定位到行**） | 验收标准 |
|---|---|---|---|
| **D16** | 作者卡在没有头衔时显示一枚「**无头衔**」徽标 | `devroom/pages/12-topic/author-card.tsx:40` 写死占位：`title={author.title ?? { name: '无头衔' }}` —— 全站其它 4 处（`comment-item`/`topic-row`/`user-badge`/`profile-hero`）都是 `title ? <TitleBadge/> : null`，只有这一处编了假头衔 | 没有头衔就**不画**那一枚（与其它 4 处口径一致）；断言 + 出图 |
| **D17** | 作者卡里「头衔」与其它身份件**没有居中对齐** | 昵称/角色徽标居中，而头衔那一行是左对齐（同一列里的混排） | 头衔与头像/昵称/角色**同一条中轴**；1440 与 390 各出图 |
| **D18** | 主页不显示头衔；且期望**点头衔可下拉选择佩戴/不佩戴** | `routes/profile.tsx:141` 是 `u.title ? <TitleBadge/> : null`（没有"可以选择"这回事）。后端**已就绪**：`PUT /me/title`（佩戴/卸下）、`GET /titles`、`GET /users/{handle}/titles` | **本人主页**：头衔常态**与普通显示完全一样**（不点看不出可交互）；**点击**才展开下拉：列出本人持有的头衔 + 「不佩戴」；选完即调 `PUT /me/title` 并刷新。**别人主页**：只显示、不可点。没有头衔且是本人时**不显示假占位**（接 D16） |
| **D19** | 右侧**没有关注按钮**（用户怀疑根本没做） | **确认：前端从未接线**。`author-card.tsx` 里 **0 处** follow；`routes/*` 里只有 `followBoard/unfollowBoard`（**关注分区**，在左栏/分区页）。后端另有 `PUT/DELETE /users/{handle}/follow`（K-REL 的 L5）**一直没有前端调用方**。FIX-TOPIC 在 D9 量到的"关注按钮"是分区那个 | 作者卡与个人主页都要有**关注用户**按钮（登录态；自己看自己不显示；未登录引导登录）；点了真的调 `/users/{handle}/follow`，态从服务端回；断言 + 出图 |

**D9 结案**：不是重叠 —— 是**那颗按钮根本不存在**（量到的"关注按钮"属于分区关注，位置在左栏）。FIX-TOPIC 的矩形对照因此是无效对照，本条作废，改按 D19 处理。

---

## 1c. 第三轮拍板（2026-10-14 22:30，用户对 MIG-ART 盘点结论的回答）

| 项 | 用户决定 | 落点 |
|---|---|---|
| **公告区「只有管理员能发」** | **「一并迁移」** —— 按老站语义真做（老站 `PostSection::Announcement.required_permission() == ManageUsers`） | 新站要能证明：普通用户往公告区发帖 → 拒绝；管理员 → 成功。三条路与取舍见 `数据迁移审计.md §6.5`，**按老站语义选**，不是按哪条好写 |
| **`tool_player`/`tool_dev` 中文名少一个「用」字** | **「也迁移」** —— 老站是「工具（玩家用）」「工具（开发者用）」 | `forum/internal/app/seed_data.go`（一行）；同时核迁移过来的库里已有分区名要不要一起改 |
| **E3「AI 配置新站没有」** | **「调整掉，保证完全迁移」** —— 这句已过时（`ai_config` 表 + 四个 admin 端点都在）。**并且把老站 AI 配置的「值」也纳入迁移资料**，让结论落在「已迁」而不是「待迁」 | 先找老站真源（配置文件/表/常量），再落成迁移资料 + 导入路径；盘点表同步改成「已迁」 |
| **Issue 页面文案** | 「**汇报 bug 按钮就是汇报 bug，而不是什么奇怪的词**」 | 种类文案真源是 `devroom/pages/12-topic/_task/types.ts:29` 的 `bug: { label: '报个 Bug' }` → 改「**汇报 Bug**」；**单点改**（别在多处各写一份），测试断言跟着改。顺带核用户可见处有没有裸枚举/语法串泄漏（用户截图里出现过 `|difficulty|other·label:` 这种形状） |

---

## 1d. D20 窄屏截断（FIX-COPY 出图时抓到，Lead 已修）

| # | 现象 | 根因 | 状态 |
|---|---|---|---|
| **D20** | 窄屏下四个反馈入口的文字被截成「汇报 B / 功能建 / 难度建」 | `13-issue/index.tsx:191` 写死 `grid-cols-4` —— 390 下四列塞不下 | ✅ 改 `grid-cols-2 sm:grid-cols-4`（窄屏 2×2）。**看图确认**：标签完整、无截断。⚠️ 实测视口是 **500px**（headless Chrome 有最小窗宽），不是 390 —— 但 500 < 640 的 `sm` 断点，走的是同一条分支 |

**顺带**：`web/scripts/cdp-shot.ts` 补了两个一直缺的能力（窄屏/首屏之下是反复出现的需求）：
`CDP_SIZE=390,844`（**逗号**，写成 `390x844` Chrome 静默忽略 → 拍到 758×482 的默认窗）与 `scroll:<css>`（截图是视口大小不是整页，不滚就拍不到下面的元素）。

---

## 1e. 第四轮（用户 2026-10-15 08:00 在 dev `cbf714d` 上实测，10 条）

| # | 现象 | 初判（**要实测确认，不许照抄**） |
|---|---|---|
| **D21** | 帖子页内左侧**依旧不显示分区封面** | 该页左栏用的是 `routes/topic.tsx` 传进去的 `BOARD_NAV` **常量表**（无封面字段），不是刚补了封面位的 `BoardRail` View —— 两个入口两套数据源，只改了一处 |
| **D22** | 收款码设置**期望点击后就地悬浮窗**，而不是跳个人设置页 | 打赏面板那颗「设置我的收款码」现在是链接跳 `/settings#payment-channels`；应改成页内弹层 |
| **D23** | 头像只有基础上传，**没有选择启用区域（裁剪）** | 要「选图后弹裁剪框选区域」；复用现有图片管线与房子件 Dialog，不许引新依赖 |
| **D24** | 收款码上传后**应默认显示**（默认配置调整） | 现在新建渠道默认关着；改后端默认值或前端初值，**说清改哪边** |
| **D25** | AI 审核**缺帖子内容预览**；且**要验证图片是否一并发给模型** | ① 审核屏就地预览被审内容；② **实测**上行 payload 里有没有图，结论落在"发/不发"之一 |
| **D26** ✅已修 | **邮件发码器是假数据、完全无功能** → **不该进 dev 与生产实例** | **核清后选「真做」**（不是假数据，是缺唯一的写入口）：后端表/端点/发信链路/e2e 全在，而屏上没有「新增账号」与「配凭据」两块表单（`lib/api/admin.ts` 的 `createMailAccount` 零调用方）。已补两块表单 + 「一封邮件都发不出去」就地告警；**生产带这屏**（账号不写配置、没有 CLI，去掉就永远建不出账号）—— 结论与运维两步写进 `上线步骤.md §6.1`，全过程见 `进行中/进度-FIX-MAIL.md` |
| **D27** | 管理页「分区管理」**稳定裂图** | 裂图 = URL 拼错（少 `/img/` 或没走 `imagePath`）；与 D21 **分别取证** |
| **D28** | 管理页**默认权限树显示有问题**（或权限没按预期设置） | 逐条核 `role_permissions` 默认值与界面映射，**给「应该是什么」的对照表** |
| **D29** | **无手动激活开关**：打开 → 不发验证码、等管理员手动激活；关掉后未激活账号可再发码 | 后端已有 `auth.auto_activate_on` 概念（`MeResult.AutoActivate`），缺站点设置开关与两条路径联动 |
| **D30** | **dev 实例主页没有进 DevRoom 的按钮** | **Lead 判定**：`deploy.ps1` **不构建**（要求 `web/dist` 已存在），而上次跑的是**生产** `pnpm build`（无 `VITE_DEVROOM`）→ 产物本来就没有入口。修：dev 部署必须用 `VITE_DEVROOM=1`，并加守卫（dev 产物无 `dist/devroom/index.html` 就拒绝） |

---

## 1f. 部署链上的两条实测教训（2026-10-15，Lead）

**① deploy.ps1 不构建 dev 房间入口 → D30 的真根因。**
它自己跑一遍普通 pnpm build（无 VITE_DEVROOM）、也不把房间并入 dist/devroom，所以**任何一次 dev 部署都会把「没有房间入口」的产物装上去**
—— 这不是「忘了构建」，是脚本从来没做过这件事。
已修（edd25c1）：dev 实例跑 VITE_DEVROOM=1 pnpm build + pnpm preview:build + 并入 dist/devroom；
并在打包前**加守卫**：dev 产物的 dist/devroom/index.html 不存在就拒绝部署（**-SkipBuild 也挡** —— 那次就是这么漏出去的）。生产实例刻意不做这两件事。

**② 编辑工具写进 .ps1 的中文字符串会让 PowerShell 7 解析失败。**
实测：给 deploy.ps1 加了含中文的 Fail(...) 与 Info(...) 后，Parser::ParseFile 报
「The string is missing the terminator」/「Unexpected token 'dev'」，**级联出 8 条错**；把这两处文案换成 ASCII 立刻「语法 OK」。
注释里的中文没事（原文件的中文都在注释里）。**所以：改完 deploy/*.ps1 必须跑一次解析检查**——
用 [System.Management.Automation.Language.Parser]::ParseFile 传 [ref] 收错误。
**更好的一条**：别用编辑工具往部署脚本里写中文字符串 —— 诊断文案英文一样读得懂，而写坏的是**上线链**。

**③ 回滚链在真实失败里跑通了**（顺手得到的一次证据）：这次构建失败后脚本自动 ROLLBACK current -> releases/cbf714d、
after rollback: health_code=200，并明确声明**数据库不回滚**（迁移是单向的）。即：**dev 上没有半成品**。
代价是那次部署白跑一趟 —— 多 agent 在途时部署要等它们停。

---

## 1g. FIX-COVER 结论（D21/D27）+ 一条待拍板（2026-10-15）

**D21 的真因（派单初判不成立，如实记下）**：不是「两套数据源」，是两条各自独立的错 ——
① `_parts/topic-mappers.ts` 的 `toDesignBoard` 读 `b.cover`，而 `BoardDTO` 里叫 `cover_hash`（没有 `cover` 这一列）→ **恒为空串**；
② `12-topic/left-rail.tsx` 是**第二份分区列表实现**（自己画行、自己拼 img，不带 imagePath/占位）。
改法：左栏交回 `03-navigation/board-rail.tsx`（那份有封面位），删掉第二份；`boardRows()` 收进 `_parts/mappers.ts` 一处共用。

**D27 与 D21 不同源**：`assetUrl()` 是 public/art 静态素材的拼法，而分区封面是**图片端点**的资源 ——
于是后台拼出 `/dev/art/img/<hash>` → **稳定裂图**（列表缩略图与资料预览两处），改 `imagePath` 即好。
**关键发现**：`web/public/art/img/c0c0c0…`（018a952 出图时塞的假映射）让错的 URL 在出图里也能解析，所以这条一直拍不出来；已删。
实测对照：`/img/<hash>` → 200，`/art/img/<hash>` → 404。

### ✅ 已拍板（2026-10-15）：「今日 N」**加**（Lead 实现）
左栏行现在是 BoardRail 的形状（**封面 + 名称 + 帖子数**，单行），**不再显示「今日 N」**——
因为全站只剩这一份分区列表，而首页与分区页的左栏本来就没有「今日 N」。
要保留就得给 `BoardSummary` 加字段（会同时改首页与分区页的左栏）。**等用户一句话**。

### 并发记账（工具层教训）
FIX-COVER staging 之后、commit 之前，**索引被并发的 `git reset` 清空过一次**（reflog 里是 D25 留的 `reset: moving to HEAD`）——
第一次提交只带上了进度文件，它自己用 `git reset --soft` 重新合成。**多 agent 同时提交时，`git reset` 是危险动作**：
它清的不只是自己的索引。结论：子 agent 只准用 `git add <明确路径>` + `git commit`，**不许用 `git reset`/`git stash`/`git checkout --`（Lead 专属）**。
另：它的 `12-topic/topic-view.tsx` 19 行被 D22 的提交卷进去了（对方 add 范围偏大），内容没丢，只是归属错位。

---

## 1h. 第五轮（用户 2026-10-15 09:10–09:25 在 dev `f326a2b` 上实测）

| # | 现象 | 处理 |
|---|---|---|
| **D31** | **用户管理页始终只显示 20 人、翻页不可用、看不到总人数**（严重） | 派 **FIX-USERS**：先核后端给不给总数（界面那句「只有 next_cursor」是我们自己写的），再给总数 + 真翻页（游标 vs offset 要写取舍），筛选后总数跟着变 |
| **D32** | 默认封面是「完全没有关联的字」 | 用户澄清：**要用美术资产里的一张弥音图**。派 **FIX-COVER2**：从 `web/public/art/miyin/**` 选一张（不许新造图）、一处定义的默认封面件替换所有首字占位、静态美术走 `assetUrl()` |
| **D33** | **AI 审核屏四个缺口**：①递交 AI 审核的**预览还是没做**；②连通性测试**看不到发给 AI 的测试样例**；③样例**无法编辑**；④**无法验证图片审核是否起效** | 派 **FIX-AI2**（见下） |

**D33 的关键约束**：预览必须是**真正发给模型的那一份**（与 `aireview` 组装同源），不许前端自己拼第二份；
图片那条要**给出可复现的验证路径**（而不是文档里一句「不发图」）——FIX-PERM 已实测结论是**不发图**，界面上要把这个事实摆出来并可当场验证。

**同轮验收**：`f326a2b` 已部署 dev，`migrate=52`；后端全量 **36 包全 ok**（gofmt 空 / vet 0）；
**D30 线上亲眼确认**——对着 `http://191.40.41.97/dev/` 拍到的首页右下角有「开发页面（临时）」。

---

### D33 ③ 权威事实（用户给的官方文档，2026-10-15 09:35 已核对）

来源：https://api-docs.deepseek.com/zh-cn/guides/vision ——
- **`deepseek-flash` 本身支持图片输入**（旧名 `deepseek-v4-flash-vision-exp` 已下线，请求由最新 Flash 承接）⇒ **不用换模型**；
- 支持 **JPEG / PNG / GIF / WebP**，**按文件内容判断**而非文件名/MIME ⇒ **我们的 webp 直接发，不用转格式**；
- 请求形状 = 标准 OpenAI 兼容 content 块数组：`messages[].content = [{type:text},{type:image_url,image_url:{url:"data:…;base64,…"}}]`；
- **base64 内联计入 48 MiB 请求体上限**；另一条路是公网 URL（≤8192 字符、图 ≤32 MiB、60s 内取回）——**dev 没有公网图片地址，必须走 data URL**。

派 **FIX-VLM**（后端 payload/取图/上限/记录 + 管理端预览与连通性测试；因无法给已派出的子 agent 发更正，预览那一半并入本包）。
### D33 收口（2026-10-15 10:35，Lead 代收）

FIX-AI2 被中途停止（无收尾报告），其半成品由 Lead 接手收完：
- **接线**：`AiPayloadView|AiPayloadImage|AiTestView` 三类、`fetchAiPayload/probe` 样例可编辑（**临时覆盖不落库**）、
  审核屏与 AI 屏都给「看发给 AI 的那一份」+「真跑一次（含图）」，topic 用 `topic_public_id` 寻址（uuid）。
- **补的全是代码层面的真空**：`admin-fixtures.ts` 引用了不存在的 `./raw-content` 与未定义的 `payloadOf/AI_IMG_A/B`
  （出图桩整个红着）；`users-footer.tsx` 用了 Ring 不存在的 `inputStyle`；**测试桩没盖住新请求** `/admin/ai/payload`
  → AiPayloadView 一渲染就崩 → 错误边界接管 → 三条「连通测试」旧用例红（根因，已在用例注释里写明）。
- **后端两个在途文件**（`preview_test.go`163 行 / `bind.go` 空 body 归 EOF）实测 `ok 20.8s` 后入库；调试垃圾 `forum/*.txt` 已清。

---

## 1i. 第六轮（用户实测 dev `c743e24` 之后）

| # | 现象 | 处理 |
|---|---|---|
| **D34** | **连通性测试样例无法自己配图**（只能改文字）→ 无法用自己图当场带图测试 | 派 **FIX-VLM2**：`/admin/ai/test` 与 `/admin/ai/payload` 接受 **multipart**（`probe` 文本 + ≤4 张 `file`），图片**只在内存里走**（不写 topic_images、不落 review_events、不留文件 —— 沿用 TestTopic「一个字都不落库」的既定语义）；前端 ProbeEditor 加选图（格式/张数/单张体积的拒绝理由就地显示——与 topic 路径同一套上限常量），选完即重算 payload 干跑（所见即所发）；**JSON 路径保持原样**（向后兼容）。无 schema 变更，**不加迁移** |

**先决事实（已实测）**：多模态主链路在线上是通的 —— 2026-10-15 用程序生成的伪二维码 PNG 走 `TestTopic{topic_public_id}`：
回执 `verdict=review`、reason「含**伪二维码图**…交人工」、`image_count=1`（存档 shots/dev-live/vlm-receipt.json）。
D34 补的是**管理端当场自助**这一缺环。

---

| **D35** | **图片体积的服务端硬上限未实现**：前端闸（头像 128KB 目标 / 10MiB 拒收）只是 UI 拦截，绕过前端直接 POST 无约束（服务端只验图片格式，不验字节） | 小改动：media 域按档位做字节上限（头像 128KB / 封面与配图 PostMax），加会红用例 |
| **D36** | `web/src/ui/rich/attachment-slot.tsx`（发帖附件位）**没有测试**，而 18-compose 在用它 | 补组件用例（min 修正类）：展示/移除/上限计数三条 |

## 1j. 第七轮·邮件文案可自定义（用户 2026-10-15 11:3x 拍板，D37）

`Render` 现状（render.go 已核）：正文=go:embed 四组模板、主题=Go map 写死、站名/有效期=硬编码兜底 —— 文案修改需要重新构建。

| # | 决定 | 交付口径 |
|---|---|---|
| **D37** | **邮件模板可自定义**：后台编辑页（主题/HTML/纯文本），**保存即用 text+html template 编译校验**（转义与语法错误当时拒收，不许存进库里一个会炸的模板）；**预览=转义后的真渲染**：用样本 Data（含 `<script>` 类字符串的昵称/站名）过一遍真模板链，HTML 给 sandbox iframe、纯文本并列展示；缺行回落内置文件（零数据迁移语义） | 派 **FIX-MAILTPL**（迁移 0054 起，报号） |

安全口径（照 render.go 既有原则）：Data 走结构体、用户输入在模板执行时按上下文转义；admin 端点挂 site.setting；不做富文本编辑器（纯文本模板框），不引入任何前端邮件编辑库。

---

## 1k. 第八轮（用户 2026-10-15 12:0x 实测分区管理后提出，D38/D39/D40）

| # | 现象/要求 | 处理 |
|---|---|---|
| **D38** | **需要用户组系统**：可建组、可把指定用户拉进组，分区上**按组**授「能不能发言/能不能回帖」——即「只有特定用户（组）可发言/回帖」的白名单粒度再细一层 | 派 **FIX-GROUPS**（迁移 0055 起，报号后动手） |
| **D39** | **分区管理界面混着大量设计文档口径的內容**（「13.4 + D6：分区表驱动…」「PATCH 的 body 全是指针…」「D6 第 4–6 步先命中」Pill 等）——这些是给开发者的口径，不是给管理员看的 | 并入 **FIX-GROUPS** 同包同屏清理：note/Pill 类全部改成**管理员能懂的操作说明**（或删掉） |
| **D40** | **超级管理员理应全权，但分区管理里「超级管理员」那一档不存在/不可编辑**——超管被锁在 ACL 白名单外时界面上没有任何直观说明 | 并入 **FIX-GROUPS**：矩阵补 superadmin 行**锁定为「全域继承」**（不可编辑 + 原因一句），后端说明白「is_super 不受矩阵控制」的既有语义——不许改语义本身，改的是**呈现诚实**（推断一律落实测） |

**语义口径（Lead 先钉，agent 照实现）**：① 组是**加法授权**（acl_enabled 白名单下：组授 can_post/can_reply 即成员可发可回）；② 显式 deny（任一层）**终局**（`ck_board_acls_no_contradiction` 的既有精神）；③ superadmin 的 is_super 语义不因本包改动。

---

## 1l. 部署事故：75832e0 迁移后起不来+回滚也起不来（2026-10-15 13:1x，Lead 收口）

| | 内容 |
|---|---|
| 现象 | `deploy.ps1 dev` 到 75832e0：migrate 好了（version=55）但服务带不起来；`rollback` 回 8d749c3 也带不起来——**站点双面宕机** |
| 根因 | 两段叠加：① 0054 给 `mail_templates.updated_by` 建了 FK（ON DELETE SET NULL）**没配索引**，`platform/db.SelfCheck` 的「外键列必须有可用索引」在 `forum run` 启动时判死（日志：`外键 mail_templates.mail_templates_updated_by_fkey 上没有可用索引（RI 查找会全表扫）`）；② 8d749c3 是**没见过 0054/0055 的旧二进制**，起来只报「数据库 schema 版本 55 与二进制 53 不一致」——回滚脚本没考虑「DB 已领先」这条路径，回滚本来就不可能绿 |
| 处理 | 服务器手工 `CREATE INDEX idx_mail_templates_updated_by`（幂等）→ `systemctl reset-failed` + restart → **active，dev@8082 health/home 200**；仓库补迁移 **0056_mail_templates_fk_index**（`IF NOT EXISTS`，新库走迁移、这台已手工补的幂等） |
| 教训 | 0054 的表注释还写着「不补单列索引」——那是给 kind 的，updated_by 的 FK 漏划了；**带 FK/SET NULL 的列，up 文件必须同行写 CREATE INDEX**（0055 就是这么写的，0054 漏了）；回滚路径遇到「DB 已领先于旧二进制」时应直接报错而不是盲重启 |

### 1l-bis. 生产首部署 20147d0（2026-10-15 13:3x，Lead）

| | 内容 |
|---|---|
| 关键发现 | **prod 服务早就 failed，公网一直由「维护占位页」回答**：`sc2clud-placeholder.service`（占位页自己注释「临时；新站上线后删除」）自 10-13 22:36 占住 127.0.0.1:8080，论坛 191.40.41.97:8080 bind 失败反复重启判死。deploy 预检的「port 8080 held by something else」正是这个 —— 既挡部署，也说明此前 prod_home_8080 探测 200 是**假绿**（答话的是占位页不是论坛） |
| 处理 | ① 迁移先用 **prod 数据拷贝**预演：`pg_dump` → 临时库 `forum_migrcheck`（runuser 建库，forum 角色无 CREATEDB）→ 新二进制 migrate **19→56 全绿**+`forum check` 通过 → 临时库即删；② 占位页 stop+disable（按其注释到达使用终点）；③ `deploy.ps1 prod` 正式部署 **20147d0**：备份 `pre-deploy-20147d0-20261015-053721.dump` → 真库 migrate **19→56** → 服务 active → health/home/asset 200 → **公网身份断言**「IS this build」绿 |
| 后果 | **prod 数据零改动、dev 保留**：迁移全为 schema 增量（0020 起无 INSERT/UPDATE/DELETE；敏感三处——0026 FK 值域=旧 CHECK 四类、0028 约束只增态、0050 逐行默认——拷贝库已先核）；dev current 仍 75832e0 / DB 55 / health 200 完好 |
| 记入 BACKLOG | ① deploy 的 `Wait-Health` 探测的是**本机** `127.0.0.1:8080`（Windows 侧永远 000），白等 60s 后才靠远端 facts 判定——应改成 ssh 探测；② 迁移素材（`board-covers`/`ai-config` 清单）已随产物上机但**未对 prod 执行**（写 prod 数据的运维动作留给用户拍板） |

---

## 1m. 第九轮（用户 2026-10-15 13:5x 在 prod `20147d0` 上实测）

| # | 现象 | 根因（两处都实证） | 处理（`4151bb7`） |
|---|---|---|---|
| **D41** | **IP 访问登录后仍是未登录**（两次稳定复现） | prod `base_url=https://域名/` → 会话 Cookie 一直按配置带 `Secure`；经 IP 明文 http 访问时浏览器按规范**直接丢弃** Secure cookie——登录成功也无会话 | `auth/token.go`：Secure 改按**请求实际协议**推导（r.TLS / 可信代理的 `X-Forwarded-Proto`，伪造的 XFP 不算数；nginx 早已转发 `$scheme`）。用例 `token_cookie_test.go` 五行矩阵：IP 明文不带 Secure、域走 TLS 带、伪造 XFP 不认 |
| **D42** | **验证码错误率极高 + 刷新几次就「加载失败」** | ①出题限流 **10 次/小时/IP** 被 always 模式榨干：页面载入+换几张+每次失败都要新题，**答对的人也撞 429**；②`checkCaptcha` 排在密码校验**之前**且题目一次性——**密码错一次题就作废但前端只对验证码类错误换图**，用户对着死题重输→「明明画对了却说错」 | ①出题额度 30/小时（≈每 2 分钟一张的持续速率，防刷仍成立）；②前端**任何**失败都换新题（429 例外——出题限流同刻，重生无效）；③**验证码框按需亮出**：只在 `auth.captcha_required/captcha_wrong` 后出现，常态不拉题（顺带省额度） |
| 期望项 ✅ | **只在限流开始后才要求验证码**（连续登录错 >5 次） | 机制早已存在：`mode=on_failure`=同 IP 10 分钟内失败 ≥5 次才要求（Failures 计数在内存，成功清零；单测 `TestCaptchaOnFailureAfterFiveFailures` 钉住） | **prod.env 拨到 `on_failure`**（备份 `prod.env.bak-captcha-*`）；`checkCaptcha` 对登录生效。实测：首个错密码→`bad_credentials`（无需验证码）；连打 6 次秒级重试会先撞登录限流 10/分（独立防线，冷却后下一次要求验证码） |

**同门注意**：`checkCaptcha` 同时闸注册——prod 现在 `auto_activate=false`（邮箱验证码兜底），d5-content §7.2 原案就是这么设计与论证的；申诉（匿名）路径的兜底是限流，建议后续复核留痕。

---

> **顺手发现、未改**（不属于本轮范围，留作待办）：`forum/internal/forum/topics.go` 的 `UpdateTopic` 里
> 「只有资源帖能设 resource_status」那条检查是**死代码** —— 它读的 `k` 与 `resourceStatus` 都在它之后才赋值
> （`k` 恒为 `ref.Kind`、`resourceStatus` 恒为 nil），所以给非资源帖设维护状态现在**挡不住**。
> 修它要先把 kind 的解析挪到校验之前，属另一件事，没在本轮顺手改。

### 1n-sexies. 改分区事实上无效（用户 2026-10-15 17:3x 实测）

| # | 现象 | 根因（实测） | 处理 |
|---|---|---|---|
| **D55** | 编辑页把分区改掉、保存后**分区没变** | 后端 `PATCH /topics/:id` **本来就支持 `board`**（`UpdateTopicInput.BoardSlug`，改分区要 `topic.move`），但前端 `updateTopic` 只发 `title`/`content_md` —— **界面让人随便改，那个值从来没上过行**。另：后端的 topic.move 检查写在 `UpdateTopicFields` **之后**（靠事务回滚兜住，行为对但读起来像先写后判） | ① 前端按「**只在分区真的变了时才发 `board`**」提交（每次都发会把没有 topic.move 的作者连保存都 403 掉）；② 没有 `topic.move` 时把分区栏 **锁上**（`disabled` + 页头说明），并让页头文案不再撒谎（原来写着「分区不在这一步改」）；③ 后端把 topic.move 检查**挪到写之前**；④ 钉子：Go `TestUpdateTopicBoardNeedsTopicMove`（无权限 → 403 **且分区没变**；只改标题照常能存；有权限 → 真改）、前端断言「没改分区时 PATCH 不带 board」 |

### 1n-quinquies. 编辑保存后 400「参数错误」（用户 2026-10-15 17:4x 实测）

| # | 现象 | 根因（实测证据） | 处理 |
|---|---|---|---|
| **D54** | 点「编辑」→ 保存 → 落到「加载失败（帖子详情没能加载）参数错误（编号 cd7e74e36204cb6e）」 | 前后端契约不一致：后端 `PATCH /topics/:id` 回的是 `{ok:true}`（**不是帖子详情**），而前端 `updateTopic` 声明成 `Promise<TopicDetail>`，compose 保存后拿 `t.id` 拼跳转 → `/t/undefined` → 路径闸 `httpx.ValidPathIDs("id")` 判 **400 参数错误**。**钉子的红证据**：断言 `expected '/t/undefined' to be '/t/tp-1'` | ① `lib/api/forum.ts` 的 `updateTopic` 改成 `Promise<void>` 并把「回执不是详情」写在注释里（类型不再骗人）；② `routes/compose.tsx` 把帖子 id **显式算出来**（编辑态用请求里的 `editId`，新建态用 POST 回执的 id），保存后按它跳转与失效缓存；③ 钉子：`compose.test.tsx` 加 `/t/:topicId` 探针，断言保存后落在 `/t/tp-1` |

### 1n-quater. 「偶发 404 / 强刷必挂」的真根因（用户 2026-10-15 17:0x 实测指出这是老毛病）

| # | 现象 | 根因（实测证据） | 处理 |
|---|---|---|---|
| **D52** | **页面偶发 404 / 渲染失败；强制刷新更容易中，普通刷新又好了**（用户：这是之前就发现过的老毛病，房间与很多页面都这样） | server 级 `limit_req zone=sc2clud_req burst=16 nodelay` 会被**没写 limit_req 的 location 继承**。强刷清缓存 → 浏览器并发取 20+ 个 chunk → 第 17 个起 **429** → 模块加载失败 → 页面报「这一页渲染失败了」。实测：连发 40 个房间 assets，**第 19、20 个 429**；`location /`（生产 SPA）与房间 assets 都没写 limit_req | 四个 location 显式声明突发额度（速率仍 8r/s）：房间 assets / 房间入口 / `/dev/` / `location /` → `burst=200 nodelay`。**验收：40 个房间资源 + 20 个生产 chunk 连发 → 全 200，零 429**（nginx 配置与验收命令记进 `deploy/nginx-sc2clud.md` §4b） |
| **D53** | 房间（DevRoom）**两天来一直是旧包**（我出图时才发现：18-compose 的路由块取不到） | nginx 的 `/dev/devroom/` 指向 `/srv/sc2clud-dev/dist/devroom/`（那份是**手工拷的**，10-13 17:28），而部署把房间放进 release；release 又是 `umask 077`+root 所有，**nginx（www）读不到**（把 alias 指过去实测全 404）。于是**期间所有「房间出图确认」看的都是旧包** | ① 立即发布当前 release 的房间到该目录（世界可读）；② `deploy/remote/install.sh` 增加发布步骤（切 `current` 之后），房间从此跟部署走；③ 记进 `deploy/nginx-sc2clud.md` §4c。**出图证据**：`shots/dev-live/compose-edit-body.png`（编辑态正文已带内容） |

### 1n-ter. 头衔新建的两个真缺陷（用户 2026-10-15 16:3x–16:5x 实测）

| # | 现象 | 根因（实测证据） | 处理 |
|---|---|---|---|
| **D49** | 「新建后**创建后消失**」；用户怀疑 RGB 编解码 | **没有消失这回事**：prod 访问日志时间线 —— 16:33:07 两次 400（颜色值不合规）、16:35:55 一次 409（key 重复）、16:36:05 一次 **201**（默认色 `111/1111`，落库并被接口正常列出）。观感来自：**弹窗无论成败都立刻关闭** → 失败看着像成功，列表里又没有那一行 | 弹窗**只在真的建成时关**：`onCreate` 改 `Promise<boolean>`，失败把理由显示在弹窗里、输入不丢；钉子 `titles.test.tsx` 两条（失败不关窗 + 建成才关） |
| **D50** | 颜色要人手填十六进制 | 取色是常见功能，仓库却只有一个自由文本框 | **引依赖** `react-colorful@5.8.1`（零依赖、只做取色，输出就是 `#rrggbb` 小写＝后端与 DB CHECK 的形状）。**换掉的自维护面**：颜色字符串的格式校验与「用户拼错颜色」这一类错误路径（连同输入提示）。用户明确要求：这类控件不自造，没有依赖就装 |

| # | 现象 | 根因（实测） | 处理 |
|---|---|---|---|
| **D47** | 改动上线后**编辑进去正文全空**（标题/分区/来源都对） | `content_md` 是历史列（老站是 Markdown 纯文本），而 `MarkdownEditor` 按 EditorState JSON 解析 —— 不换算就是空文档。我撤掉帖内弹层时，把那份换算（`toEditorState`）一起删了，而 `routes/compose.tsx` 的预灌从第一天起就是直接塞原文 | 换算落成共享件 `web/src/ui/rich/markdown-to-editor-json.ts`（产品与房间共用），两处预灌都过它；钉子：`markdown-to-editor-json.test.ts`（JSON 原样 / 纯文本包最小文档 / 内容不丢）+ `compose.test.tsx` 的「编辑态回填编辑器拿到含正文的 EditorState」 |
| **D47-bis** | 上线后用户复测 **正文依旧空白** | 上一轮只修了「换算」，还有更深一层：`MarkdownEditor` 的 `InitialState` 带 **`done` 守卫 —— 只在挂载那一刻读一次 value**，空串就永久空白。而 compose 页是「先渲染编辑器（doc 还空）→ 再用 useEffect 回灌」→ 晚了一步，永远灌不进去。**判据**：`markdown-editor.tsx:107-124` 的 `if (done.current) return; ... if (!value) return;` | 两处预灌（`routes/compose.tsx`、房间 `18-compose`）改成**渲染期推导**（React 的「props 变了就调整 state」写法）：查询到手的那一次渲染里 title/board/kind/doc 一起定下来，编辑器挂载时 value 已是正文；编辑态在详情到手前不画表单（`<Loading what='帖子内容'/>`）。测试替身也照抄真语义（**只认挂载时那一次 value**），否则这个缺陷测不出来 |
| **D48** | 管理端**新建头衔稳定 400**（「参数错误」，无法创建） | 实测：合法载荷 dev/prod **都是 201**（不是代码坏）→ 是输入值不合规（key 带连字符/大写/中文、或颜色不是 #rrggbb），而后端把「哪个字段错在哪」放在 `fields` 里、**屏上只印一句 message**，用户只能反复试。日志证据：那笔 POST `ms=2`（在绑定/校验就死，没碰库） | ① `routes/admin/_shared.tsx` 的 `errorLine` 带上 `fields`（**全管理屏受益**）；② 新建弹窗就地校验（同值域）+ key 输入就地纠正（大写→小写、连字符/空格→`_`，字段里立刻显示真实要提交的值）+ 颜色/名称/说明的即时提示 |

| | 内容 |
|---|---|
| 现象 | 帖子页的「编辑」是**帖内小弹层**（简易标题框 + 降级编辑器），不是发帖页面那套（预览/配图/来源编辑器全都不在）——用户：「应该复用发帖页面做修改」 |
| 根因 | `compose.tsx` **本来就有** `?edit=<topicId>` 编辑态（自注释「复用而不是另写」），但帖子页没接：挂着 devroom 12-topic 的 `EditTopicDialog` 弹层自己处理 PATCH —— 同一个功能两套 UI |
| 处理 | ① `routes/topic.tsx`：编辑按钮给 `editHref=/new?edit=<id>`，重提按钮同样进编辑态（PATCH 本来就把 rejected 打回 pending）；帖内 save/PATCH 弹窗代码全部撤除；② 共用 View（12-topic）的编辑按钮从 onClick 改为**注入链接**（`editHref` prop，产品 / 房间各给各的地址），`EditTopicDialog` 与映射器删除；③ 房间 18-compose 增加 `?edit=` 预灌（房间 mock 与产品同口径）。提交 `723b42f`（−284/+84 行：弹窗实现整段撤除） |

---

## 1n. 第十轮（用户 2026-10-15 14:2x 在 prod `4151bb7` 上实测；`3735ccb` 收口）

| # | 现象 | 根因（实证） | 处理 |
|---|---|---|---|
| **D43** | **超管也看到「还不能发帖回复」，帖主/超管都看不到编辑按钮；「查看账号状态」点了跳登录页** | `TopicDetailDTO` 的 `can_edit`/`can_reply` **从没被赋过值**（dto.go 声明、map.go 忘了填）→ API 恒 `false`；前端 `??` 兜底只认「字段缺失」，字段在场=false 不兜底 → 全员假阴性；「查看账号状态」的 href 恒写 `/login` | `topics.go` 的 `TopicDetail` 补填充：`CanEdit=canEditTopic`（与 PATCH 的同一支判定）、`CanReply=!locked && canSpeak`（超管在第 1 步短路）；用例 `topic_can_flags_test.go`（帖主/超管/陌生人/锁帖/游客五行口径钉死）；前端把已登录态的按钮指向 `settings`（`4aef528`） |
| **D44** | **AI「测试连通 / 干跑」带图稳定失败 400 参数错误（≥1 MiB 的图必挂）** | D34 契约「4×2 MiB ≈10.7 MiB」**撞 Rahman `BodyLimit(1 MiB)` 组级中间件**：外层包装先生效，派单时挂在路由内的 16 MiB 是内层包装救不回来的；实测 dev 复现 1.3MB→400「样例图片读不出来」（`io.ReadAll` 被 `MaxBytesReader` 拦断，未把超限翻成 413） |两条端点**独立成组**（app/http.go：`ai := r.Group("/api/v1", BodyLimit(16MiB), LoadPrincipal())`，绕开 v1 的外层 1 MiB 链）；`probe.go` 把 `*http.MaxBytesError` 翻成 **413 `media.too_large`**。dev 回测：1.3MB→200、9MB→200（`3735ccb`） |
| 资料修复 | **资源帖的下载源（topic_sources）在库中为空**——弥音启动器帖（prod topic 11）正文写着「点按钮会跳仓库/网盘」，下载区却渲染不出；用户确认「火力全开」也必有源 | 迁移链上 sources 表建空了（数据从没写过，正文里的链接是唯一真源）→ **找到了真源**：`/srv/sc2clud-dev/backups/pre-legacy2-20261013-195609.dump`（切换前的旧实例全量）里 `topic_sources` 有原始两行（legacy id 54=火力全开→百度盘、55=弥音→GitHub Releases） | 按 legacy 原值移植进 prod（幂等写，`verified_at=NULL`＝未人工确认）：**topic 6 → 百度盘** `pan.baidu.com/s/1421…?pwd=jnd3`；**topic 11 → GitHub Releases（最新版）** `…/releases/latest`。API 已回源行验证；legacy 库里其余 10 条资源帖（id 61–80）**是旧 dev 的虚假演示数据，用户 2026-10-15 拍板不再迁移**——追它们到此为止 |

---

## 1o. 第十一轮（用户 2026-10-15 18:4x 提出三件事 + 壁纸裁切；Lead 收口，本轮一切只上 **dev**）

| # | 事项 | 事实/根因 | 处理 |
|---|---|---|---|
| **D56** | 「管理员无法重新为用户设置密码」 | 后端**没有**这一个端点（admin 组此前只有 ban / revoke-sessions / role / permissions）——不是前端没接，是功能缺失。可复用的形状全在 ChangePassword（validatePassword + argon2 信号量）与 RevokeUserSessions（同事务删全会话 + 审计） | ① 新端点 POST /admin/users/:id/password（user.ban）：password 空 = crypto/rand 生成 12 位无易混字符（去掉 i l o I L O 0 1）临时密码，**响应只回显这一次**（json omitempty）；显式指定不回显。同事务：password_hash + 删目标全部会话 + 审计 user.password.reset（detail 不含密码值，只有 generated / sessions_revoked）。**不设「最后一个超管」守卫**——重置超管密码正是救援路径（只换凭证不减员）。② 前端用户管理屏**行内 + 右栏**两处入口：弹层留空提交即可生成，出结果不关窗（临时密码关掉拿不回）、失败不关窗（字段理由就地显示，D48 同策略）。③ 红先绿：路由缺失时守卫用例红，恢复后 auth 包全绿（后端四条钉 + 前端屏四条 + client 两条）。提交 4be1fe0（后端）+ ea8c0d4（前端） |
| **D57** | 「无法退出登录」 | 前后端**早就都有**：POST /auth/logout + /settings 的 AccountPanel（testid logout、登出后 queryClient.clear()）。是**可发现性**：退出埋在 /settings，管理员从不往那儿想 | 后台右上「当前管理员」卡直接加「退出登录」（testid admin-logout；有登录者才画）：登出 + 清缓存 + 回登录页。shell 用例两条钉住。设置页原路径不动 |
| **D58** | 生产用户主页**背景裂图**（用户点名派子 agent 只读调查） | 子代理证据链：后端下发 cover=/img/<hash>（DB、文件、nginx、读链路**全部健康**，curl /img/… = 200 image/webp 76554B），前端 profile.tsx:187 误过 assetUrl()（前置 art/）→ 浏览器实际请求 **/art/img/<hash>** → 无文件无扩展名 → Go 静态回落 SPA index.html（200 text/html）→ img 拿到 HTML 解码失败 = 裂图。用户重传新封面 10+ 次也自救不了（journalctl 前后十几条 /art/img 请求） | 改 imagePath(u.cover) 原样放行（同一处 CoverPicker 预览一并修；fallback 的 art/ 素材仍是 assetUrl）。钉子：profile 页断言封面 img 必以 /img/ 开头、零 /art/img/。**生产不动**：修复随 dev 部署，用户验收后再推 prod |
| **D59** | 「壁纸的文件选择器缺少合适的图片选择器设置裁切和预览」；（用户补充确认此前说的头衔选择器也是这条主页背景壁纸链路） | 封面链路（主页/设置页/后台分区）此前**选图即上传**：没有裁切这一步，非横幅图被 CSS object-cover 随机裁，用户看到的和传的不一样 | **裁切引擎换 react-easy-crop@6.2.4**（经典可靠：拖动/双指/滚轮/键盘、比例锁都是它管）。家里只留三件事：读图交给库、比例预设 UI（封面默认 21:9，可切 16:9 / 3:2）、确认时按库给的 croppedAreaPixels 一次 drawImage 出 blob。**换掉的自维护面**：image-crop.ts 三大纯函数（fitFrame / clampPan / cropRect 的平移夹取、缩放夹取、原图坐标换算）与其测试**整组删除**；头像（D23 圆框）与封面（横幅框/可切比例）自此是同一个件的两档。钉 6 条：方形头像内接正方形、放大真进裁切、缩放边界、21:9 预设出 21:9、非圆框、maxEdge 长边。弹层拆出 users-dialogs.tsx（gate:size 587→超限，三个动作弹层成独立件） |
| **忘记密码答复** | 「用户忘记密码后有无途径重新设置」 | **有**：登录页「用注册邮箱自助重置」→ POST /auth/password/forgot → 邮件验证码 → verify-code → reset（票据一次性 + 全会话踢掉，email_test.go 全链路钉住）。**前提**：站点配了可用发信邮箱（mail_accounts 有可用行）——没有的话自助重置在发码环节走不通，需要管理员先在后台「邮箱配置」屏配好 SMTP | 部署后查 dev/prod 的 mail_accounts 有无可用行并在汇报里说明（生产只读） |

## 1p. 第十二轮（用户 2026-10-15 20:4x 提九条 + 裁切弹层补报；三子代理并发 + Lead 直修；账本处理列随交付补齐）

| # | 事项 | 事实/根因 | 处理 |
|---|---|---|---|
| **D60** | 下载源名称按 URL 猜、猜不中显示「其他」 | topic_sources 一直有 label varchar(60) 列（0004），用户自定义名早有位置——是前端没用它、按 URL 形状猜 | **已修**（2d4fbdc）：行主名 label 优先，空了回落站点名，两无则把原始链接主机名当注脚（不猜名，摆事实）；TopicSource/toDesignSource 补 url 透传；topic-view/topic 双测试。prod 现网截图证据 shots/b1-prod-miyin-sources.png |
| **D61** | 下载链接走站内中转 | 前端把下载源点击当路由 | **已修**（dc19113）：prod 实测整行 a[target=_blank] 已在线上（db6b72c 落地）——本单补 rel=noopener noreferrer + 钉子改断言，后端零改动 |
| **D62** | 用户组无法限制发帖权限 | 实测真根：**服务层 deny 判定正确，缺在 boards.acl_enabled 默认=false（prod 三分区全 false）时 canSpeak 第 3 步把整个矩阵连同 deny 跳过**——管理员戴上的禁令从不生效 | **已修**（b41fda7）：acl.go 白名单关闭分支先判显式 deny（角色行/组行任一）再走等级门槛；TestDenyAppliesEvenWhenAclDisabled 红→绿（禁发组 201→403 board.acl_denied + 角色行 deny 与无 deny 对照组）；can 语义不变。**黑盒提示：默认分区（acl_enabled=false）栽组 deny_post → 发帖应 403** |
| **D63** | 新帖不进 AI 审核 + 无审核历史 | 上一任 C 的遗作红钉（forum/internal/site/ai_toggle_default_test.go，未跟踪）：site.SettingSpecs 里 ai.review.enabled **声明默认值写成 off**（设计稿 d7 §2.2 = true），全站按「缺行回落声明默认」→ AI 审核默认**死**（入队与消费都正常，worker 第一步被 SettingBool 短路）。这就是「新帖不送审」的根因 | **已修**（d058a8a）： DAR默认 → on，红钉两条（遗作收编）转绿，internal/site 全套过（Lead 复跑同绿）**(834eef3)**：GET /admin/ai/events（cursor 分页、包络同审计日志、post.review）+ 审核屏「历史」页签（Prop 驱动）；events_test 两条 + review 屏 8 用例；aireview/site Go 双包 Lead 复跑全绿。**score 字段不编**（库与外呼协议都无数字分，编即假真源）；演示层 props 由 Lead 补（1958c6e）；迁移素材文档两句同步（1958c6e） |
| **D64** | 删除的评论用户侧仍显示 | 真根：TopLevelReplies 的作者例外（p.author_id=viewer）让作者软删自己的顶层回复后自己的列表照常显示（PostDTO 无 visibility，前端无从打标） | **已修**（4d7c5e6）：列表口径=「非 normal 谁都不列」；单条寻址 postRef 保留作者例外（分享链不受影响）；TestDeletedReplyVanishesFromListForItsAuthor 红→绿；前端失效本有（removeReply），D67 再补信息流面 |
| **D65** | 验证码大小写敏感（用户过不去）+ 错误只显示「编号」 | 前任 D 丧命前的 dev 实测：**代码语义已正确**（k7m2 答大写题→过、两端 trim、拒全宽）——缺的是钉子（TestVerifyIsCaseAndSpaceInsensitive 名字与替身不符），错误行半条另算 | **已修**（d01a1f9）：钉子补全四行为断言（实际位置 platform/captcha/captcha_test.go——非 auth/；auth 侧替身从假「区分大小写」公约改为真 ToUpper+TrimSpace 公约），行为代码零改动 **（01021e7）**：errors.ts 新增 apiErrorLine 全站唯一实现（message 优先/fields 次之/requestId 只作「（错误编号 …）」附注）+ 15-admin/bits errorLine 委托 + register-verify 失败文案对齐 ErrTokenInvalid；errors.test.ts 钉顺序。**Go 复核（Lead）**：captcha 0.48s + auth 70.5s 全绿——D65 闭环 |
| **D66** | 评论区新评论在上（应老上） | 排序键/游标方向 | **已修**（46bdebd）：顶层回复与 Issue 顶层评论改 id 升序，键与游标方向一起翻（id>游标、ORDER ASC）；intCursor 空哨兵 MaxInt64→0（升序第一页恒假会永久零行的坑）；TestTopLevelRepliesListOldestFirst 钉页序+三连翻页+尾页 |
| **D67** | 首页卡片评论数过慢（点进才见真数） | 真根：卡片数读 ['topics',…] 缓存快照；写路径本身同事务重算无漂移（prod topic 11 的 last_reply_at 脱节是历史数据尾巴，ops 回填建议见下） | **已修**（9f066ec）：回复成功/删回复成功后一并失效 ['topics']+['profile'] 前缀；topic.test.tsx 断言两段缓存 isInvalidated |
| **D68** | 归档头衔不可见不可改，key 被占用永久卡死 | 真根：GET /admin/titles 复用公共 ListTitles（滤归档）→ 归档行消失；又无删除端点 → 旧 key 被 409 且无处可解 | **已修**（3b5af0c，后端活在 forum/internal/title 包——编外但非禁区，Lead 复核通过）：AdminListTitles 含归档；新端点 DELETE /admin/titles/{id}：同事务先数引用，有持有/佩戴 → 409 fields 人数（不级联毁数据），审计带 deleted；管理屏行内「删除」+确认弹层，409 走 errorLine；TestAdminListIncludesArchived + TestDeleteTitleRefusesWhileReferenced 红→绿；D49 校验未动 |
| **D69** | 封面/壁纸弹层悬在左上角；白色覆盖层盖住裁剪区无法操作 | 实机复现（cdp-shot 注入文件 + elementFromPoint）：①「封面/背景」native dialog **margin:0px** 钉左上角——Tailwind preflight 吃掉 UA 的 dialog margin:auto，showModal 的 fixed 元素就钉角落；②裁剪框命中测试 = **外层 picker dialog**（hit=DIALOG、inside:false）——ImageCropper 的 Ring Dialog 是封面 dialog 的**子孙**，native modal 后代进不了 top layer 的正确层级 → 白覆盖/拖不动 | **Lead 已修**（13ab193）：①显式 m-auto + inset-0 + h-fit 找回居中；②ImageCropper Dialog 改 createPortal(document.body)——两颗 dialog 成兄弟（头像链路一直正常的形状）。cdp-shot 工具加 cookie/nav/diag2/stufffile 动作（会话注入+文件注入+命中诊断可复用）。**归档/清理：demo 诊断会话已删（sessions user1→0，恰证明重置自封也把 D56 的临时会话踢光——D56 与 D69 两轮共用同一把「踢全会话」事实）In dev** |**13ab193 一轮：dialog 居中 + portal 到 body（dev 复验：居中好了但 picker 反盖 cropper——两颗 top-layer modal 并存的层叠不可控）。**01a3b0f 二轮：改行为级——ImageUploader 新增 onCropOpenChange，cropper 打开期间 CoverPicker 把自己的 native dialog 暂时 close（React 状态不动 + suppressClose 锁 onClose），裁完/取消 showModal 收回；crop-frame 底 bg-foreground/5（contain letterbox 不再发白）。**dev 实机复验通过**（截图+digits： Picker open:false 收起、cropper 唯一 top-layer、命中可达、无白覆盖） | |
| **D70** | 「没能保存这条来源」500（编号 da414cc6…） | prod 只读日志：POST /api/v1/topics/:id/sources 撞 **ck_topic_sources_size**（23514 → common.internal 500）——size_text 的格式正则约束 + 服务端零校验直写 DB | **Lead 已修**（014d830）：用户拍板「不托管文件、大小就是普通文本」——0057 迁移 DROP 约束 + 列宽 16→64（自由文本不再触第二个 500）；ent schema 同步（MaxLen 64）；**ck_topic_sources_url 的 https 保留**（协议防线）。**已提交 014d830；dev 部署时随迁移生效** |

### 1p-production. 本轮按用户指令直接上生产（2026-10-15 23:30；用户：「没什么时间了，没发现问题就上生产」）

- 部署：prod `8414f37 → de609af`（迁移 56→**57**），deploy 全 9 步走完，备份 `/srv/sc2clud-prod/backups/pre-deploy-de609af-20261015-153035.dump`；健康 200、bin/web 版本一致、systemd active、错误日志 0。
- 后验（只读）：`ck_topic_sources_size` 已从 prod 库消失（D70 生效全网）；site/boards/topics/首页 全 200；房间目录 prod 照旧不发布（install.sh 设计：产品产物无 devroom）。
- 本轮全部 13 条（D60-D70 计 11 条 + D69/D70 补报）**同时生效于 dev 与 prod**。


<!-- 1q 起：第十三轮（D71–D75），三子代理 + Lead 收敛 -->

### 1q. 第十三轮（用户 2026-10-15 01:5x→07:4x 报五条：D71–D75；三子代理并发修复，Lead 收敛门禁）

| # | 现象 | 根因（实测证据） | 处理 |
|---|---|---|---|
| **D71** | **帖子正文不该出现在评论区**（用户：「第 0 楼只是编号安排，正文不应作为评论显示」） | posts 表里**正文本身就是 floor=1 的一行**（0004 + InsertTopicBody），`TopLevelReplies` 的 roots CTE 把 1 楼当顶层回复返回 → GET /topics/:id/posts 第一条就是正文，评论区复读主楼；且 `reply_count` 口径 floor>1，列表与计数差 1；`CreatePost` 又允许 parent 指向 1 楼（这些楼中楼挂在正文名下，摘掉正文就成孤儿） | **已修**：① 列表剔除——roots CTE 加 `AND p.floor > 1`（3dadd94，口径与 reply_count 齐平）；② 写路径重挂——parent 的 Floor==1 时**按顶层回复落库**（32c8b3e，「回复正文就是回复帖子」）；③ 历史数据回填——迁移 **0058** 把挂在 1 楼名下的旧回复改为顶层（7835423，down=有注释 no-op，照 0019 有损回滚先例）；④ 前端双保险——toComments roots 过滤 `floor !== 1` + Post 补 `floor?`（cd15122，防 Web 先上/后端未上时的时序差）；⑤ 红→绿（ca59f2b 红批：TestListPostsExcludesTopicBody / TestReplyToTopicBodyIsTopLevel；reply_list 平移楼层断言、TestReplyParentRules 列表断言 2→1） |
| **D72** | 无法撤销用户头衔 | `DELETE /admin/users/:id/titles/:titleId`、`RevokeTitle`（撤销佩戴中的后端自清 `equipped_title_id`）**自 D1 就挂好了**——是前端零调用 | **已修**（961d29f）：GrantTitleDialog 在「授予」之下列**已持有清单**（公共读 GET /users/{handle}/titles；handle=行上 username，已对 admin-types/ByUsername 核实），每行一颗 danger「撤销」走**既有** `revokeTitle` 客户端（不造第二个真源）；撤销经容器 `onRevoke` 发真请求、成功弹层自己失效 `qk.userTitles` 就地少一行、失败 errorLine 就近报；users-dialogs.test 钉 DELETE 路径与清单缩减 |
| **D73** | 无法设置帖子置顶/精华 | 后端 `POST /topics/:id/pin|feature`（perm `topic.pin`，同一权限点管两事，拍板 §10.9）**一直在线**，前端零调用 | **已修**（5723106）：lib/api 补 `setTopicPinned/setTopicFeatured`（体 `{pinned}/{featured}` 照 handler.go:430-453）；话题动作条加**置顶 / 精华**两颗 ghost 开关（active 反映详情现值，可选 props 整组不给不渲染，房间容器零改动）；routes/topic.tsx 在 `can('topic.pin')` 时挂 mutation（onSettled 失效 qk.topic，失败并入 steps 回执）。topic.test 钉：版主见两颗开关且点击经真实 api 层打到端点、非版主整组不渲染 |
| **D74** | 评论时间显示冗余（应精确到分钟） | `toComments` 把 `created_at` 原样 RFC3339 透传（线上显示 `2026-10-16T07:31:02.123+08:00`） | **已修**（66bbab4）：lib/format.ts 加 `formatMinute`（`Intl.DateTimeFormat('sv-SE', short/short)` → `2026-10-16 07:31`，Invalid Date 回空串）——「现有库」就是房内 format.ts，**零新依赖**；toComments 切过去；format.test 2 例 + mappers.test 3 例（含非法串回空、无 floor 老响应不误伤） |
| **D75** | 退出登录应移到设置页最底部并标红 | 退出按钮长在 AccountPanel（页面中部）；Ring `Button danger` 全站唯一危险色口径已有 | **已修**（b095282）：AccountPanel `onLogout` 改可选（不给且非 loggedOut **整格不画**，房间 11-profile 照传、其测试零改动）；settings.tsx 页尾新增居中 danger 按钮（`data-testid=settings-logout`）；settings.test 钉三件事：settings-logout 存在且承载块是页面根**最后一个直接子元素**、AccountPanel 区不再有原退出钮、点击打 POST /auth/logout |

**收敛门禁（Lead 在最终 HEAD 9 提交合并态复跑）**：Go `forum` 88.7s + `pgsql` 11.6s 全绿（-count=1）；web `tsc` 0、vitest 全量 **339/339**、`vite build` 过、budget（首屏 JS 177.8/180 KB、CSS 37.9/40、最大 chunk 98.7/120）、size/tokens/urls/controls/security/ui-usage/conventions 全过（size 超限仍是登记在册的 3 个：boards 565 / topic.test 655 / screens fixtures 537）。全仓 lint 有 23 条**既有**警告（only-export-components 等，不在本轮文件）——常态处理项，不入本轮门禁。
### 1q-production. 本轮按用户既定口径直接上生产（2026-10-16 08:2x）

- dev：`dep loy.ps1 dev` 一次完成（外层超时被杀，**嵌套流水线自己跑完了全部 9 步**；重跑只撞同版本防呆「pick another version」——不是失败）。health 200、bin/web 版本一致、**迁移 57→58**。
- dev 黑盒：GET /topics/{id}/posts → 列表仅有 `floor:2`（reply_count=1 同口径），`floor:1` 正文不出现在评论列表。
- prod：`de609af → 70ff692`，164.6s，迁移 57→**58**（含 0058 历史挂楼回填），备份 `/srv/sc2clud-prod/backups/pre-deploy-70ff692-20261016-001715.dump`；health 200、bin/web 版本一致、公网 / 200 即本构建、部署以来 journalctl **ERROR=0**；/topics 200、/admin/ai/events 未登录 401（既有路由+守卫健康）。
- prod 黑盒：GET /topics/{id}/posts → `floor:2 / floor:5`（无 1 楼），首条内容为用户回复。
- 权限审查（用户指派，只读）：续写 `完全重构/RBAC权限树设计.md` §9 源码实测（角色×24 权限点矩阵 / 叠加次序 / superadmin 专属 / 九条发现含 schema_check admin 期望 16→17 自检常鸣、user.mute 与 resource.publish 两个「已授不判」点）；角色定位声明按用户要求置顶：**管理员=网站辅助管理者；超级管理员=网站开发/维护/所有者**。

---

### 1r. 第十四轮（用户 2026-10-16 08:2x 提两条优化；四子代理并发，Lead 收敛）

| # | 事项 | 事实/根因 | 处理 |
|---|---|---|---|
| **D76** | **页面里的「因为 XX 设计所以 XX / 因为某文档所以怎么样」文本全部剔除**（用户点名管理页最严重） | 可见文案里混入对设计稿/方案的**引注与自证**：管理页 25 处（`d7 §3.2`、`§9.8`、`（拍板 §8.11 U2）`、`（DB §4.11）`、`（技术方案 v2 §8.2）`…），其余产品页 24 处；**后端下发的文案同样带**——`site/settings.go` 的 Hint（管理端站点设置屏每个开关下面）与已入库的 `permissions.description`（角色矩阵屏渲染） | **已剔除**：A `5b0ad69`（管理页 21 文件 66 处：ScreenHead/Panel note、Input help、KV hint、GateNote/DisabledReason、表格旁白、nav.ts 14 条、mock hint）；B `7dffdbe`（其余产品页 17 文件 24 处；**顺带修掉 17-appeal 把一行 `//` 注释当 JSX 文本渲染进页面的乱码**）；D `4839df7` + 迁移 **0059**（Hint 去引注；已入库的 topic.pin 描述用精确 UPDATE 幂等清库，不覆盖管理员手改过的值）。口径：**删引注与自证、保留功能信息**；代码注释（// 与 `{/* */}`）、`*.md`、`registry.ts`/`preview/**`（房间文档）与 `room-links.tsx`（房间专用「未做」标注）**刻意不动** |
| **D77** | **大量报错只显示编号、不显示具体原因** | 两条真根：① 前端 `client.ts` 用 `??` 接 message，**空串接不住** → 整行只剩「（错误编号 xxx）」；另有 8 处手写错误行各拼一遍（第二个真源）。② 后端 `httpx.Fail` 对未识别错误一律 `ErrInternal`，**真原因只进日志**——D70 那次 500 的真实原因是 PG check 约束 23514，用户只看到编号 | **已修**（C：34ec438/5c04b79/dd72907）：① 前端 `client.ts` 改空白兜底 + `errors.ts` 新增 `CODE_REASON`/`STATUS_REASON`/`fallbackReason`，`apiErrorLine` 正文 = message → fields 理由 → code/状态兜底（**绝不返回空**），编号恒在末尾；新增 `apiErrorLineWith` 供页面换业务正文；8 处手写处（appeal/compose/login/register/register-verify/settings/state/error-boundary）全部收编。② 后端按 SQLSTATE 归类 500 原因（23505/23503/23514/23502/22P02/40001/40P01/57014）写进 message，**code 仍 common.internal、status 仍 500**，表名/约束名/SQL 只进日志；`dbUnavailable`（pgx 连接类）→「数据库连接不可用」，**排在 isClosedConn 之前**（原先被吞成 200 空响应）；`ErrInternal` 文案补「详见服务端日志」。红→绿：web 7 条 + Go 4 条（含 D70 的 23514 场景，并断言不泄漏约束名） |

**环境事实（本轮踩到、写下来免得重踩）**：本会话 `spawnSync("node", …)` 起的是 **Harness 的 Electron**（`process.execPath` = `DeepSeek Harness.exe`）——它会**静默吃掉 vitest**（status 0、零输出），于是「vitest 全绿」可以是假绿；而 tsc/门禁脚本因为纯 Node 仍能跑出真输出。web 门禁必须用**真 node**：`C:\Program Files\nodejs\node.exe`（或 dsh 运行时 `…dependencies\node\bin\node.exe`）。子代理 B 提的 `ELECTRON_RUN_AS_NODE=1` 变体在 vitest 5 上仍失败，别用它。

**收敛门禁（Lead 用真 node / go.exe 复跑最终 HEAD）**：web `tsc` 0；vitest **346/346**（69 文件）；`vite build` 过；budget 首屏 JS **178.1/180 KB**；size（362 文件 / 3 条已登记超限）、tokens、urls、controls、security、ui-usage、conventions 全过。Go：`./internal/platform/... ./internal/site/...` 全 ok、`./internal/forum/...` 85.1s + pgsql 11.3s 全绿。
### 1r-production. 第十四轮同样直接上生产（2026-10-16 08:4x–08:5x）

- dev：`48dff12`（迁移 58→**59**），health 200、bin/web 版本一致；备份 `/srv/sc2clud-dev/backups/pre-deploy-48dff12-20261016-004459.dump`。
- prod：`70ff692 → 48dff12`，165.8s，迁移 58→**59**；备份 `/srv/sc2clud-prod/backups/pre-deploy-48dff12-20261016-004900.dump`（259724 B）；health 200、bin/web 版本一致、公网 / 200 即本构建、部署以来 journalctl **ERROR=0**，/topics 200、/admin/ai/events 未登 401。
- 双端黑盒（只读）：① `permissions.description`（topic.pin）=「置顶 / 精华（两个端点共用这一个权限点）」——**0059 在库里生效**；② **产物 JS 里「拍板」与「§」出现次数均为 0**（D76 真的进了线上包，不只是源码改了）；③ 错误信封带原因与字段：`/topics/not-a-uuid` → `参数错误` + `fields.id=格式不正确`（不再是空 message + 编号）。
- 回滚：`pg_restore --clean --if-exists -d <dsn> …/pre-deploy-48dff12-*.dump` + `current → 70ff692`。

#### 1r-addendum. D72 二轮（2026-10-16 09:1x，用户：入口改名「头衔编辑」+ 改复选框列表）

- 实现（8b0b332）：`GrantTitleDialog` → **`TitleEditDialog`**；入口按钮与弹层标题都叫**「头衔编辑」**；弹层改为一列 `Checkbox`——行 = **目录未归档 ∪ 该用户已持有**（并集，否则持有已归档头衔就永远撤不掉），`佩戴中`/`已归档` 用 Pill 标注；**勾上即 POST 授予、取消勾即 DELETE 撤销，无保存按钮**；逐行 pending 且禁用其它行，成功 `invalidateQueries(qk.userTitles)` 回服务端真值，失败 errorLine 就地报错且**不乐观翻转**。接线合并：`onGrantTitle`+`onRevokeTitle` → `onSetTitle(userId, titleId, held)`（routes/admin/users.tsx 按 held 分发）。
- 验证：真 node 下 vitest **350/350**（69 文件，净增 4 例）、tsc 0、build+budget（178.1/180 KB）+ 7 条静态门禁全过（Lead 独立复跑，非子代理自报）。
- 上线：dev `8b0b332`（备份 pre-deploy-8b0b332-20261016-012108.dump）、prod `48dff12 → 8b0b332`（165.3s，备份 pre-deploy-8b0b332-20261016-012415.dump）；双端产物含「头衔编辑」×3、旧 testid `title-revoke-` 计数 **0**；prod 部署以来 journalctl ERROR=0，DELETE 端点未登录仍 401（路由在）。
- 注：权限点显示名「发头衔」（nav.ts / audit / mock fixtures）**未改**——那是 `title.grant` 的点名，不是按钮文案。

---

### 1s. 第十五轮（用户 2026-10-16 10:3x–10:5x 连报三条；三子代理 + Lead 直修）

| # | 事项 | 事实/根因（实测） | 处理 |
|---|---|---|---|
| **D78** | 讨论帖不该开问题反馈（Issue）区 | 反馈入口与「问题反馈」页签在共用 View 里由 props 驱动，**所有 kind 一视同仁** | **已修**（c1698ec，W1）：宿主按 `kind !== 'discussion'` 决定是否传 `issueCount/issueHrefFor/feedbackHref/onOpenIssue`；`topic-view` 与 `topic-tabs` 新增**显式**开关 `issuesEnabled`（默认 true），false 时页签 + 正文末尾 nudge + 右栏 nudge 整块不画；房间一字未改（不传=现状）。红→绿：新建 `topic.issue-scope.test.tsx`（讨论帖那条给的是 `issue_open_count=7` 的非 0 值，不是「计数 0 恰好没药丸」）；全量 353 绿 |
| **D79** | **「已经手动通过的帖子编辑，帖子页面不更新」**——强制刷新也不行 | **不是缓存**（用户实测 + nginx 无 `proxy_cache`/`expires`、API 无缓存头）。库诊断抓到实据：prod 的 topics **11 / 14 / 18**、dev 的 topic **53** 的 `posts.floor=1` 是 `visibility=deleted`（内容还在：549/26/5 字）。根因链：D71 之前「正文被当评论渲染」，作者在评论区点删除 → `DeletePostRow` 把**正文行**软删（这是既有的有意行为：「1 楼只软删自己，标题还在」）；此后**两条写正文的路径都只写 `content_*`**，visibility 永远停在 deleted —— ① `UpdatePostContent`（没过审的帖直接写 posts）② `PromotePendingRevision`（已过审帖「通过再替换」）—— 所以人工/AI 明明批了，读者看到的仍是「正文已被作者删除」，作者再怎么改也救不回来 | **已修**（6fcee69，Lead 直修）：① `UpdatePostContent` 对 `floor = 1` 一并置回 `visibility='normal'`（回复不在此列，避免改稿把删掉的回复冒出来）；② `PromotePendingRevision` 放行时一并置回可见（放行改动=上台可见）；③ **迁移 0061** 修历史残留：只修「帖子本身还在、只有正文行被软删」（`t.visibility='normal'`），整帖被删的不动；down=有注释 no-op（照 0019/0058 先例）。红→绿：`body_visibility_revive_test.go` 两条（临时回退两处 SQL → red status=1；恢复 → `ok 12.296s`） |
| **D80** | **待替换改动（编辑帖子触发）不触发 AI 自动审核** | 三层：① `UpdateTopic` 编辑路径**只入队 `search.index`**，正文进了待审槽后就再没有 AI 任务（发帖那条路有 `ai.review`，注释还写着「AI 也重新看一次」）；② `aireview/sql.go` 的 `sqlSubject` 读 `posts.content_md`（**线上旧正文**），待审稿在 `pending_md` —— 与管理端预览的 `COALESCE(pending_md, content_md)` 不同源；③ `ReviewTopic` 落库不是 revision-aware：只改 `topics.review_state`，**没有**「放行草稿要替换线上正文」那一步（人工放行走 `PromotePendingRevision`）→ AI 置了 approved 改动也永不上台；④ 另需迁移把 `ck_review_events_trigger` 的 `edit` 放进来 | **修复中**（G1）：编辑入队 `ai.review`（trigger=`edit`）+ 取材改 `COALESCE(pending_md, content_md)` + `edit` 触发下**approve 真放行**（换正文/摘要/快照/清待审槽，并恢复可见）而 **reject/拿不准只写 `review_events`**，不动已发布帖的 `review_state/visibility`（原则：宁可放过不可错杀，人工队列继续接） |
| **D81** | 审核动作后帖子页不更新（前端新鲜度） | 审核动作成功后只失效了 `['admin','review']`，**没失效被审主题的详情/回复/列表**；帖子页详情 `staleTime=60_000` → 同浏览器里点完「放行」再打开帖子页拿到的是旧缓存 | **修复中**（G2）：补 `qk.topic/publicId`、`qk.posts/publicId`、`['topics']` 前缀失效 + 断言失效集合的 vitest；并先写一条 Go 回归用例把「作者编辑→待审槽→人工 approve→详情返回新版正文 + 快照/摘要同源 + 待审槽清空」钉住 |

---
## 2. 派发分组（互不重叠的文件作用域）

| 包 | 覆盖 | 主要文件 |
|---|---|---|
| **FIX-IMG** | D1 / D2 / D3 | `web/src/ui/rich/image-uploader.tsx`、`image-pipeline.ts`、`web/src/app/shell.tsx`（只读，报给 Lead）、`web/src/devroom/pages/03-navigation/**`、板块封面数据侧 |
| **FIX-TOPIC** | D4 / D5 / D6 / D7 / D8 / D9 | `web/src/devroom/pages/12-topic/**`、`13-issue/**`、`web/src/routes/{topic,issues}.tsx` |
| **FIX-MSG** | D10 / D11 | `web/src/devroom/pages/10-messages/**`、`19-search/**`、`web/src/routes/messages.tsx`、`web/src/ui/nav/**` |
| **FIX-ADMIN** | D12 / D13 / D14 / D15 | `web/src/devroom/pages/15-admin/**`、`web/src/routes/admin/**`、`web/src/ui/dev-entry.tsx`、`web/src/main.tsx` |

**Lead 专属**（子 agent 不许改，写进阻塞）：`web/src/app/router.tsx`、`app/shell.tsx`、`web/src/main.tsx`。
**每个包都必须遵守第 0 节的同源要求**，并且每条都要：先证明断言会红 → 改 View → DevRoom 出图 → 产品宿主跟着改 → 产品页出图对照。


---

## 1g. D25 / D28 / D29 的实测结论（FIX-PERM 2026-10-15）

| # | 结论 | 证据落点 |
|---|---|---|
| **D25②** ⛔**已被 D33③ 推翻（2026-10-15）** | 当时的实测结论是**图片不发**（下行是它的取证，留着当历史）；用户 2026-10-15 拍板**真做多模态**，现在配图会随审核请求发给模型（每帖 ≤4 张、单张 ≤2 MiB，超了截断并计数；判据 `forum/internal/aireview/aireview_test.go` 的 `TestOutboundPayloadCarriesImageBlocks` 与 `TestOutboundPayloadHasNoImageBlockWithoutImages`）。原结论：上行 payload 只有两段纯文本：system = 提示词、user = `标题：<t>\n\n正文：<1 楼 Markdown 源>`。图片**唯一的痕迹**是正文里的 `![alt](/img/<hash>)` 字面量——模型看不到图，审核员看到的也只是这行字。代码侧同源：`aireview/sql.go` 的 `sqlSubject` 只取 `topics.title` + `posts(floor=1).content_md`，**不 JOIN `topic_images`**；`platform/ai/ai.go` 的 `Judge` 只组 system + user 两条消息，没有任何多模态字段。 | 用例 `forum/internal/aireview/aireview_test.go` 的 `TestOutboundPayloadHasNoImageField`（逐字钉住 user 文本 + 断言两段里没有 `image_url`/`data:image`）；顺带修了这条用例逼出来的真缺陷：模型按 schema 省略非必填的 `categories` 时 `ai.parse` 返回 nil → 写 `review_events.categories`（`NOT NULL`）撞 23502，判定落不了库还反复重试 |
| **D25①** | ✅ 已做：审核屏右栏就地预览**正文全文**（不是 200 字摘要）+ 作者（昵称/@handle）+ 来源徽标；图片以 Markdown 原文可见；超上限必显示「已截断」。 | `forum/internal/forum/review_queue.go` 的 `body_md`/`body_truncated`（草稿档取 `rv.pending_md`）；`web/src/devroom/pages/15-admin/screens/review.tsx` 的 `review-preview-body`；图 `shots/fixperm/d25-review-preview.png` |
| **D28** | ✅ 已核：**只有一处偏差** —— `admin` 少 `resource.publish`（0017 种 16 个点，拍板 §1.3 要 17 个；那条迁移的注释自己写的就是 17）。后果不是「少一个勾」：管理员发 `kind=resource` 的帖子会被 403。`creator` 多出的 `topic.lock`/`topic.move` 是 d2-auth §8.6 的**明确取舍**，不是错。 | 对照表 `完全重构/进行中/D28-默认权限矩阵对照表.md`；迁移 `0052_admin_resource_publish`；判据 `forum/internal/app/role_permissions_test.go` |
| **D29** | ✅ 已做：`auth.registration.auto_activate` 成为**唯一真源**（配置值只在站点设置读不到时兜底），注册 / `/me` 回执 / 重发三条路联动；管理端补上**唯一的激活入口**（用户屏「危险动作 → 激活账号」，只写 `activated_at`）；注册页在关掉开关时落「等待管理员激活」而不是「请输入验证码」。 | 用例 `forum/internal/auth/activation_switch_test.go` 四条（先红后绿）；图 `shots/fixperm/d29-users-tall-selected.png` |
