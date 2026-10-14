# 进度 · K2-C（6.2 编辑不动过审替换 + J6 挂路由 + L6 后台侧）

- [x] 后端：6.2「编辑不动原帖、通过再替换」+ J6 挂路由 `GET /issues/kinds`（迁移 0029）
  - 证据：
    - `gofmt -l internal/forum/` 空；`go vet ./internal/forum/...` 0；
      `go test ./internal/forum/ -count=1` 只剩一条**别人的在途红**：
      `TestUpdateBoardCoverHashDistinguishesAbsentFromClear`（壁纸替换那条线，工作区里
      `admin_boards_write.go`/`admin_boards_test.go` 是别人未提交的改动，我一个字节没碰）。
    - 新用例 `TestEditingKeepsTheApprovedPostLive`：作者改完 → `posts` 仍是 V1、
      `topic_revisions.pending_md` 是 V2、**读者读到的仍是 V1**（旧行为下这一句就是红的：
      改动直接写 posts，读者立刻看到未过审的新正文）、放行后 posts=V2 且待审槽清空。
    - `TestDraftQueueScopeShowsEditsAwaitingReplacement`：队列 `state=draft` 只出
      「已发布 + 有改动」那一条，替换后空；pending 档不重叠。
    - `TestIssueKindsRouteIsPublicAndCarriesNames`：游客 `GET /api/v1/issues/kinds` 200，
      四个取值带 name；插一行 `issue_kinds` 立刻出现在响应里（旧行为下这条路由不存在 →
      落进 `/issues/:id` 通配段 → "kinds" 不是 uuid → 400）。
  - 下一步：前端三件 —— ① `web/src/devroom/pages/15-admin/screens/review.tsx` 加
    `draft` + `revision_requested` 两档 tab 与 `request_revision` 动作；
    ② `routes/admin/review.tsx` 传动作与筛选；③ `topic.tsx` 认 `pending_draft`。
  - 阻塞：无

## 这一版的三份正文 / 谁在什么时候看到哪一版（拍板 08 第二轮 · 6.2）

**存储**（一帖一行，迁移 0029 给 0028 的表加的三个待审槽列）：

| 位置 | 是什么 | 谁写它 |
|---|---|---|
| `posts.content_md`（floor=1） | **线上版本** —— 读者看到的唯一来源 | 只在**放行**那一刻被替换 |
| `topic_revisions.content_md` | 线上版本的快照（`approved_at` = 它什么时候被批准） | 首次批准 / 放行一份草稿 |
| `topic_revisions.pending_md` | **待审版本** —— 作者改完还没过审的那一份 | 作者/管理员改正文（`UpdateTopic`） |

**读者**：

- 帖子的 `review_state='approved'` 期间**永远**读 `posts` 那一份。作者改稿**不动** `review_state`、
  不动 `posts`、不动 `excerpt`、不动 `last_reply_at` —— 所以帖子留在公开流里（不像以前那样一改就消失），
  未过审的改动一个字都不下发。
- `review_state='revision_requested'`（打回修改）期间读者拿 **404**：打回的是改动，但帖子本身回到了
  「等人重判」的状态（拍板 08 · L6 的「期间只有作者可见」）。作者那一版存在待审槽里，不丢。
- `content_md` 里换草稿的判据是 `r.Author.ID == viewer || canSeePending`（map.go）——
  **归属**判定，不是权限点。审核员走 `canSeePending` 那一支（他要判的就是这份改动）。

**作者**：拿到 `content_md` = 自己改的那一版（待审槽）+ `pending_draft: true`，
并额外拿到 `revision_of` = 线上那一版（参照物）。从没过审的新帖没有待审槽，走老路（正文直接进 `posts`）。

**审核员**：`state=draft` 那一档列出「已发布 + 有未过审改动」的帖（队列 SQL 唯一的 approved 档）；
放行 = `PromotePendingRevision`：`posts` 换正文 + `excerpt` 一起换 + 快照行换成同一份 + 清空待审槽，
`topics.updated_at`（内容版本号）与之同步，判定与替换同事务。
