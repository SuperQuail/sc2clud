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

### ⚠️ 待用户拍板：左栏还显不显示「今日 N」
左栏行现在是 BoardRail 的形状（**封面 + 名称 + 帖子数**，单行），**不再显示「今日 N」**——
因为全站只剩这一份分区列表，而首页与分区页的左栏本来就没有「今日 N」。
要保留就得给 `BoardSummary` 加字段（会同时改首页与分区页的左栏）。**等用户一句话**。

### 并发记账（工具层教训）
FIX-COVER staging 之后、commit 之前，**索引被并发的 `git reset` 清空过一次**（reflog 里是 D25 留的 `reset: moving to HEAD`）——
第一次提交只带上了进度文件，它自己用 `git reset --soft` 重新合成。**多 agent 同时提交时，`git reset` 是危险动作**：
它清的不只是自己的索引。结论：子 agent 只准用 `git add <明确路径>` + `git commit`，**不许用 `git reset`/`git stash`/`git checkout --`（Lead 专属）**。
另：它的 `12-topic/topic-view.tsx` 19 行被 D22 的提交卷进去了（对方 add 范围偏大），内容没丢，只是归属错位。

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
