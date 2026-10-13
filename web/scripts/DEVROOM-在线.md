# DevRoom 在线地址（给协作者看设计稿）

    http://191.40.41.97/devroom/

## 怎么同步最新内容

在仓库根跑一条命令（本地构建 → scp → 服务器上 nginx 静态直出）：

    pwsh -File web/scripts/deploy-devroom.ps1

脚本最后会自己验证 `http://191.40.41.97/devroom/` 返回 200，并把状态码打出来。

## 这套是怎么挂上去的（换服务器/重建时要照做）

1. 服务器是宝塔面板管的 nginx，站点配置在 `/www/server/panel/vhost/nginx/sc2clud.conf`
   （**不是** `/etc/nginx/`）。旧站已经在这台机器上跑：`/srv/sc2clud-dev/bin/forum`，systemd 单元 `sc2clud-dev`，监听 127.0.0.1:8081。
2. 防火墙只开 22 / 80 / 443 / 888，所以**不能另起端口**，必须走 80 上的 nginx 静态直出。
3. 服务器**没有 node**，所以不在服务器上构建；产物本地构建后 scp 到 `/srv/sc2clud-preview/`。
4. nginx 里加的块（位置必须在 server 块内、且不能被别的 location 包住）：

       location /devroom/ {
           alias /srv/sc2clud-preview/;
           index index.html;
           expires 2m;
           add_header Cache-Control "public, max-age=120";
           access_log off;
       }
       location = /devroom { return 301 /devroom/; }

## 两个坑（都实际踩过）

- **插入位置**：第一版把块插在了 `location /dev/` 的**内部**（那段本身是散开的，`location /dev/ {` 出现在若干行指令之后），
  结果整个块变成嵌套的、不生效。**改插到 server 块末尾（最后一个顶格 `}` 之前）**。改前务必备份，`nginx -t` 通过再 `systemctl reload nginx`。
- **默认 Host 会 404**：80 端口上有别的 server 抢了 `default_server`，所以 `curl http://127.0.0.1/devroom/`（不带 Host）返回 404，
  而带正确 Host 的 `curl -H 'Host: 191.40.41.97' http://127.0.0.1/devroom/` 返回 200。**验证要用真实地址**，不要用本机默认 Host 判定。
## 跑脚本用什么壳

Windows 上 `pwsh`（PowerShell 7）不一定在 PATH 里，用系统自带的：

    powershell -NoProfile -ExecutionPolicy Bypass -File web/scripts/deploy-devroom.ps1

**脚本里只写 ASCII**：Windows PowerShell 5.1 把无 BOM 的 UTF-8 当 ANSI 读，中文注释会把脚本解析坏
（第一版就是因此报 `Unexpected token`，而报错位置看着像语法问题，实际是编码）。