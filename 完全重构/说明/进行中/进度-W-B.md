# 进度 · W-B（交接单 §4.B 的前端小修 + 出图脚手架）

> 任务书：[`07-一次性完工交接单.md`](./07-一次性完工交接单.md) 第 4 节 **B**（B1–B6、B8）。
> **接手规则**：读完本文件 + `git log --oneline -8` 就能继续，不需要任何对话记录。
> 基线：master = `bac77af`，`cd web && pnpm check` 全绿（27 文件 / 141 用例）。
> 出图端口：**5229**（vite dev，preview 配置 5199 是共享入口别占）。收工跑 `cd web && pnpm typecheck && pnpm lint && npx vitest run`（**不跑 pnpm check**：它会 `pnpm build` 清空 dist，与并发施工互踩）。

## 作用域（交接单点名给我的）

- `web/src/routes/topic.tsx`、`web/src/routes/messages.tsx`、`web/src/lib/api/issues.ts`、
  `web/src/devroom/pages/13-issue/{issue-filter-bar,new-issue-dialog,issue-detail}.tsx`、
  `web/vite.preview.config.ts`（**被点名授权**的冻结文件）+ 新建的产品预览入口文件、
  `完全重构/开发必读.md`、本文件。
- **不碰**：`web/src/app/**`、`web/src/ui/**`、`web/src/lib/url.ts`。
- 三项**越界但任务点名**（记在这里，Lead 复核时知道为什么）：`web/src/devroom/pages/12-topic/issue-nudge.tsx`（四个入口要按 kind 各给一个 href）、
  `web/src/devroom/pages/12-topic/topic-view.tsx`（把 `issueHrefFor` 透给 IssueNudge）、
  `web/src/routes/issues.tsx`（B5 的 `onVote` 要由这一页接到 mutation 上）。

## 步骤

- [x] 第 0 步：进度骨架 + 提交（本文件）
  - 证据：`git log --oneline -1` → `e8c6daa`；`git status --short` 里只 add 了本文件。
  - 下一步：B2+`B6` 一起改 `web/src/routes/topic.tsx`：① 加 `issueHrefFor={(k) => appPath('issues?topic=' + t.id + '&kind=' + k)}`、删掉那两个只回执的 `onOpenFeedback/onOpenIssue`；
    ② `save` 的 onSuccess 里加 `invalidateQueries(qk.topic)` + 回执「正文已保存并重新提交审核（回到 pending）」，两句假话（"端点还没有"）删掉。
  - 阻塞：无

- [x] 第 1 步：B2 四个反馈入口改成真链接 + B6「重新提交审核」说实话（一个提交：两处都在 topic.tsx，改的是同一个组件调用）
  - 做了什么：`routes/topic.tsx` 把只回执的 `onOpenFeedback/onOpenIssue` 换成
    `issueHrefFor={(kind) => appPath('issues?topic=' + t.id + '&kind=' + kind)}` 与 `feedbackHref={appPath('issues?topic=' + t.id)}`；
    `save` 的 onSuccess 记下「这次保存就是重新提交」（`saved='draft'`），回执按服务端 `review_state` 说实话。
    为此 `topic-view.tsx` 加 `issueHrefFor` prop 并透给两处 `IssueNudge`；`issue-nudge.tsx` 加 `kindHref`（四个类型各一条地址）、
    `TopicViewProps.onOpenIssue` 改可选（有 href 就不再需要回执回调）。
  - 证据：`cd web && pnpm typecheck` → 无输出（exit 0）；
    `npx vitest run src/devroom/pages/12-topic/topic-view.test.tsx` → `Test Files 1 passed / Tests 6 passed`；
    第五个用例 `四个反馈入口各是一条带了各自类型的链接（B2）` 是新的，**先证明它会红**：把 `kindHref={issueHrefFor}` 临时去掉 →
    `AssertionError: expected '/issues?topic=t_1042' to be '/issues?topic=t_1042&kind=bug'`（1 failed），加回去即绿。
    全套 `npx vitest run` → `Test Files 27 passed (27) / Tests 142 passed (142)`。
  - 下一步：B1 改 `web/src/routes/messages.tsx` 的 `NOTICE_KINDS`：`{kind:'system',label:'系统通知'}` → `{kinds:['system','review','sanction','reward'],label:'系统通知'}`（其余三档单值），
    档位比较与 `fetchNotifications({kind})` 传 `kinds.join(',')`；后端 `notify/service.go:200 parseListKinds` 认逗号多值（值域见 `notify/kinds.go`）。
  - 阻塞：无

