# 进度 · K2-B（封面 / 壁纸替换，拍板 08 第二轮）

> 作用域：`forum/internal/forum/admin_boards_write.go`、`forum/internal/forum/**`（只碰封面/背景相关）、
> `web/src/devroom/pages/15-admin/screens/boards.tsx`、`web/src/routes/admin/**`、`web/src/routes/profile.tsx`、
> `web/src/routes/settings.tsx`、`web/src/lib/api/{admin,user}.ts`。
> 迁移号：Lead 点名 **0030**（0029 被 L6 的 `topic_revisions_pending` 先占）。

## 进度

- [x] 修「清空封面」不生效（`admin_boards_write.go:132-135`）+ 迁移 0030 `users.cover_hash`
  - 证据：`go test ./internal/forum/ -count=1` 里新增的
    `TestUpdateBoardCoverHashDistinguishesAbsentFromClear` 通过（同一次整包运行）；
    该用例的三条断言在旧行为下分别会红：② `{"cover_hash":""}` → 400「没有要改的字段」，
    ③ 只改名字时封面必须原样保留（旧代码把空串折成 nil，走的是「没给」那条路）。
    改动：删掉「空串 → nil」的折叠；事务里 `*in.CoverHash == ""` 走 `upd.ClearCoverHash()`。
    迁移：`0030_users_cover_hash.{up,down}.sql`（`users.cover_hash char(64) NULL REFERENCES images(hash)
    ON DELETE SET NULL` + 单列外键索引）。
  - 下一步：后台分区屏画出「换封面 / 清空封面」（`15-admin/screens/boards.tsx` 的 cover 那一格目前是只读的
    一段说明；`routes/admin/boards.tsx` 还没有 `onUploadCover`）。
  - 阻塞：无（本包中途与另一个 agent 的在途文件撞过编译，见下面「过程」）。
