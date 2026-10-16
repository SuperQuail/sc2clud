# 进度 · K3-FIX（WIP 清单除屏蔽词外全补，拍板 08 第三轮）

> 作用域：`web/src/routes/{topic,issues}.tsx`、`web/src/devroom/pages/12-topic/{edit-dialog,topic-view,board-summary}.tsx`、
> `web/src/routes/_parts/mappers.ts`、`forum/internal/forum/{dto,map,topics}.go`（handler.go 归 K2-C）、
> `forum/internal/forum/pgsql/**`、`forum/internal/user/**`、`web/src/lib/api/**`。
> 交付：拍板 08 §第三轮 1–6（7/8 属图文帖与 media 口径，不在本包）。
> 迁移号：本包**不需要迁移**（0031 未占用）。

## 进度

- [x] §第三轮 1+2：主题页「关注分区」接真端点（`GET/PUT/DELETE /boards/{slug}/follow`）+ 「成员」格显真数
  - 做了什么：`routes/topic.tsx` 增 `qk.followBoard(boardSlug)` 查询与 `followBoard/unfollowBoard` 幂等变更
    （成功直接写缓存，与 `routes/board.tsx` 同款）；`designBoard` 的 `member_count`/`joined` **一律**取关注状态那一份
    （`BoardDTO` 里没有这两列，把关注数当成员数用 —— 这正是 L5「成员数因此有真数据」的口径）；
    两处过时注释（「后端还没有端点」）删掉，未登录点关注给「先登录」而不是静默 401。
  - 证据：新用例 `关注分区：成员数来自 GET /boards/{slug}/follow 的真数…` 在**旧行为**下实测红：
    `AssertionError: expected '…成员0关注分区发帖…' to contain '128'`；恢复后
    `npx vitest run src/routes/topic.test.tsx` → `Tests 9 passed (9)`。
  - 下一步：§第三轮 3（作者角色徽标要 `role`）——`forum/internal/forum/pgsql/topics.go` 的 `topicColumns` 补
    `JOIN roles` 两列 + `dto.go` 的 `UserBriefDTO` 加 `Role`，`map.go` 的 `userBriefDTO` 填它，
    然后删掉 `topic.tsx:toDesignAuthor` 那句 shortcut。
  - 阻塞：无（本包自有文件无人占用）。
- [x] §第三轮 3：作者角色徽标 —— 主题详情回 `role`（key / name / badge_color），右栏作者卡真的画出徽标
  - 做了什么：选的是**「`UserBriefDTO` 加一列」**（不是详情另开 DTO），因为后端 `UserBriefDTO` 本来就是
    详情与卡片共用的作者形状，多一个 DTO 就多一处要同步的字段表；**但只有主题详情那条查询选这三列**
    （`pgsql/topics.go` 的 `TopicDetail` 加 `JOIN roles r` + `r.key, r.name, NULLIF(r.badge_color,'')`，
    `UserRow` 的三列是 `*string`：nil = 这条路径没查，不是「这个人没有角色」）。
    列表项 / 楼层 / Issue 的作者**照旧不带 role** —— 那些地方没有徽标位，七条查询各多 join 一次角色是白花钱。
    前端：`lib/api/forum.ts` 的 `TopicAuthorSummary.role` 补 `badge_color`，`RoleBadge` 加 `data-test='role-badge'`
    （**必须是 `data-test`**：Ring 的 Tag 只认这个 prop，传 `data-testid` 会被它丢掉），
    `topic.tsx:toDesignAuthor` 删掉那句 shortcut。
  - 证据：新用例 `TestTopicDetailCarriesAuthorRole` 在改动前 `go vet` 就红
    （`detail.Author.Role undefined (type UserBriefDTO has no field or method Role)`），
    改完 `go test ./internal/forum/ -count=1 -run 'TestTopicDetailCarriesAuthorRole|TestTopicDetailAuthorRoleWithoutBadgeColor'` → `ok`；
    前端 `topic.test.tsx` 那条断言在**去掉 role 之后**实测红（`expected undefined to be '认证创作者'`），恢复后 9 passed。
  - 下一步：§第三轮 4（@ 提及候选）——**端点已经有了**：`GET /search?type=users` 就是设计稿定的候选端点
    （`user.Service.Search`，q 1–32 字、limit ≤20），而 `lib/api/user.ts` 的 `searchUsers` 也早就写好了；
    要补的是**接线**（`routes/topic.tsx` 的 `candidates={[]}` 与 `routes/issues.tsx` 的 `candidates={[]}`），
    外加一条**契约缺陷**：`user.SearchItem.ID` 现在是 `public_id`（uuid），而 `mention:` 语法与渲染链路
    （`platform/mention`、`platform/markdown`）用的是**数字 user id**（`[@昵称](mention:<user_id>)`，BodyRe 只收 \d{1,18}），
    所以候选件拿到的 id 填进去**渲染不出提及**——要么后端把这一列改成数字 id，要么候选件另取一个字段（在下一小步定）。
  - 阻塞：`gofmt -l .` 目前有两处**别人的在途文件**红（`internal/user/pgsql/queries.go`、`internal/user/service.go`
    —— K2-B 的 users.cover_hash 那一批），本包自己的文件是干净的；收工前若它们还没提交，本包的 `gofmt -l` 收尾要在进度里注明。