- [x] 第 1b 步（顺手，不动渲染）：修掉一个**在 bac77af 上就已经红**的测试抖动
  - 做了什么：`topic-view.test.tsx` 第一条用例等懒加载评论区只给了 `findBy` 默认 1s；
    全套并发跑时实测超过 1s → `Unable to find an element by: [data-testid="comment-total"]`。窗口放宽到 3s（断言一个字没改，与 `949be1c` 修 home.test 同一处理）。
  - 证据：`git stash push` 掉我这一轮的全部改动后跑 `npx vitest run` → `Tests 1 failed | 140 passed`，失败的就是这条
    （**所以不是我的改动弄红的**）；放宽窗口后同一条 → `Test Files 27 passed (27) / Tests 142 passed (142)`。
  - 下一步：见上一步。
  - 阻塞：无
- [x] 第 2 步：B1「系统通知」一档四类合一（system / review / sanction / reward）
  - 做了什么：`routes/messages.tsx` 的 `NOTICE_KINDS` 从「一个 `kind` 字符串」改成「`kinds: string[]`」；
    `resolveNoticeKind()` 把 URL 的 `?kind=` 归一（`?kind=review` 这种旧书签落到「系统通知」那一档，不会显示成「回复我的」）；
    请求串用 `kinds.join(',')`（后端 `notify/service.go:200 parseListKinds` 认逗号多值，值域 `notify/kinds.go`）。
  - 证据：新文件 `web/src/routes/messages.test.tsx`（2 条）——
    `npx vitest run src/routes/messages.test.tsx` → `Test Files 1 passed / Tests 2 passed`；
    **先证明它会红**：把那一档临时改回 `['system']` → `Tests 2 failed`（① 请求串不是四类 ② `?kind=review` 落错档）。
    全套 `npx vitest run` → `Test Files 28 passed (28) / Tests 144 passed (144)`；`pnpm typecheck` 无输出；`npx eslint src/routes/messages.tsx src/routes/messages.test.tsx` → exit 0。
  - 下一步：B3 改 `web/src/devroom/pages/13-issue/issue-filter-bar.tsx:19`：`created: '最早创建'` → `'最新创建'`（后端三种排序列全 DESC：`forum/internal/forum/pgsql/issues.go:110-113,157`）。
  - 阻塞：无
- [x] 第 3 步：B3 排序标签说实话 + B4 新建反馈弹窗那句过期话 + B5 评论赞/踩接上端点
  - 做了什么：① `13-issue/issue-filter-bar.tsx` 的 `SORT_LABEL.created`：`'最早创建'` → `'最新创建'`（后端三种排序列全 DESC）；
    ② `13-issue/new-issue-dialog.tsx:54` 删掉「（本页数据是本地的，用于验证交互闭环）」→「提交后会存到服务端」；
    ③ `lib/api/issues.ts` 加 `setIssueCommentVote(id, value: 1|-1|0)`（PUT/DELETE `issue-comments/{id}/vote`，返回 **VoteResultDTO**：`like_count/dislike_count/my_vote`，字段名照 `dto.go:209`）；
    `13-issue/issue-detail.tsx` 的 `IssueDetail` 加 `onVote?: (id, value) => void` 并传给 `CommentList`；
    `routes/issues.tsx` 加 `voteComment` mutation（同向再点 = 取消 → value 0 → DELETE）并接进 `onVote` 与失败回执列表。
  - 证据：`cd web && pnpm typecheck` → 无输出；
    `npx vitest run src/routes/issues.test.tsx` → `Tests 5 passed`，新增用例「评论的赞 / 踩」；
    **先证明它会红**：把 `onVote` 换成 `undefined` → `AssertionError: expected undefined to be 'DELETE'`（1 failed），接回来即绿。
    全套 `npx vitest run` → `Test Files 28 passed (28) / Tests 145 passed (145)`；
    `node scripts/check-size.ts` → `检查 261 个文件，超限 1 个，登记 1 个 / 文件体量门禁通过`（`routes/messages.tsx` 580 行，本来就在 PENDING 里）。
  - 下一步：B8 —— 产品页出图脚手架：新建 `web/product.html` + `web/src/preview/product.tsx`（真 Shell + MemoryRouter，可切路由）、
    `web/vite.preview.config.ts` 的 `rollupOptions.input` 加 `product: 'product.html'`，再写进 `开发必读 §8`。
  - 阻塞：无
