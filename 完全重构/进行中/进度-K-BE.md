# 进度 · K-BE（forum 后端大件）

> 作用域：`forum/internal/forum/**`、`forum/internal/authz/**`、`forum/migrations/postgres/**`、本文件。
> 依据：`08-拍板记录.md`（用户拍板）+ `07-一次性完工交接单.md`（环境/协议/陷阱）。
> 基线：`pnpm typecheck && pnpm lint && npx vitest run` 绿；`go test ./...` 34 包绿。

## ⚠️ 迁移编号（写给 Lead）

| 号 | 文件 | 归属 |
|---|---|---|
| 0023 | `0023_moderator_to_creator` | **K-BE（J1）** |
| 0023 | `0023_boards_public_id` | 并发施工的另一位（C2）**撞号** |
| 0024 | `0024_board_moderator_grown` | 另一位（C2） |
| 0025 | `0025_topics_hot` | **K-BE（L2）** |
| 0026 | `0026_issue_kinds` | **K-BE（J6）** |
| 0027 | `0027_board_reply_level` | **K-BE（E1）** |
| 0028 | `0028_topic_revisions` | **K-BE（L6）** |
| 0040 | `0040_follows` | 另一位（L5） |

- 两个 0023 靠**文件名**区分（迁移器与测试台都按文件名排序跑），**不冲突**，但读号段的人会以为撞了。
- 我的号段是 0030–0039 而实际占了 0023/0025–0028：0022 之后的下一个空号就是 0023，**跳号会让
  `ls` 里出现一段谁也说不清的空洞**。下一批要加迁移的话接 **0029**。

## 队列

- [x] J1 `moderator` → `creator`（自动迁移 + 文档口径）
- [x] J3 点踩数据只对管理员及以上与发布者下发
- [x] J4 `reply_count` 含楼中楼（写死口径 + 用例）
- [x] J6 Issue 类型值域数据驱动（不做封闭枚举）
- [x] J7 §3.3 五个字段核实
- [x] J8 能关 Issue 的人 = 作者/版主/管理员及以上/Issue 发布者
- [x] J9 `cover_width` / `cover_height`
- [x] L2 最热排序 `score=(like_count+3*顶层评论数)*time_boost`
- [x] L6 「打回修改」独立状态 + 最后过审版本
- [x] E1 回帖门槛（两档）+ 数据迁移
- [x] C9-1/C9-2 `{titleId}` 进闸（同类 {id} 统一成 400）；C9-3 中间件顺序（未登录非 uuid → 401）
- [x] J5 Issue 检索与筛选完整实现
- [x] M5 审核通知 dedup 修复有效性验证
- [x] L10 + E3 老站功能清单逐条核对（只写文档）
- [ ] C9-2 剩余：`auth` / `notify` / `appeal` 三域的同类 `{id}` 核实

## 收工验证（三批提交之后）

- `gofmt -l .` → **空**
- `go vet ./...` → **0 输出**
- `go test ./internal/forum/ ./internal/auth/ ./internal/title/ ./internal/reward/ ./internal/notify/ ./internal/appeal/ ./internal/app/ ./internal/site/ -count=1`
  → **8 个包全 ok**（forum 80.6s / auth 72.5s / title 30.6s / reward 51.5s / notify 54.7s /
  appeal 12.9s / app 15.2s / site 26.1s）
- 提交：`4ccb811`（第一批）、`01df68a`（第二批）、`2656e44`（第三批）

## 记录

### J1 · `moderator` → `creator`

- [x] 迁移 `0023_moderator_to_creator`（.up/.down）+ 会红用例；`论坛后端技术方案-v2.md §9.8` 的角色表按 J1 改写
  - 证据：`go test ./internal/forum/ -run TestMigrationModeratorBecomesCreator -count=1 -v` → `--- PASS`。
    判据三条：moderator 行没了、它的用户改挂 creator、它的权限矩阵并进 creator —— 旧行为下都不成立
    （旧库根本没有这条迁移）。
  - 下一步：无。
  - 阻塞：无。**范围限定**：0017 只种 user/creator/admin/superadmin，所以本迁移收的是**自定义角色**那一路；
    旧站没有 moderator 角色，故无数据回填。

