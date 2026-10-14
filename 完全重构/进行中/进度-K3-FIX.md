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
