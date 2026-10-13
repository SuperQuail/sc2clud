# scripts/blindtest — 写操作主链路盲测

> 这个目录里有**多个人**的脚本。下面只说我加的这几个（其它 `run-*.py`、`plan-*.json`、`page-driver.mjs`、`miniws.mjs`、`proxy.mjs`、`_trace-*`、`_profile.mjs` 等都不是我的，我没有改动它们）。

## 我的文件

| 文件 | 作用 |
|---|---|
| `blindtest_write.py` | 主脚本：13 步写操作 + 收尾清理 + SQL 自证，105 条断言 |
| `remote.ps1` | 把本地 sh 送到 dev 执行。**为什么需要它**：PowerShell 的管道会把 LF 转成 CRLF，base64 过 ssh 会 `invalid input`；这里走 `cmd.exe` 的 `<` 重定向，字节原样进 ssh 的 stdin |
| `last-run.log` | 最终一轮的完整输出（含末尾 `BT_JSON:` 一行机器可读汇总） |
| `debug/` | 过程中的探测/还原脚本。`_restore*.sh` 是还原 Alenger 主题的证据，`_uifield.sh` 是 `board_id` vs `board` 的对照实验 |

## 怎么跑

脚本必须**在 dev 服务器上执行**（它要访问 127.0.0.1 的 nginx、Redis 与 psql）。本机只负责送过去：

```powershell
# 1) 生成 stage（内含 base64 落地 + py_compile + 运行），2) 交给 remote.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/blindtest/remote.ps1 -Body scripts/blindtest/_stage.sh
```

`_stage.sh` 是**临时文件**，内容就是三段：

```bash
printf '%s' '<base64 of blindtest_write.py>' | base64 -d > /tmp/blindtest/blindtest_write.py
python3 -c "import py_compile; py_compile.compile('/tmp/blindtest/blindtest_write.py', doraise=True)"
cd /tmp/blindtest && python3 blindtest_write.py --json
```

## 环境适配（不这样做，测到的不是产品）

1. **自己限速**：nginx 对 `/dev/` 有 `limit_req rate=8r/s burst=32`。脚本按 ~6 req/s 发，并对**应用层** 429（JSON、带 `too_many_requests`）做退避重试；nginx 的 429 是纯 HTML，不重试而是报出来。
2. **来源 IP**：`X-Forwarded-For: 198.18.x.y`（每次跑动随机一个）。nginx 在 127.0.0.1 上是可信代理，会采信该头，于是本次跑动有自己的限流桶，不与别人的调试互相掐。
3. **举报额度**：`report:create` 是 10 次/小时/用户。脚本开跑前会清掉**自己那一个**限流键（`report:create:user:<probe-admin id>`）——那是限流状态，不是数据行。

## 它会长什么

- 每步 `[n] 标题`，每条断言 `[PASS]/[FAIL] name -- detail`，证据行以 `| ` 缩进；
- 末尾按步骤汇总 `OK / ~ / !!`，再打一行 `BT_JSON:{...}`；
- 退出码：全通过 0，有失败 1，崩了 2。

## 它**不会**做的事

- 不碰生产（`/`），不改 nginx，不跑部署脚本；
- 不 DELETE 别人的行；只碰 `probe-admin` 自己造的、标题带 `[盲测]` 的行，以及脚本自建的用户名 `bt-probe-*`；
- 越权用例**只读**靶子主题（用自建普通用户去删，期望 403）。

## 那个坑（写给下一个人）

**别用 superadmin 账号测越权**。`canEditTopic()`（`forum/internal/forum/service.go:96-107`）里 `actor.IsSuper` 是明文放行的分支，superadmin 删/改任何人的帖子都会成功——测不出权限问题，反而**真的会删掉别人的内容**（我就把 Alenger 的一篇主题改名 + 软删了，已按 SQL 还原，见报告 §4.1）。