### J4 / J7 / J9 · 三条「核实 + 补」的收口

- [x] J4 口径写死在 `pgsql.RecountTopic`（`floor > 1` = 含楼中楼）+`TestReplyCountIncludesNestedReplies`；
      J7 `TestIssueCardCarriesTheFiveRequiredFields` 数 JSON 键；J9 详情页补 `cover_hash/width/height`
  - 证据：三条 `--- PASS`。
    **诚实记下**：J4 与 J7 原本就是对的，所以那两条断言在旧行为下也绿 —— 它们是**防漂移哨兵**；
    J9 那条不是：详情页的 `CoverWidth/CoverHeight` 在改之前恒为 0（详情扫描漏赋值，实测）。
  - 下一步：无。
  - 阻塞：无。

### L2 · 最热排序（方案写在这里）

- [x] 迁移 `0025_topics_hot`（`topics.last_interaction_at` + 回填 + `idx_topics_hot`）；
      `pgsql.hotScoreSQL` 是 score 的**唯一**实现；`SortHot` 分支；`forum/cursor.go` 的
      `hotCursor`/`hotPageCursor`/`hotNextCursor`；四类写路径维护互动时间
  - 证据：`TestHotSortWeightsCommentsThreeTimesLikes` / `...CountsOnlyTopLevelComments` /
    `...GivesRecentInteractionAOneAndAHalfBoost` / `...CursorPagesWithoutGapsOrDupes` 四条 `--- PASS`。
  - **游标方案（用户要求写清）**：
    ```
    旧: (排序列, id) < ($k::timestamptz, $id)       —— 键必须是时间列
    新: score < $k::numeric OR (score = $k AND id < $id)
        游标 = base64url(JSON{k: 分数串, id})        —— 键由服务端算好，客户端不能推
    排序表达式只写一遍（col 同时进 SELECT 与 ORDER BY），游标值取自**那一行**。
    ```
    为什么不能沿用时间戳：`score` 不是时间，而且它随 `now()` 变（1.5 倍增益按「一周内」算）。
    `now()` 不是 IMMUTABLE，**进不了索引表达式** —— 所以 `idx_topics_hot` 服务的是
    「按互动时间取候选 / 归档」，排序本身仍是全排序（主题万级、一页 20 条；
    代码里标了 `shortcut:` 与升级条件）。
  - 下一步：前端 `sort=hot` 接线（`web/**` 不在我作用域）。
  - 阻塞：无。

### J6 / J8 · Issue 的类型值域与关闭权

- [x] J6 迁移 `0026_issue_kinds`（值域表 + CHECK 换外键）+ `IssueKindExists`/`IssueKinds`；
      J8 `canCloseIssue`（四条判据与 `canLockTopic` 共用一个实现），**并修掉压死它的路由级权限点**
  - 证据：`TestIssueKindIsDataDriven` / `TestWhoCanCloseAnIssue` `--- PASS`。
    J6 判据：插一行就能用、能当筛选项、archived 之后不再收新的；
    J8 四条各一断言，其中「**Issue 发布者**（不是主题作者）能关」在旧行为下是 403。
  - 下一步：前端接 `GET /api/v1/issues/kinds`。
  - 阻塞：无。**顺带修的 bug**：`PATCH /issues/{id}` 的**路由级** `perm(topic.edit.own)` 让
    「持 topic.lock 的管理员关不掉 Issue」（403），与 J8 直接冲突 —— 该中间件已撤，四档判定全在 service。

### E1 · 回帖门槛（两档）

- [x] 迁移 `0027_board_reply_level`（`boards.min_reply_level` + 回填 + CHECK）；
      `canSpeak` 按 action 取对应那一档；`checkMinLevel` 文案分「发帖 / 回帖」；`BoardDTO.min_reply_level`