- [x] 第 4 步：B8 产品页出图脚手架（长期件，不再是临时改配置）
  - 做了什么：新建 `web/product.html` + `web/src/preview/product.tsx`（**真壳** `app/shell.tsx` + 真页面，
    `MemoryRouter` 所以静态服务与 vite dev 都能直接打开；参数 `route=` 切路由、`stub=0` 走真后端、`me=0` 游客、`theme=` 主题）
    + `web/src/preview/product-fixture.ts`（桩：字段名照 `forum/internal/**`、`notify/types.go`、`message/types.go` 的 DTO 抄；
    请求流水留在 `window.__PRODUCT_FETCH_LOG`）；`web/vite.preview.config.ts` 的 `rollupOptions.input` 加 `product: 'product.html'`；
    `完全重构/开发必读.md` 新增 §8.1（用法 + 为什么 + 出图命令）。
  - 证据：
    ① **dev 出图**（`shots/wb-shot.mjs`，vite dev 5229 / Chrome 9233）：三页都出了图且**看图确认没塌** ——
       `shots/preview/wb-product-home.png`（顶栏 SC2clud/首页/搜索 + 左栏五个分区 + 三张帖子卡片带真实标题与计数）、
       `shots/preview/wb-product-messages.png`（顶栏 + 信息中心五档 + 会话列表「示范管理员 … 补丁已经推上去了」）、
       `shots/preview/wb-product-issues.png`（顶栏 + 两个页签 + 四类入口 + 检索条 + #128/#126/#125 三条反馈）。
       每张图左下角都有可见标记 `MARKER-PRODUCT-LOGIN <route>`（交接单 §5.4 的固定动作），脚本同时断言它与 `<header>` 存在；
       控制台问题 0 条（只有 react-router 的 HydrateFallback 警告，已确认不影响渲染）。
    ② **B2 的实测**（同一套脚本读 DOM）：`issueLinks: ["/issues?topic=tp-1", "/issues?topic=tp-1&kind=bug",
       "/issues?topic=tp-1&kind=feature", "/issues?topic=tp-1&kind=difficulty", "/issues?topic=tp-1&kind=other", "/issues?topic=tp-1"]`
       —— 四个入口各带自己的 kind，两处「看全部/去反馈页」不带 kind。
    ③ **B3/B4 的实测**：`shots/preview/wb-product-issues-sort.png`（排序下拉打开着，三档是「最新更新/评论最多/**最新创建**」）、
       `shots/preview/wb-product-issues-dialog.png`（新建弹窗那句话已是「提交后会存到服务端，并立刻出现在左边的列表里」）。
    ④ 窄屏 390：`shots/preview/wb-product-{home,messages,issues,topic}-390.png`，无横向滚动（脚本读 `scrollWidth === clientWidth`）。
    ⑤ **构建产物也验过**（不能只验 dev）：`npx vite build --config vite.preview.config.ts` → `preview-dist/` 里有四个入口
       （`devroom.html / isolate.html / preview.html / product.html`）；`shots/wb-built-check.mjs` 用静态服务（5230）打开构建版的
       `product.html` → 三页 `header:true`、marker 正确、正文长度 368/184/499（与 dev 一致）。
    ⑥ `pnpm typecheck` 无输出；`npx vitest run` → `Test Files 28 passed (28) / Tests 145 passed (145)`；
       静态门禁：`check-ui-usage`「没有手写 HTML 控件」/ `check-controls`「只用了已登记的 45 个控件」/ `check-urls`「路径都走统一入口」/
       `check-security`「无 sourcemap 上线、无密钥入库、无未受控调试开关」/ `check-size`「通过（超限 1 个，已登记）」。
  - 下一步：等 Lead 串行跑一次全量 `cd web && pnpm check`（**我没跑**：它会 `pnpm build` 清空 dist，交接单禁止并发跑）；
    另外 B1/B2/B3/B4/B5 的渲染改动都已在第 4 步一并出图（见上），不需要再补图。
  - 阻塞：见下（两条）。
