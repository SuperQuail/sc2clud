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

- [x] 第4步：盘点表订正（审计 §2.5/§3.1/§5.3/§6/§6.1/§6.4/§6.5 + 交接单 E1/E3/L10）
  - 做了什么：\`完全重构/数据迁移审计.md\` —— §6 的九条对照表里**三处结论改判为「已迁」**（第 1 条的中文名、
    第 2 条的分区权限、第 5 条的 \`site_texts\`、第 7 条的公告区门槛），§6.1 补上「判据是库里的 \`sections.label\`、
    已有行由 seed 收敛」；§6.4 **重写成 15 行**（MIG-ART 那版写「13 个键」，漏了线上被改过的
    \`ai_prompt_report\` 与 \`ai_reasoning_effort\`），并把「老值」一列换成**备份库里的真值**，同时更正两处错映射
    （\`ai_endpoint→ai_config.base_url\` 不是 \`.endpoint\`；\`ai_config.review_on_report\` **这一列不存在**，
    新版两套提示词**本来就是两列**，不是「并入 prompt」）；§6.5 写清三条路选了①与**为什么不选②③** + 落地方式 +
    判据；§5.3 从「还没补」改成「已补」并给出用例与生产要注意的一句话；§2.5/§3.1 里「新站没有这些功能」
    这句过时结论加了更正指向 §6.4。\`07-一次性完工交接单.md\`：E1/E3 勾掉并写清落点与「密钥迁不过来」的理由，L10 那句
    「已知至少三块没有对应实现」更正为「前两块已做完」。
  - 证据：\`Select-String -Path 完全重构\\数据迁移审计.md -Pattern '待拍板|还没补|措辞要更正|部分已迁'\`
    → 只剩 §6 前言那一句「这一节的结论列现在没有『待拍板』了」；\`git diff --cached --stat\`
    → \`数据迁移审计.md | 163 +++---\`、\`07-一次性完工交接单.md | 19 +-\`（共 129 增 53 删，纯文档）。
  - 下一步：收尾自查（\`gofmt -l .\` + \`go vet ./...\` + \`go test ./internal/app/ -count=1\` 整包，不过滤），
    然后按 PID 关掉本轮起的进程。
  - 阻塞：无。**本步不改代码，只改盘点**；两处「不是逐字迁移」的偏差（\`thinking\` / \`timeout_ms\`）留在
    \`ai-config.json\` 的 \`traced\` 里，没有为了让表格好看而改写成「等价」。

- [x] 第5步：收尾自查（改过的包整包跑）+ 修一处**跨用例**的脏（别人写的件也没放过）
  - 做了什么：①全包跑 \`go test ./internal/app/\`（不过滤）—— 逮到一条**只在整包跑时才会炸**的脏：
    \`TestBoardCoversImportIsVisibleAndIdempotent\` 与 \`e2e_test.go\` 用的是**不带 ON CONFLICT 的 INSERT boards**，
    而我的用例先跑过 \`Seed\` 就把那五个分区建好了 → \`重复键违反唯一约束 boards_slug_key\`。两处都改成
    \`ON CONFLICT (slug) DO NOTHING\`（分区是运营数据，用例不该假设库是空的），并各留一行注释记这次的根因。
    ②顺手把 \`ai-config\` 的 CLI 路径实测了一遍（干跑）；③给迁移素材 README 补上 \`-manifest\` 的相对路径约定与干跑回执。
  - 证据：\`go fmt ./...\` 空输出、\`go vet ./...\` → \`VET=0\`；\`go test ./internal/app/ -count=1\` → \`ok forum/internal/app 15.343s\`、
    \`TEST=0\`（**整包 12 条全绿**，不是 -run 过滤）；另跑了**没改过**的 \`go test ./internal/forum/ -count=1\` →
    \`ok forum/internal/forum 82.469s\`、\`TEST=0\`（ACL 判定六步那条路径的回归）。
    CLI 干跑（真二进制、假 DSN，不接库）：
    \`forum ai-config -dry-run -ai-manifest <abs> -config <.tools/tmp-aiconfig-dry.yaml>\` →
    \`ai-config: dry-run\` + \`provider=deepseek base_url=https://api.deepseek.com model=deepseek-flash\` +
    \`enabled=false thinking=false strict_mode=false temperature=0 timeout_ms=30000 max_output_tokens=2048\` +
    \`prompt=89 字…\` / \`prompt_report=51 字…\`，\`EXIT=0\`。
  - 下一步：无（四条拍板全部落地）。**没跑 \`pnpm check\`**：本包一行 \`web/src/**\` 都没碰，而那条门禁会清 \`dist/\`、
    与正在改前端的并发包互踩（交接单 §3.5 / §5.8 明写同一时刻只允许一个人跑）。
  - 阻塞：无。**遗留两处（都不在文件作用域里，报给 Lead）**：①\`seed_data.go\` 公告帖正文里还写着
    「**工具（玩家）**」「**工具（开发者）**」（那是**帖子正文**不是分区名，本轮只按拍板改分区名）；
    ②\`完全重构/进行中/09-收尾对照表.md\` 第 75–76 行那份**历史实测记录**里写着 \`name=工具（玩家）\`
    —— 是当时的真实回执，不该改；下次实测会把新名记进去。
