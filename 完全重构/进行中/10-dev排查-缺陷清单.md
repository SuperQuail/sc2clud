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
