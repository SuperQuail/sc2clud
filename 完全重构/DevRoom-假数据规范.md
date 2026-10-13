# DevRoom 假数据规范（2026-10-13 用户要求）

> 用户原话：**「不加鉴权，这本来就应该是可公开的，问题是你把不该公开的东西写进去了；
> 而且其他演示页面你带入了大量来自截图的真实用户名，全部改掉」**

## 规矩

**DevRoom 是公开的**（`http://191.40.41.97/dev/devroom/`，无鉴权、任何人可访问）。所以：

1. **构件进 bundle 的东西就是公开的。** 往 mock 里写任何真实信息之前，先假设它会被人爬。
2. **不许出现真实的人**：真用户名、真昵称、真邮箱、真口令、真头像来源、真交易单号，一律不许。
   来历：**这些名字是从旧站截图上抄下来的真实社区成员** —— 抄的时候没人意识到「截图里的是真人」。
3. **不许出现运营信息**：真实账号 id、真实帖子的原文与标题、真实的打赏记录、真实验证码。
4. 假数据要**一眼看出来是假的**，但仍然要有足够的变化量（长短名、大小写、中英混排、重复昵称），
   否则设计稿没法验证「名字长的时候会不会撑破」。

## 统一假名单（这一份，不要各页自己编）

主题是星际争霸的**兵种名**（通用词汇，不指向任何人）；handle 一律带 `demo-` 前缀，**在界面上就能看出是示例**。

| 昵称 | handle | 用途 |
|---|---|---|
| 示范管理员 | demo-admin | **当前登录者**（后台页的「我」、个人主页的默认主人）。admin 页里「不能停用自己」的判断改用它 |
| 陆战队员 | demo-marine | 普通用户；「同名」用例的第二份是 `陆战队员（同名）` / demo-marine-2 |
| 矿骡 | demo-mule | 短昵称（2 字） |
| 狂热者 | demo-zealot | |
| 刺蛇 | demo-hydralisk | |
| 工蜂 | demo-drone | 新注册用户（低等级、无头衔） |
| 雷神 | demo-thor | 有头衔的活跃用户 |
| 大和号 | demo-battlecruiser | **长昵称 + 长 handle**（撑破测试用） |
| 凤凰战机 | demo-phoenix | |
| 不朽者 | demo-immortal | |
| 虚空辉光舰 | demo-voidray | 长昵称 |
| 黑暗圣堂 | demo-darktemplar | 长 handle |
| 虫后 | demo-queen | 版主（board_moderators 示例） |
| 飞龙 | demo-mutalisk | |
| 感染虫 | demo-infestor | 被举报/受处罚的示例 |
| 幽灵特工 | demo-ghost | |
| 医疗兵 | demo-medivac | |
| 科学球 | demo-sciencevessel | |
| 掠夺者 | demo-marauder | |
| 巨像 | demo-colossus | |
| 督察官 | demo-overseer | |
| 蟑螂 | demo-roach | 新用户 |
| 响尾蛇 | demo-vulture | |
| 仲裁者 | demo-arbiter | |
| 侦察机 | demo-scout | |

**私信会话里需要的那种「活人感」**（长司青/秋枫了鸦/Charles-坏坏/冰绒の某猫 那一批）改用：
`陆战队员`、`狂热者`、`刺蛇`、`虫后`、`科学球`、`幽灵特工`、`医疗兵`、`飞龙`、`感染虫` —— 同样从上面这张表里取。

## 邮箱与口令

- 邮箱一律 `demo@example.com`（或 `demo-n@example.com`）；**`example.com` 是 RFC 保留的示例域，永远不会是真人的**；
- **口令一律不预填**（口令框保持空）。

## 怎么改（给施工者）

1. 把你作用域内**每一个** `nickname` / `handle` / `username` / `email` 换成上表的取值；
2. **不要新增共享的 mock users 文件**（跨页重构风险大于收益）—— 就地替换，但**取值必须来自这张表**；
3. 替换后自查（贴输出）。**命令不依赖 ripgrep**（这台机器没有 rg，见下面的警告）：

       cd web
       # 递归扫（注意：Select-String 传目录**不递归**，必须自己列文件）
       $files = Get-ChildItem -Recurse -File src -Include *.ts,*.tsx | Select-Object -ExpandProperty FullName
       $pat = 'tangtian|linshi|xiaox|yehangxing|changsiqing|linxingyin|qiufengliaoya|taifengfaxiu|bingrong|cixunbai|moxiaox|xinlaide|hainei|yunyindayo|xiaobaitaozi|yuban14831|heshang|yunqi|唐天|唐恬|林诗|长司青|林星尹|秋枫了鸦|台风法修|冰绒の某猫|Minecraft唐天|月枫|坏坏|佚名|BV[0-9A-Za-z]{10}'
       Select-String -Path $files -Pattern $pat
       # 命中数必须是 0；有命中就按上面的名单换掉
       pnpm typecheck

   > ⚠️ **别用 npx rg —— 它在这台机器上是一个「永远通过」的假检查。**
   > 实测：Get-Command rg 命中 0、node_modules/.bin/rg.cmd 不存在，而 npx --no-install rg --version
   > **退出码 0、无输出**（npx 拉了一个同名的脚手架包，还会往工作区丢一个 README.md）。
   > 2026-10-13 四名施工者都据此报过「0 命中」，**那些结论全部无效**。
   >
   > ⚠️ **同一个坑的第二种形态**（W1 踩到）：Select-String 传**目录**时不递归，
   > 于是它也能报「0 命中」。**必须自己把文件列出来再传。**
   >
   > **规矩**：一条检查必须先用「已知有问题的输入」验证它**会红**，才允许用它证明「没问题」。
   > **永远通过的检查比没有检查更糟。**（与 缺陷处理总纲 §7「看产物不看退出码」同源。）

4. **改完必须出图**（至少一张该页面的浅色图）并 `read_image` 看过 —— 名字换了之后**布局可能被撑破**（长昵称、`demo-` 前缀比原来的 handle 长），这正是要看的。

## 这条为什么值得单独记

「把截图里的名字抄进 mock」这个动作，做的人当时不觉得有问题（截图是公开的社区页面）。
但它把**真人的身份**从「公开页面上的公开信息」搬到了「我们自己构建并分发的产物里」——
两件事的暴露面不一样：前者是他们选择公开，后者是我们替他们决定。
**规矩的反面同样成立**：如果哪天需要更真实的数据，那就造数据，不要抄。