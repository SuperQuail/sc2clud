# 进度 · MIG-DONE（第三轮拍板的三条「完全迁移」）

> 依据：`完全重构/进行中/10-dev排查-缺陷清单.md` §1c（用户第三轮拍板，逐字照做）。
> 作用域：`forum/internal/app/**`、`forum/internal/forum/**`、`forum/migrations/postgres/**`、
> `完全重构/迁移素材/**`、`完全重构/数据迁移审计.md`、本文件。**不碰** `web/src/**`、`deploy/**`。
> 验证口径：后端 `gofmt -l .` + `go vet ./...` + 改过的包 `go test -count=1`（不用 `-run` 过滤整包收尾）；
> **不跑 `pnpm check`**（清 dist、与并发的人互踩），本包一行前端也不碰。

- [x] 迁移号取证 + 第1步：公告区权限的**会红用例**先落地（还没修）
  - 做了什么：新建 `forum/internal/app/announcement_acl_test.go`：真迁移 → `Seed` → 真服务，
    断言 ①公告区 `acl_enabled` + 四个内置角色**逐角色**的 (can_post, can_reply)；②普通用户
    （种子 `demo-thor`，持 `topic.create`）发公告区 → `board.acl_denied`；③管理员（`demo-admin`）发帖成功、
    普通用户**仍能回复**（老站 `reply_min_role='member'` 那一档不能一起收紧）。先用例、后改库。
  - 证据：`go test ./internal/app/ -run TestAnnouncementBoardOnlyAdminsCanPost -count=1 -v`
    → `announcement_acl_test.go:56: 公告区 acl_enabled 不是 true：角色门槛只能靠 board_acls 表达
    （min_post_level 是等级，不是角色）` + `--- FAIL` + `FAIL forum/internal/app 9.710s`（TEST_EXIT 非 0）。
    老站真值（只读备份 `backups/old-prod-2026-10-12/sc2clud.sqlite3`）：
    `announcement|公告|站点通知（只有管理员能发）|post_min_role=admin|reply_min_role=member`。
  - 下一步：把执法点落进 `seed`（`seedAnnouncementACL`）并改 `seed_data.go` 的中文名 → 用例转绿。
  - 阻塞：无。**迁移号取证**：`forum/migrations/postgres/` 现有最高是 **0051**（`0051_board_moderator_grown`；
  0029/0030/0040/0050 都已占），`migrations.Latest()` 实测 = **51**。本包**没有新增迁移**
    （原因见第2步），将来真要加从 **0052** 起。
- [x] 第2步：公告区「只有管理员能发」真的落地（老站语义 = ①ACL 白名单）
  - 做了什么：**先写了一条 0031 迁移又删掉** —— 迁移在空库上跑（`migrate` 早于任何分区存在），
    `WHERE b.slug='announcement'` 一行都命中不到，实测 `board_acls rows=0`；而顺序号必须 > 0051 才排在
    `0050_boards_public_id` 之后，编号语义也会乱（编号是**类型**不是时间）。改成落进 `forum seed`：
    `seed.go` 在 `seedBoards` 之后调 `seedAnnouncementACL(ctx, in.Pool)`（`seed_data.go` 里实现）——
    它读现状、与目标比对、只改不一致的行；目标 = 四个内置角色 `admin/superadmin` 能发、
    `user/creator` 不能发，**回复一律放开**；自定义角色按「名字含『管理员』」收敛。
    选择理由（按老站语义，不按哪条好写）写在函数注释里：②加 `min_post_role` 列在新站**不能少写一个字**
    （0017 四个内置角色 `parent_id` 全 NULL，角色之间没有继承，「admin 及以上」照样列两行），
    只是把规则放到第二个地方；③接受一档等于让这句话在真站上是假的。①的代价（白名单制把回复也管住）
    正好与老站同形（`reply_min_role='member'`）。
    `seed_data.go` 同时改两个中文名：`工具（玩家）`→`工具（玩家用）`、`工具（开发者）`→`工具（开发者用）`。
    **已存在的行**由 `seedBoards` 的 default 分支（`SetName`）收敛 —— 用例正是钉这一条。
  - 证据：`go test ./internal/app/ -run TestAnnouncementBoardOnlyAdminsCanPost -count=1 -v`
    → `seed: ok, boards=5 users=11 topics=25 posts=75 announcement_acl_changed=5` + `--- PASS` + `ok 10.483s`；
    `-run 'TestSeedAnnouncementACLIsIdempotent|TestBoardNamesConvergeToSeed'` → 两条 `--- PASS`、`ok 10.571s`
    （幂等那条先断言 first>0 再断言 second=0；名字那条先把 `tool-player` 改回旧名再跑 seed，要求变回来）。
  - 下一步：AI 配置的值也做成迁移资料（`完全重构/迁移素材/ai-config.json` + `forum ai-config` 导入命令 + 用例）。
  - 阻塞：无。
- [x] 第3步：AI 配置**完全迁移**（值也做成迁移资料 + 可重复执行的导入路径）
  - 做了什么：①\`完全重构/迁移素材/ai-config.json\` —— 老站 AI 配置的**值**（真源是备份库的 \`site_texts\` 表，
    不是代码字面量：\`site/migrations/0029\` 只是默认值，线上被超管改过）。11 格：\`enabled/provider/base_url/model/
    prompt/prompt_report/temperature/thinking/strict_mode/timeout_ms/max_output_tokens\`，另带 \`traced\`（逐格给老站出处
    + 哪几格**不是逐字迁移**）与 \`not_migrated\`（密钥为什么不迁：老站 \`ai_secrets\` 的密文用**老站自己的主密钥**加密，
    备份里没有该密钥材料 → 新站解不开，只能重配）。②\`forum/internal/app/ai_config_import.go\` 的 \`AIConfig\`
    （\`forum ai-config -ai-manifest <file> [-dry-run]\`）：与 board-covers 同一套做法 —— manifest 是资料、命令是落地动作；
    干跑不接库；**只改与目标不一致的那几格**（11 格逐格比对算 changed，一条 UPDATE 落地）。③迁移素材 README 加一节；④用例。
  - 证据：\`go test ./internal/app/ -run TestAIConfigImportIsIdempotent -count=1 -v\` →
    \`ai-config: ok, changed=5 unchanged=6\`（第一遍：base_url/model/两段提示词真的被写进去；
    timeout_ms/max_output_tokens 与新站默认同值）→ 第二遍 \`changed=0 unchanged=11\` → \`--- PASS\`、\`ok 9.649s\`。
    用例还核了：两段提示词逐字是老站原文（含「交人工复核」「拿不准就给待定」）、\`secret_cipher IS NULL\`（密钥没被搬）。
    老站值（只读备份实测）：\`ai_enabled=0 / ai_endpoint=https://api.deepseek.com / ai_model=deepseek-flash / 
    ai_prompt_new_post=你是中型星际争霸 II 社区的内容审核员… / ai_prompt_report=你是社区内容审核员… /
    ai_reasoning_effort=（空）/ ai_review_posts=1 / ai_review_on_report=1 / ai_review_comments=0\`。
  - 下一步：把盘点表那一条从「部分已迁 / 措辞要更正」改成**已迁**，并在审计里补 AI 配置值这一节（§6.4 / §6.5 / §5.3）。
  - 阻塞：无。**两处已知偏差**（写进 manifest 的 traced，没有偷偷写成「等价」）：\`thinking=false\`
    （老站不传 reasoning_effort → 服务端默认思考开）与 \`timeout_ms=30000\`（老站客户端 60s）。
