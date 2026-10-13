# DevRoom 在线地址

    http://191.40.41.97/dev/devroom/

这是**老入口原地升级后的地址**（URL 没变）。

## 做法：改造老的，不新建

`/srv/sc2clud-dev/dist/devroom/` **本来就有**一套产物（`art/` `assets/` `index.html` `isolate.html` `preview.html`）——
新产物**原地覆盖**它，入口文件名保持 `index.html`（`devroom.html` 也留一份）。
所以：**同一个 URL、同一个入口名，没有新东西要记。**

我前两版都不是这样，都拆了：

| 版本 | 错在哪 |
|---|---|
| 挂在 80 端口的 `/devroom/` | 造出**第三个未定义环境** —— 不在 dev 的限流里，也不在 promote 的语义里。`/dev/` 不是目录前缀，是**一整套隔离环境**（`sc2clud-dev` :8081 + 独立数据目录）。 |
| 挂在 `/dev/static/devroom/` 并给入口加时间戳 | 虽然进了 dev 环境，但**另造了一个入口**（`devroom-1013-1343.html`），而老入口明明已经存在。**冗余。** |

两条教训：**先查清老的东西是怎么工作的，再动；能改造就别新建。**

## 同步命令

    powershell -NoProfile -ExecutionPolicy Bypass -File web/scripts/deploy-devroom.ps1

脚本会：构建 → 上传到 `/srv/sc2clud-dev/dist/devroom/` → 验证该 URL 返回 200
→ **并且断言「服务器返回的入口里引用的 bundle == 本地刚构建的那个」**（不一致就抛错，防止服务到旧产物）。

## 缓存：不用管

dev 站的应用给这个入口发 `Cache-Control: no-store`，所以**刷新一定拿到新构建**。
（早先我用「入口文件名带时间戳」来躲缓存 —— 那个 hack 已经删掉，头本身就够了。）

## 回滚

覆盖前的原始产物备份在服务器：`/srv/sc2clud-dev/dist/devroom.legacy-bak-20261013`。

## 服务器侧既有事实

- nginx 由**宝塔面板**管，配置在 `/www/server/panel/vhost/nginx/sc2clud.conf`（**不是** `/etc/nginx/`）；
- dev 实例：`/srv/sc2clud-dev/bin/forum`，systemd 单元 `sc2clud-dev`，监听 `127.0.0.1:8081`，由 nginx 的 `location /dev/` 反代；
- 防火墙只开 22 / 80 / 443 / 888 → **不能另起端口**；
- 服务器**没有 node** → 不在服务器上构建。

## 脚本只写 ASCII

Windows PowerShell 5.1 把无 BOM 的 UTF-8 当 ANSI 读，中文注释会把脚本**解析坏**
（第一版报 `Unexpected token`，报错位置看着像语法问题，实际是编码）。

## 另两个踩过的坑

- **nginx 改配置要备份 + `nginx -t` + `reload`**：一次我用正则在嵌套 `}` 处收尾早了，留了个游离的 `location`，
  配置直接无效。好在 **reload 失败 = 继续跑旧配置**，站点没断。按大括号配对删才对。
- **「200」不能证明你访问到了对的东西**：生产应用对**未匹配路径**返回维护页（HTTP 200 + 「SC2clud 维护中」），
  我一度拿它当「我的新路径正常」的证据。**验证要看内容。**