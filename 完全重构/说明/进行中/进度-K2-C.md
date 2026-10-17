# 进度 · K2-C（6.2 编辑不动过审替换 + J6 挂路由 + L6 后台侧）

- [x] 后端：6.2「编辑不动原帖、通过再替换」+ J6 挂路由 `GET /issues/kinds`（迁移 0029）—— 提交 `d019c4e`
  - 证据：`gofmt -l internal/forum/` 空；`go vet ./internal/forum/...` 0；`go test ./internal/forum/ -count=1`
    只剩**别人的在途红** `TestUpdateBoardCoverHashDistinguishesAbsentFromClear`（壁纸替换那条线，
    `admin_boards_write.go`/`admin_boards_test.go` 是别人未提交的改动，我一个字节没碰）。
    新用例见下表的「会红」一栏。
  - 下一步：无（前端两件已在第二个提交里做完）
  - 阻塞：无

- [x] L6 后台侧 + 06.2 的队列闭环：队列加 `state=draft`，审核屏两档 tab + `request_revision` 动作 —— 提交 `b6cc1ac`
  - 证据：
    - `review.test.tsx` 四条：打回发的是 `request_revision`（不是 reject，且理由必填）、
      draft 行可放行且文案「放行改动」、五个档位都能切、打回态行三个动作都在；
    - `npx vitest run` **36 文件 / 184 用例绿**（我这轮新增 4 条）；
    - 出图 5 张（`shots/k2c/`，脚本 `web/scripts/shoot-k2c.ts`，连跑两次 0 失败）：待审档 / 待替换改动档 /
      打回修改档 / 打回确认弹层 / 390 窄屏。**看图确认**：第五个档位与三颗动作按钮真的画出来了，
      弹层文案「打回后是独立状态（revision_requested，不是拒绝）」在图上；
    - 出图台三个坑（写在脚本注释里）：① `base` 传成含 `admin.html` 的地址 → 拼成
      `/admin.html/admin.html?…` → SPA fallback → 拍到一张产品的 404（图上看着像「没这屏」）；
      ② 出图入口要用 `vite.preview.config.ts`（不带它 `/admin.html` 落进 SPA fallback，拍到的是产品首页）；
      ③ 端口 5299 上另有别人的 vite 只绑了 `[::1]`，Chrome 走 127.0.0.1 会打到另一个实例 ——
      出图台一律 `--host 127.0.0.1` + 显式写 IP。
  - 下一步：无
  - 阻塞：无

## 这一版的三份正文 / 谁在什么时候看到哪一版（拍板 08 第二轮 · 6.2）

**存储**（一帖一行，迁移 0029 给 0028 的表加了待审槽三列）：

| 位置 | 是什么 | 谁写它 |
|---|---|---|
| `posts.content_md`（floor=1） | **线上版本** —— 读者看到的唯一来源 | 只在**放行**那一刻被替换 |
| `topic_revisions.content_md` | 线上版本的快照（`approved_at` = 它什么时候被批准） | 首次批准 / 放行一份草稿 |
| `topic_revisions.pending_md` | **待审版本** —— 作者改完还没过审的那一份 | 作者/管理员改正文（`UpdateTopic`） |

**读者**：

- 帖子的 `review_state='approved'` 期间**永远**读 `posts` 那一份。作者改稿**不动** `review_state`、
  不动 `posts`、不动 `excerpt`、不动 `last_reply_at` —— 帖子留在公开流里（不像以前那样一改就消失），
  未过审的改动一个字都不下发。
- `review_state='revision_requested'`（打回修改）期间读者拿 **404**：打回的是改动，但帖子本身回到了
  「等人重判」的状态（拍板 08 · L6 的「期间只有作者可见」）。作者那一版存在待审槽里，不丢。
- `content_md` 里换草稿的判据是 `r.Author.ID == viewer || canSeePending`（map.go）——
  **归属**判定，不是权限点。审核员走 `canSeePending` 那一支（他要判的就是这份改动）。

**作者**：拿到 `content_md` = 自己改的那一版（待审槽）+ `pending_draft: true`，
并额外拿到 `revision_of` = 线上那一版（参照物）。从没过审的新帖没有待审槽，走老路（正文直接进 `posts`）。

**审核员**：`state=draft` 那一档列出「已发布 + 有未过审改动」的帖（队列 SQL 唯一的 approved 档 ——
它是**作用域名**，不是 review_state 的值）；放行 = `PromotePendingRevision`：`posts` 换正文 +
`excerpt` 一起换 + 快照行换成同一份 + 清空待审槽，`topics.updated_at`（内容版本号）与之同步，
判定与替换同事务。打回态放行同一路径，状态一并回 approved。

## 会红证据（每条都先确认过旧行为下失败）

| 用例 | 旧行为下怎么红 |
|---|---|
| `TestEditingKeepsTheApprovedPostLive` | 作者一保存，读者读到的就是**未过审的新正文**（改动直接写 posts） |
| `TestDraftQueueScopeShowsEditsAwaitingReplacement` | 队列没有 `draft` 这一档（档位白名单只有 pending/rejected/revision_requested/all） |
| `TestIssueKindsRouteIsPublicAndCarriesNames` | 路由不存在 → 落进 `/issues/:id` 通配段 → "kinds" 不是 uuid → 400 |
| `review.test.tsx` 第 1 条 | `reviewTopic` 的动作只有 `approve \| reject`，打回传不过去 |
| `review.test.tsx` 第 2 条 | 旧判据「只有 pending 能判」会把 draft 行（approved）全部禁掉 |

## 交接给别人 / 下一个人该知道的

1. **J6 的路由已挂**（`GET /api/v1/issues/kinds`，游客可读，返回 `{data:[{key,name}],next_cursor:null}`）。
   `13-issue` 的新建入口与筛选下拉**还没有接它**（不在我的文件作用域内）—— 谁接谁把写死的四类删掉。
2. **审核队列的状态机口径**：`review_state` 四值；`draft` 是作用域名。前端的「全部未通过」档
   (`state=all`) **不含** draft 的行（它们在 approved 上），要看未过审的改动得点「待替换改动」。
3. **map.go 的 `revision_of` 语义变了**：以前只在打回态给，现在「有待审改动」就给（打回态与
   pending 态都给）。`topic.tsx` 的 `toReview()` 是照旧判空，所以不用改；但**文案要跟上**
   （「最后过审版本」现在也意味着「读者此刻正在看的那一版」）。
4. **`topic_revisions.pending_*` 三列同生同死**（迁移 0029 的 CHECK）：只写一半会让
   「有没有待审版本」的判据与渲染对不上。
5. **收工时的实测（2026-10-14 18:4x）**：`gofmt -l .` 空、`go vet ./...` 0、
   `go test ./internal/forum/ -count=1` **ok 80.4s**（含我全部新用例）、
   `npx vitest run` **37 文件 / 187 用例全绿**。
   中途有两次整包失败都是**别人在途**：`admin_boards_write.go` 引用了还没落地的
   `s.incBoardCover`（verify 时红、几分钟后他们补上 `deps.go` 就绿了），
   以及 `12-topic/types.ts` 给 `TopicDetail` 加了必填 `content_md` 但调用方还没跟完。
   **都不在我的改动上，也没有一个字节是我碰的**（我的提交只含 16 + 4 个文件，见两个 commit）。
