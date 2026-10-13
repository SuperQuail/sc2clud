# nginx：产品站点接哪一根线（改之前先读这一页）

> 事实核实时间 2026-10-13。**P3 施工没有改过 nginx 的任何一个字节。**

## 1. 现在服务器上是什么

配置在宝塔面板的路径下，**不是** `/etc/nginx/`：

```
/www/server/panel/vhost/nginx/sc2clud.conf
```

关键片段（原文照抄）：

```nginx
upstream sc2clud_dev { server 127.0.0.1:8081; keepalive 4; }   # 旧 Rust 调试实例
upstream sc2clud_app { server 127.0.0.1:8080; keepalive 16; }  # 生产

location = /healthz { proxy_pass http://sc2clud_app; access_log off; }
location = /readyz  { proxy_pass http://sc2clud_app; access_log off; allow 127.0.0.1; deny all; }

location /dev/ { proxy_pass http://sc2clud_dev/; ... sub_filter 补 /dev 前缀 ... }
location / { proxy_pass http://sc2clud_app; ... }
```

## 2. 产品站点需要改什么：**什么都不用改**

- `location /` 已经指向 `upstream sc2clud_app` = `127.0.0.1:8080`；
  新的生产实例就监听 8080（`/etc/sc2clud/prod.env` 里的 `FORUM_HTTP__ADDR`）。
- `location = /healthz` 也已经走 `sc2clud_app`，所以 `http(s)://<域名>/healthz`
  上线后直接是产品实例的版本号，不需要动 vhost。
- `location = /readyz` 只允许 127.0.0.1（部署脚本走的是 `127.0.0.1:8080`，不经 nginx，不受影响）。

**生产上线前只有一件事要做**：把 8080 上的占位服务停掉。

```bash
systemctl disable --now sc2clud-placeholder.service
systemctl status sc2clud-placeholder.service   # 应该是 inactive/dead
ss -lntp | grep ':8080'                        # 应该已经没有 python3
```

（这一条在演练里没有执行：prod 还没有上线，占位页要留着对外。）

## 3. 不许动的地方

- `location /dev/`：旧 Rust 调试实例（8081）。P3 的约束是**不改 /dev/**，
  所以新的 Go dev 用 8082、对外暂时没有路由（要看得用 ssh 隧道，见 README）。
  等旧实例下线、`/dev/` 可以改指 `127.0.0.1:8082` 时，新实例已经在那儿等着了。
- `/devroom/`：设计房间，同理不动。

## 4. 万一将来真要改 vhost：四步，一步都不能省

```bash
ts=$(date +%Y%m%d-%H%M%S)
cp -a /www/server/panel/vhost/nginx/sc2clud.conf /www/server/panel/vhost/nginx/sc2clud.conf.bak-$ts
# …编辑…
nginx -t                       # 必须有 "syntax is ok" + "test is successful"
nginx -s reload                # 只有上一步通过才执行
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/          # reload 后必须还是 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1/dev/      # /dev/ 必须还是 200
```

宝塔自己的「网站」界面也会写这个文件；**手工改完不要再在面板里点保存**，否则互相覆盖。

## 5. 可选的一步优化（本次没做）

让 nginx 直出 release 里的静态资源，应用只发 HTML：

```nginx
location /assets/ {
    alias /srv/sc2clud-prod/current/web/dist/assets/;
    expires 30d;
    add_header Cache-Control "public, immutable";
    access_log off;
    try_files $uri =404;
}
```

配套把 `/etc/sc2clud/prod.env` 里的 `FORUM_WEB__SERVE_ASSETS` 改成 `false`。
两个动作必须一起做：只改一边会导致资源 404。
