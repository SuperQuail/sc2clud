# DevRoom 在线地址（给协作者看设计稿）

    http://191.40.41.97/dev/static/devroom/devroom.html

## 为什么是 `/dev/static/devroom/` 而不是自己的一条路径

`/dev/` **不是一个目录前缀，它是一整套隔离环境**：

```nginx
upstream sc2clud_dev { server 127.0.0.1:8081; }   # 独立实例 + 独立数据目录
upstream sc2clud_app { server 127.0.0.1:8080; }   # 生产
location /dev/ { proxy_pass http://sc2clud_dev/; ... }  # 独立限流 zone
```

它的语义是「**代码相同、数据不同**」，再由 `deploy/promote.sh` 把 dev 推成 prod。

所以 DevRoom 作为**静态资源**就该放在 dev 环境的静态目录里：

    /srv/sc2clud-dev/static/devroom/   ← 由已有的 `location /dev/static/` 直出

**不碰 nginx、不用 reload**，而且天然落在 dev 的限流（`burst=96`）与 `access_log off` 里。

（第一版我把它挂在了 80 端口上一条平行路径 `/devroom/` —— 那等于造出**第三个未定义环境**：
不在 dev 的限流里，也不在 promote 的语义里。已拆除。）

## 怎么同步最新内容

在仓库根跑一条命令（本地构建 → scp → 自己验证 200）：

    powershell -NoProfile -ExecutionPolicy Bypass -File web/scripts/deploy-devroom.ps1

## 服务器侧的既有事实（换机器时要照做）

- nginx 由**宝塔面板**管，站点配置在 `/www/server/panel/vhost/nginx/sc2clud.conf`（**不是** `/etc/nginx/`）；
- 旧站也在跑：`/srv/sc2clud-dev/bin/forum`，systemd 单元 `sc2clud-dev`，监听 `127.0.0.1:8081`；
- 防火墙只开 22 / 80 / 443 / 888 → **不能另起端口**；
- 服务器**没有 node** → 不在服务器上构建。

## 三个实际踩过的坑

1. **别在 nginx 里单开平行路径**（见上）——DevRoom 属于 dev 环境。
2. **脚本只写 ASCII**：Windows PowerShell 5.1 把无 BOM 的 UTF-8 当 ANSI 读，中文注释会把脚本**解析坏**
   （第一版报 `Unexpected token`，报错位置看着像语法问题，实际是编码）。
3. **验证要用真实地址**：80 上有别的 server 抢了 `default_server`，`curl http://127.0.0.1/...`（不带 Host）
   会拿到别人的 404；另外生产应用对**未匹配路径**返回的是维护页（HTTP 200 + 「SC2clud 维护中」），
   所以「200」本身不能证明你访问到了对的东西 —— **要看返回内容**。