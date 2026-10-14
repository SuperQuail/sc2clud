# 进度 · W-C4（C4 + C5 申诉闭环）

> 任务书：[`07-一次性完工交接单.md`](./07-一次性完工交接单.md) 第 4 节 **C4 + C5**。
> 作用域（只碰这些）：`forum/internal/appeal/**`（新建）、`forum/migrations/postgres/**`（新建一对 .up/.down）、
> `forum/internal/app/**`（接线）、`forum/internal/ent/schema/**`（如果要建表）、`web/src/lib/api/social.ts`（只加函数）、
> 本文件。**不碰** `forum/internal/forum/**`、`web/src/routes/**`、`web/src/app/**`。
> **接手规则**：读完本文件 + `git log --oneline -12` 就能继续，不需要任何对话记录。
> 收工命令：`cd web && pnpm typecheck && pnpm lint && npx vitest run`（**不跑 pnpm check**）；
> 后端 `$env:GOPATH/GOMODCACHE/GOCACHE + GOTOOLCHAIN=local + .tools/go/bin/go.exe test ./internal/<包>/...`。
> 出图端口：**5214**（别的包用 5202/5210/5212，别撞）。收工按 PID 关掉自己起的进程。

## 契约（前端已经在发的那份就是真源）

`web/src/routes/appeal.tsx` 已经在发 **`POST /api/v1/appeals`**，体是
`{ type, username, email, ref?, title, details, contact?, captcha? }`，期望 `202 { no, eta? }`。
类型值域 `ban | review_reject | report_result | other`（照 DevRoom `17-appeal/data.ts`）；`review_reject` 免登录时不该走这条。
**注意 `captcha` 字段名**：前端现在只发答案、没发 `captcha_id`（`ProductCaptcha` 有 `onChallenge` 回调但 `routes/appeal.tsx` 没用它）；
本域额外收 `captcha_id`（可选），两者都收 —— 用户在页面上填了验证码就必须能提交成功（详见「阻塞」第 2 条）。

## 步骤

- [ ] 第 1 步：进度文件骨架 + 契约锁定
  - 证据：`git log --oneline -1` = 本提交；`git status --porcelain` 里只有本文件。
  - 下一步：写迁移 0022（appeals 表）+ `forum/internal/appeal/**` 的 DTO/errors/service/pgsql/handler，
    在 `forum/internal/app/appeal_test.go` 用 testsupport 起真库跑「未登录能提交 / 管理端能处理 / 提交人能查到结果」三条。
  - 阻塞：见下。

## 阻塞（要 Lead 动的）

1. **`web/src/app/router.tsx:55` 的 `appeal` 路由被注释掉**（`{ path: 'appeal', ... }`）—— 整页不可达。
   这一行在 **Lead 的冻结文件**（`router.tsx`）里，我不碰。端点落地后请取消注释（`56af` 之前那句
   「后端端点不存在，整页隐藏」的理由就没了）。
