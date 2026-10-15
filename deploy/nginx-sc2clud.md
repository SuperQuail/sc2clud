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

## 4. 生产上线（**2026-10-15 已完成**）

占位页已停用，`location /` 现在就是论坛本体（`sc2clud-prod`，8080）：

```bash
systemctl disable --now sc2clud-placeholder.service   # 做过一次即可；它自己注释写着「新站上线后删除」
ss -lntp | grep ':8080'                               # 只有 forum
```

## 4b. 限流额度：静态资源与 SPA 的 location **必须显式声明 burst**（2026-10-15 实测修复）

**症状**（用户长期反馈）：「页面偶发 404 / 渲染失败，强制刷新更容易中，普通刷新又好了」。
**根因**：server 级 `limit_req zone=sc2clud_req burst=16 nodelay;` 会被**没写 limit_req 的 location 继承**。
强刷时浏览器并发取 20+ 个 chunk，第 17 个起全 429 → 模块加载失败 → 页面报「这一页渲染失败了」，
而普通刷新有缓存、请求数少，所以看着像「偶发」。**当时缺这四条的正是 `location /`（生产 SPA）与房间 assets。**

改法（速率仍是 8r/s，放宽的只是突发额度；持续刷站照样被限）：

```nginx
location /dev/devroom/assets/ { limit_req zone=sc2clud_req_dev burst=200 nodelay; … }
location /dev/devroom/        { limit_req zone=sc2clud_req_dev burst=200 nodelay; … }
location /dev/                { limit_req zone=sc2clud_req_dev burst=200 nodelay; … }
location /                    { limit_req zone=sc2clud_req burst=200 nodelay; … }   # 生产 SPA
```

**验收**（两条都要 0 个 429）：

```bash
H='Host: 191.40.41.97'
for f in $(ls /srv/sc2clud-dev/dist/devroom/assets/*.js | head -40); do
  curl -s -o /dev/null -w '%{http_code} ' -H "$H" "http://127.0.0.1/dev/devroom/assets/$(basename $f)"
done        # 40×200
for f in $(ls /srv/sc2clud-prod/current/web/dist/assets/*.js | head -20); do
  curl -s -o /dev/null -w '%{http_code} ' -H "$H" "http://127.0.0.1/assets/$(basename $f)"
done        # 20×200
```

## 4c. 房间目录 `dist/devroom` 由**部署**发布（2026-10-15 实测）

`location /dev/devroom/` 指向 `/srv/sc2clud-dev/dist/devroom/`，而不是 release 里的那份 —— 因为 release 目录是
`umask 077` + root 所有，**nginx（www 用户）读不到**（指过去会全是 404，实测过）。
代价是那份必须跟着发布走，否则房间会一直停在最后一次手工拷贝的版本 —— 2026-10-15 实测它就停在 **10-13**
（两天），期间所有「房间出图确认」看的都是旧包。现在由 `deploy/remote/install.sh` 在切 `current` 之后发布：

```bash
# install.sh 里：带 devroom 的产物（dev 构建）才做这一步
rm -rf "$SC2CLUD_DIR/dist/devroom.new" && cp -a "$SC2CLUD_DIR/releases/$version/web/dist/devroom" "$SC2CLUD_DIR/dist/devroom.new"
chmod -R a+rX "$SC2CLUD_DIR/dist/devroom.new"
mv "$SC2CLUD_DIR/dist/devroom" "$SC2CLUD_DIR/dist/devroom.old" 2>/dev/null || true
mv "$SC2CLUD_DIR/dist/devroom.new" "$SC2CLUD_DIR/dist/devroom" && rm -rf "$SC2CLUD_DIR/dist/devroom.old"
```

## 5. 可选优化（没做）

让 nginx 直出 release 里的静态资源，应用只发 HTML：`location /assets/ { alias /srv/sc2clud-prod/current/web/dist/assets/; … }`，
配套把 `FORUM_WEB__SERVE_ASSETS` 改成 false。**两个动作必须一起做**，只改一边会导致资源 404。