# 进度 · FIX-USERS（用户管理页只显示 20 人、翻页不可用、看不到总人数）

> 作用域：`forum/internal/{user,forum,auth}/**`、`web/src/devroom/pages/15-admin/screens/users.tsx`、
> `web/src/routes/admin/users.tsx`、`web/src/lib/api/admin*.ts`、`完全重构/进行中/进度-FIX-USERS.md`。

## 结论（先核现状，2026-10-15）

- **「后端游标分页不给总数」这句是假的**（屏幕上的 `hint` 与 `routes/admin/users.tsx:117` 的注释都这么写）：
  后端 `GET /admin/users` 确实只回 `{data, next_cursor}`，但「拿不到总数」不是游标分页的必然结果 ——
  补一条计数查询即可。真正**没有被接线**的是分页本身：屏里的 `page`/`size` 是纯本地 state，
  `TableFooter` 的上一页/下一页只改页码，**从不回传游标**，所以点了不换数据。
- 因此三条缺陷是两件事：**总数要后端给**（v2 包络），**翻页要宿主真的发请求**（游标栈 + 游标进 queryKey）。

## 选择（写清取舍）

- **总数走 v2 包络 `counts`，不新开 count 端点**：两次往返之间有人注册，屏上就会出现
  「列表 21 条、总数 20」；而且两个数的 WHERE 要各写一份、各自漂移。现在列表与计数共用
  `pgsql.adminUsersFilterSQL` 一个常量（筛选条件下 `COUNT(*)` 天然跟着走）。
- **翻页用游标栈，不改成 offset**：偏移分页在有人注册时会漏行/重行，且与仓库既有契约
  （v2 §21.1 禁止 page/offset）冲突。代价写在前面：**只能跳到已经到过的下一页**（`maxPage = 已到达 + 1`），
  对 20 条一页的后台列表够用；要真「跳第 37 页」得走 offset，那是另一笔账。
- 旧包络不动：**不传 `v=2` 时逐字与从前一样**（有会红的用例钉住）。改 `GET /admin/users` 的老字段会改契约。

## 步骤 1 · 后端：v2 包络给总数与三根轴的计数

- [x] `GET /admin/users?v=2` 的回包里多一个 `counts`：`total / banned / pending_activation / email_unverified`，
      **整个筛选结果集**（不是本页条数）；计数与列表**共用同一份 WHERE**（`pgsql.adminUsersFilterSQL`）。
  - 证据：先红 —— 新用例 `TestAdminUsersV2CarriesTotalAndCounts` 在旧代码下编译失败
    （`undefined: AdminUsersCountsDTO`，即「后端根本没有这个数」，屏上「共 N 条」无从算起）；
    补完后 `go test ./internal/auth/ -count=1` → `ok forum/internal/auth 56.349s`（整包跑，未用 -run 过滤）。
    两条老用例 `TestListAdminUsersFilters` / `TestListAdminUsersCursorHasNoGapsOrDupes` 仍绿；
    另加 `TestAdminUsersV1EnvelopeHasNoTotal` 钉住「不传 v=2 时包络里不许出现 total/counts」。
  - 下一步：前端 `lib/api/admin.ts` 的 `fetchUsers` 加 `v: '2'` 并取出 `counts`，
    喂给 `UsersScreen` 的新 props（`counts` + `onPage`），宿主用游标栈发请求。
  - 阻塞：无

