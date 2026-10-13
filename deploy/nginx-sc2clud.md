# nginx：产品站点接哪一根线（改之前先读这一页）

> 事实核实时间 **2026-10-13 19:05**（这一页在切 dev 之后更新过，之前的版本说「nginx 一个字都没改」）。

## 1. 配置在哪

宝塔面板管：`/www/server/panel/vhost/nginx/sc2clud.conf`（**不是** `/etc/nginx/`）。
改它必须走这四步，一步都不能省：

```bash
ts=$(date +%Y%m%d-%H%M%S)
cp -a /www/server/panel/vhost/nginx/sc2clud.conf /www/server/panel/vhost/nginx/sc2clud.conf.bak-$ts
# …编辑…
nginx -t                       # 必须有 syntax is ok + test is successful
nginx -s reload                # 只有上一步通过才执行
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: 191.40.41.97' http://127.0.0.1/       # 必须仍是 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: 191.40.41.97' http://127.0.0.1/dev/   # 必须仍是 200
```

**手工改完不要在宝塔面板里点保存**，否则互相覆盖。

## 2. 现在（2026-10-13 切完之后）

| 位置 | 指向 | 说明 |
|---|---|---|
| `upstream sc2clud_dev` | **127.0.0.1:8082** | 新的 Go 实例（`sc2clud@dev.service`）。**旧 Rust 调试实例（8081）已弃用**，`sc2clud-dev.service` 可以停掉 |
| `location /dev/` | → `sc2clud_dev/`（去掉 `/dev` 前缀） | 生产与 dev 共用一份代码，靠 **应用注入的 `<base href>`** 区分前缀 |
| `location /dev/devroom/` | `alias /srv/sc2clud-dev/dist/devroom/` | **设计房间改为 nginx 静态直出** —— 它原来由旧应用提供，切实例后必须独立出来 |
| `location /dev/static/` | `alias /srv/sc2clud-dev/static/` | 未变 |
| `location /` | `upstream sc2clud_app`（8080） | **没动**；8080 现在是 `sc2clud-placeholder.service`（维护页） |

## 3. 运行期前缀由应用负责，**不要用 sub_filter 补**

前端是同一份产物跑两个前缀：资源路径全是相对的（`./assets/…`），前缀来自文档里的 `<base href>`，
而那个标签由 Go 壳按 `web.base_path` 注入（`/` 或 `/dev/`）。API 前缀同样来自它（`client.ts` 的 `BASE + 'api/v1'`）。

**所以 nginx 侧不需要任何 sub_filter。** 它原来那几条（`href="/` → `href="/dev/`）有**两个毛病**：
① 它们**从来没生效过** —— 那段 location 里 `proxy_buffering off;`，而 sub_filter 依赖响应缓冲；
② 就算生效也是错的 —— 会把应用注入的 `<base href="/dev/">` 改成 `/dev//dev/`。

2026-10-13 切 dev 时，真正的两个原因都在应用侧（已修）：

1. `internal/platform/httpx/static.go` 把**根目录**也当成「目录里有 index.html」直接发文件，
   于是 dist 里那份硬编码 `<base href="/" />` 被原样发出去 —— 配置生效了也没用；
2. `internal/app/shell.go` 的正则写成了 `<bases+href=…` —— `\s` 的反斜杠丢了，永远匹配不到。

## 4. 生产上线前只剩一件事

停掉 8080 上的占位页（`location /` 已经指向它要用的端口）：

```bash
systemctl disable --now sc2clud-placeholder.service
ss -lntp | grep ':8080'      # 应该已经没有 python3
```

## 5. 可选优化（没做）

让 nginx 直出 release 里的静态资源，应用只发 HTML：`location /assets/ { alias /srv/sc2clud-prod/current/web/dist/assets/; … }`，
配套把 `FORUM_WEB__SERVE_ASSETS` 改成 false。**两个动作必须一起做**，只改一边会导致资源 404。