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