- [x] §第三轮 4：@ 提及候选 —— 端点**早就有**（`GET /search?type=users`，设计稿定的那个），
  本步做的是①修掉一处**候选根本不能用**的契约缺陷、②把候选接进两个 composer
  - 做了什么：
    · **契约缺陷**：`user.SearchItem.ID` 原来是 `public_id`（uuid），而提及的存储格式是
      `[@昵称](mention:<user_id>)`、`platform/mention.BodyRe` 只收 `\d{1,18}` —— 从候选里选人
      插进正文的是 `mention:<uuid>`：**存得下、渲染不出、通知也发不出去**，而两侧测试各看各的都不红。
      改成**数字 user id**（`SearchItem.ID int64`、`SearchSQL` 选 `u.id`、`SearchRow.PublicID int64`）。
      `lib/api/user.ts` 的 `SearchUser.id` 同步改 `number`；`routes/home.tsx` 那一处转发给 19-search
      设计件的地方补 `String(u.id)`（设计件的类型是展示串，与 topics 档走 toTopicRow 同一条规矩）。
    · **接线**：`MarkdownEditor` 加 `onQueryChange`（@ 之后已经打出来的那串字，**组件不认识 lib/api**，
      所以只上报、由宿主查）；`ReplyBox`/`CommentList`/`TopicComments`/`MainColumn`/`TopicView` 与
      `IssueDetail` 各加一个可选 `onMentionQuery` 往下传；宿主（`routes/topic.tsx`、`routes/issues.tsx`）
      用 `qk.search('users', q)` + `searchUsers` 取候选，`enabled: q !== ''`（**后端对空词回 400**，
      而「敲了 @ 还没打一个字」是最常见的一瞬间），两个页面各有一个 `toMentionCandidates` 把
      `id/handle/nickname/avatar/ambiguous` 映射成候选件（ambiguous → duplicate）。
  - 证据：后端新用例 `TestSearchCandidatesCarryNumericMentionID`（`forum/internal/user/mention_search_test.go`）
    改前**编译即红**（`items[0].ID != wantID (mismatched types string and int64)`），改后
    `go test ./internal/user/ -count=1` → `ok`；它的判据是**端到端**的：拿候选的 ID 拼一条
    `[@昵称](mention:<id>)` 再交给 `mention.Parse`，必须取回同一个人（只断言 wantID 证明不了「这条 ID 能用」）。
    前端 `topic.test.tsx` 新用例断言「没敲 @ 不发查询」，把 `enabled` 临时改成 `true` 实测红
    （`expected "vi.fn()" to not be called at all, but actually been called 1 times`），恢复后绿；
    全量 `npx vitest run` → **37 文件 / 187 用例全绿**，`pnpm typecheck` 0 错、`pnpm lint` 0 错 22 警。
  - 下一步：§第三轮 5（编辑正文换 `MarkdownEditor`）——`12-topic/edit-dialog.tsx` 现在是纯文本 `Input`，
    而 `MarkdownEditor` 吃的是 `content_md`（Lexical JSON，`compose.tsx` 就是这个用法），
    而 `topic-view.tsx` 现在传给弹层的是 `toText(topic.content_html)` —— 要改成传 `content_md`
    并把回执字段从 `text` 改成 `json`（`PATCH /topics/{id}` 的 `content_md` 就是它）。
  - 阻塞：无。
- [x] §第三轮 5：编辑正文换成 `MarkdownEditor`（不再是纯文本框）
  - 选了哪条路：**详情必须带上 `content_md`**（Lexical EditorState 的 JSON，后端字段名就是它）——
    弹层把它灌进编辑器，改完把 `json` 原样发回 `PATCH /topics/{id}` 的 `content_md`（与发帖页同一个字段）。
    原来那一路（`topic-view.tsx` 的 `toText(content_html)` 剥标签 → 纯文本 → `text`）会丢提及的 userId
    与图片节点，而且与「后端存的是 JSON」这件事对不上。
    做了：`12-topic/types.ts` 的 `TopicDetail` 增 `content_md`（真源）· `edit-dialog.tsx` 重写成
    `MarkdownEditor`（标题仍 `Input`，保存回 `{title,json,html}`）· `topic-view.tsx` 改传 `contentMd` +
    删掉死掉的 `toText` · `routes/topic.tsx` 的 `save` 发 `content_md: next.json` · 房间 `index.tsx` 同步维护
    `bodyMd/bodyHtml` 两份状态（保存后**再开一次编辑框**要看到新正文）。
  - **顺带修掉一条会抛在用户脸上的缺陷**：`MarkdownEditor` 的 InitialState 对坏 JSON 是直接抛的，
    而 `content_md` 是历史列（老站迁过来的是 Markdown 纯文本）—— 真站上一次编辑就崩。
    `edit-dialog.tsx` 的 `toEditorState` 只做两条：本来就是 EditorState 就原样用；否则把整段文本**保住**、
    包成一个最小文档（`shortcut:` 已标注：纯文本只按段落折行，能认格式的是真源那份 JSON）。
  - 证据：`topic-view.test.tsx` 那条改成查 `[contenteditable][data-placeholder]`（旧版这里是 textarea）+
    断言回执 `json` 里含原文；`toEditorState` 单测两条（JSON 原样 / 纯文本不丢）。
    `routes/topic.test.tsx` 的 B6 改成断言 PATCH 体里的 `content_md` **是 JSON 且含 WIRE 的正文**，
    把 `save` 临时换回写死正文时实测红。全量 `npx vitest run` → **37 文件 / 189 用例绿**。