- [x] 测试台 `seedBoardReply`（`seedBoard` 成了两档同值的简写，既有用例语义不变）
  - 证据：`TestBoardReplyLevelIsSeparateFromPostLevel` / `TestReplyLevelUsesItsOwnCode` `--- PASS`。
    判据：发帖门槛 5 的分区里等级 2 **回帖放行**（旧行为必 403）；回帖门槛 10 的分区里等级 9
    **发得动回不动**，且文案是「回帖」。
  - 下一步：后台分区屏加这一档输入（写路径在 C2 那位手里；`BoardDTO` 已带上新列）。
  - 阻塞：无。**数据迁移口径**：老站只留下发帖门槛一档，回帖门槛回填成**同值**（保守，行为逐字不变）。

### C9-1 / C9-2 / C9-3 · 路径闸与中间件顺序

- [x] forum：路径闸拆成「读组一把挂 + 写路由挂在 requireLogin/perm **之后**」；`w()` 把路径闸
      做成位置参数（漏写即参数个数不对，不再是「忘了一行」）
- [x] title：`{titleId}` 进闸（C9-1 的「同类 {id} 统一成 400」）——挂闸前它靠 service 的
      `checkPublicID` 兜成 404，「格式错」被说成「找不到」
- [x] reward：顺序用例按新口径拆成两条（未登录 401 / 登录后 400）
  - 证据：`TestWritePathChecksIdentityBeforePathID`（forum）、`TestNonUUIDPathIDIsBadRequest`（title 两条路由）、
    `TestNonUUIDPathIDNeedsIdentityFirst` + `TestNonUUIDPathIDIsBadRequestOnceAuthed`（reward）全 `--- PASS`。
    forum 那条的三个断言缺一不可：未登录 401（**旧顺序下是 400**）、登录后 400、公开读 400。
  - 下一步：`auth` / `notify` / `appeal` 三域的同类 `{id}` 逐个核实（C9-2 的剩余）。
  - 阻塞：无。

### J3 · 点踩数据的信任边界

- [x] DTO 的 `dislike_count` 加 `omitempty`（等于「不下发」，不是「下发一个 0」）；
      `Service.ShowDislikeCount`（管理员及以上 = `topic.delete.any`，**不比较角色字符串**）；
      列表 / 详情 / 楼中楼 / Issue 评论 / 投票响应各按「全局那一半 ∪ 内容归属」判
  - 证据：`TestDislikeCountOnlyReachesAdminsAndAuthors` `--- PASS`。判据是**序列化之后的 JSON 里有没有那个键**：
    游客与普通用户没有、管理员有（且是真的数 5）、作者对自己的内容有、投票响应同一个边界，
    同时 `my_vote` 仍是单值 `-1/0/1`。
  - 下一步：前端把「踩」的显示按「字段在不在」分支（`web/**` 不在我作用域）。
  - 阻塞：无。

### L6 · 「打回修改」独立状态

- [x] 迁移 `0028_topic_revisions`：第四态 `revision_requested`（`ck_topics_review_state`）、
      `review_events.verdict` 同步加值、`topic_revisions` 表（一帖一份）；
      `ReviewRequestRevision` 动作（必须写理由）+ 队列第四档；
      `TopicDetailDTO.RevisionOf`（`content_md/content_html/approved_at`）
  - 证据：`TestRevisionRequestedKeepsOnlyAuthorAndShowsApprovedVersion` /
    `TestRequestRevisionNeedsAReason` / `TestApprovingAnApprovedTopicSnapshotsTheRevision` /
    `TestSnapshotIsNotTakenForANeverApprovedTopic` 全 `--- PASS`。
    四条口径各一条判据：打回是**独立状态**（不是 rejected）；打回期间**别人 404、作者可见可编辑**；
    作者拿到 `revision_of` = 上一份过审内容（**没有** revision_of 的时候不造假）；
    快照只在「放行一个此前过审过的主题」时写，且**写下就不覆盖**。
  - 下一步：前端作者侧横幅按 `review_state === 'revision_requested'` 分支并显示 `revision_of`；
    后台审核屏加第四档（`state=revision_requested`）。
  - 阻塞：无。**两处踩过的坑记下来**：① `verdict` 是**状态名**不是动作名
    （`request_revision` 写进 `review_events` 会撞 CHECK 23514 整条回滚）；② 打回期间**只有作者可见**，
    所以「替别人把正文换成过审版本」那一支是**死代码**（别人拿到的是 404），已删掉不写。

### J5 · Issue 检索与筛选（完整实现）

- [x] `?q=`（标题 + 正文字面匹配，**不分词** → 中文两字词天然命中）、`?sort=old`（最早）、
      `?sort=new`（= created 的别名）；`q` 的 LIKE 通配符（\% \_ \\）与超长串一律 400；
      跨主题聚合列表（`GET /api/v1/issues`，本来就在）+ 单主题列表同参数
  - 证据：`TestIssueSearchAndFilters` / `TestIssueSearchGuards` `--- PASS`。
    判据：中文两字词命中**正文**（标题里没有那两个字）、q 也能搜标题、q+kind 组合、
    status/author 筛选、`sort=comments` 把评论最多的排第一、`sort=old` 把最早创建的排第一、
    `new`/`created` 同义。旧行为下 `q` 与 `sort=old` 都不存在。
  - 下一步：前端把 `?q=`/`?sort=old` 接上（`web/**` 不在我作用域）；
    L9 的「命中高亮」还需要 `TopicCardDTO` 的命中片段字段（缺契约，未做）。
  - 阻塞：无。**顺带修掉两个从没被跑到的缺陷**：
    ① `sort=comments` 的 SQL 用恒真游标却没引用 `$6/$7` → pgx 定不出类型（42P18）；
    ② 一旦改成引用，**升序**（新的 sort=old）的第一页哨兵取 9999 会让它恒假、返回零行 ——
    升序要用最小哨兵（`sentinelTimeAsc`）。两条都只有用例能发现。

### M5 · 审核通知的 dedup 取舍（验证）

- [x] `TestReviewNotificationCarriesNoDedupAndKeepsBothVerdicts`：在**入队这一侧**钉住那个取舍
  - 证据：`--- PASS`。三条判据：两次判定投**两条** `notify:review` 任务、两条任务**都不带 UniqueKey**、
    两条 payload 各自带**判定那一刻**的 `state`/`text`（第一条必须是 rejected + 理由）。
    「作者收到几条」的落库闭环在 notify 包（`TestNotifyReviewKeepsBothVerdicts`，早已存在且绿）——
    两处各证明自己那一半：队列层不吃掉第二条、DB 层不写 dedup_key。
  - 下一步：无。
  - 阻塞：无。

### L10 + E3 · 老站功能清单逐条核对（只写文档）

- [x] 往 `完全重构/原项目功能清单.md` 追加 §18「逐条核对校对（2026-10-14）」：
      已实现（22 条，逐条给出现状落点）/ 要迁（5 条，含归谁）/ 本次新增（5 条）/
      不迁（8 条，逐条写为什么）/ E3 的 `site_texts` 13 键核验 / 留给 Lead 的两个口径
  - 证据：`完全重构/原项目功能清单.md` 第 275 行起（`## 18.`）；
    **不改动上文的覆盖列** —— 那是历史上「设计稿 vs 老站」的判断，改了就没法回看当时的结论。
  - 下一步：留给 Lead 的两个口径 —— ① 老站「编辑先不动原帖、通过再替换」要不要完全等价；
    ② 个人「变动日志」页做还是不做（别留在中间态）。
  - 阻塞：无。**结论摘要**：`site_texts` 这张**键值表不迁**（它把类型责任推给读的人），
    但它的每个键都有强类型落点（AI 配置 → `ai_config`；邮件节流 → `mail_quota`；站点文案 → `site_settings`）。