- [x] §第三轮 6：`review_pending_human` 要能出来（**选了「按现有数据推」**）
  - 选了哪条与为什么：**不加列、不改迁移**，判据取 `review_events` **最新一条判定的 verdict = 'review'`**
    （d7 §1 状态机的第三种结论就是「AI 拿不准 → 人工队列」，而 `review_events` 已经逐次记下了它）。
    为什么不加字段：那需要在 AI 判定、举报转人工、人工判定三条写路径上都记得维护一个布尔列
    （任何一条漏写就永远错），而这条信息**已经完整存在**于事件表里。
    **一个关键取舍**：判据是「最新一条」，不是「存在过 verdict=review」——后者在人工判完之后永远为真，
    横幅会一直说「已转人工」。实测两种写法在当前用例上分得出高下（见证据）。
    只在 `pending` 时有意义，所以前端那档文案只在 pending 分支读它；字段本身在非作者视角恒 false
    （与 review_note 同一条口径：别人根本收不到 pending 的帖）。
  - 做了什么：`pgsql/topics.go` 的 `TopicDetail` 加一条标量子查询 + `TopicDetailRow.ReviewPendingHuman`；
    `dto.go` 加 `ReviewPendingHuman bool \`json:"review_pending_human"\``；`map.go` 里与正文那一支
    用**同一对判据**（作者 / canSeePending）；`routes/topic.tsx` 的 `TopicWire` 与 `toReview` 接上（删掉 shortcut）。
  - 证据：新用例 `TestTopicDetailReportsPendingHumanFromLatestReviewEvent`
    （`forum/internal/forum/review_pending_human_test.go`）三段：没事件=false → verdict=review 后=true
    （并断言 JSON 键 `review_pending_human`）→ 人工 approve 之后**回到 false**。
    把 SQL 换成「存在过 verdict=review」后实测第三段红：`人工已经判过了，仍报 pendingHuman=true`。
    前端新用例在 `pendingHuman: false` 的旧行为下实测红
    （`expected '这篇正在审核中…正在自动检查…' to contain '已转人工'`）。
- [x] 渲染验收（出图并看图）：`web/scripts/shoot-k3fix.ts`（CDP 直连 headless Chrome，端口 9444，自己起的自己关）
  拍 8 张进 `shots/k3fix/`，**逐张看过**：`topic-default-1440`（成员 128 真数 + 角色徽标「管理员」）、
  `topic-followed-1440`（已关注 + 成员 129）、`topic-default-390`（窄屏整页）、
  `topic-mention-menu-1440`（@ 候选菜单里真有「示范管理员」一行）、`topic-edit-dialog-1440`（MarkdownEditor +
  工具栏 + content_md 灌进来的两段正文）、`topic-edit-invalid-1440`（标题清空 → 「标题至少 4 个字」）、
  `topic-edit-dialog-390`、`topic-pending-human-1440`（「已转人工审核」那一套文案）。
  图里左下角有 `MARKER-PRODUCT-LOGIN /t/tp-1`（product.html 入口自己插的可见标记）——证明拍的是当前源码。
  出图时另外修了桩的三处（都写进了注释）：`POST/PATCH` 的板计数不能是 0（左栏会显示「0 帖子」）、
  `/search?type=users` 的条目必须是 **SearchItem**（数字 id + level + ambiguous，不是 UserBriefDTO）、
  `current_md` 要有真内容（否则拍到的是空编辑器）。
  - 下一步：本包 1–6 全部落地。§第三轮 7（图文帖配图可见性）与 8（`VisibilityLogin` 死档）属 media 域的
    图文帖整块，不在本包作用域（见 08 拍板第三轮的最后两条）。
  - 阻塞：`gofmt -l .` 收尾时若仍有 `internal/user/{service,pgsql/queries}.go`，那是 K2-B 在途（本包文件干净）；
    `pnpm lint` 有 22 条**既有** warning（0 error），都不是本包引入。
