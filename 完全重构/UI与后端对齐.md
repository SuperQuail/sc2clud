# UI 与后端对齐（2026-10-13 上线前盘点）

> 两条规则（用户拍板）：**后端有、UI 没有的 → 写文档排期；前端有、后端没有的 → 暂时隐藏，也写在这儿**。
> 时间不够，所以这里既是一份账、也是「上线时哪些门面被藏起来了」的记录。

## 一、后端有、UI 没有（能补，按价值排）

| # | 后端能力 | 端点 | 用户体感 | 为什么没做 |
|---|---|---|---|---|
| 1 | **用户搜索** | `GET /api/v1/users/search?q=&limit=` | 搜不到人（首页搜索只管帖子） | 让出搜索后新出现的缺口；返回 `{id,handle,nickname,avatar,level,ambiguous}`，接进首页搜索的第二个页签即可 |
| 2 | **通知静音** | `PUT/DELETE /api/v1/notifications/mutes` | 没法「不再收到这类通知」 | 施工者**故意没做**：probe-admin 一条通知都没有，无法在 dev 上验证静音真的生效 —— 不交没验过的按钮 |
| 3 | **撤回私信** | `DELETE /api/v1/messages/:id` | 发错了撤不回 | 气泡由共享件 `NoticeChat` 渲染、没有逐条动作槽位；要加得改那个 DevRoom 已验证过的控件（要走房间重新验证） |
| 4 | **帖子申诉** | `POST /api/v1/topics/{id}/review/appeal`（**后端也没有**，见第二节） | — | — |
| 5 | **我的举报 / 我的收藏** | `GET /me/reports`、`GET /me/bookmarks` | — | **已补**（`/me` 页，内嵌在顶栏「我的」） |
| 6 | **数据导入后的搜索索引** | `forum reindex` | — | **已补**（子命令；迁移进来的老帖靠它才搜得到） |

## 二、前端有、后端没有（**上线前已隐藏**）

| # | 前端的东西 | 缺什么 | 处理 |
|---|---|---|---|
| 1 | **申诉页 `/appeal`** | `POST /api/v1/appeals` **不存在**（§21.2 里只有帖子的 `review/appeal`，而那条后端也没实现） | **已隐藏**：路由与入口都撤掉（登录页页脚那条「账号被封了？提交申诉」也去掉）—— 留着就是点进去填完表单必然失败的坑 |
| 2 | **帖子的「申请人工复核」** | 同上，`POST /topics/{id}/review/appeal` 不存在 | 未在任何产品页出现过（只有 `lib/api/social.ts` 里包了个函数、0 调用） |
| 3 | **「消息设置」面板** | 提醒总开关 / 回复@接收范围**没有端点**（notify 只有 list/unread-count/read/mutes/delete） | 没有进产品页，DevRoom 里的设计稿保留 |
| 4 | **密码重置文案** | `POST /auth/password/forgot` 不存在 | 登录页页脚只留一句实话（请管理员重置），**没有假入口** |
| 5 | **「最热」排序** | 后端只有 `latest`/`new` | **已移除**（它需要热度列 + 非时间戳游标键，不是补一行） |

## 三、迁移丢了什么（**数据**，不是代码）

清单与「能不能补」：

| 老站的东西 | 现状 | 能不能补 |
|---|---|---|
| `posts` 的 3 张配图 | 图片字节在 `images` 里（8 行），但**帖子正文里没有引用**（老站 `post_images` 是独立表，新站图文关系在正文 Markdown 内） | **能补**：把 `post_images` 映射成 `topic_images(topic_id, image_hash, sort)`，帖子列表就会出现封面 |
| `audit_log`(132，去重后 111) | **完全没迁**（v2 的 SQL 里没有它） | **能补**：`target='post:12'` 拆成 `target_type`/`target_id`、id 换新 public_id、`detail` 进 `jsonb.legacy_detail` |
| `board_acls`(1) | 皇帝区的用户组规则丢了（新站没有用户组） | **能补**：挂到 creator 角色（语义变化，不是等价） |
| 公告区「只有管理员能发帖」 | 丢了 | **不能靠 `min_post_level` 补** —— 那是**等级**门槛（`level >= minLevel`），调成 2 会变成「需要 2 级」。要表达它得用 `board_acls` |
| 老站 13 个 `site_texts` 键 | 全丢（AI 审核 / 邮件节流配置） | 新站没有对应功能，**补不了** |
| `sessions`(55) / `notifications`(7) / `counters`(8) / `ai_secrets`(1) | 不迁（有意的） | 旧会话必须失效；老通知的 `link` 是 `/p/12` 死链；老计数器本身是脏的；AI 主密钥不在备份里 |
| `users.display_name` 超 20 字的 | 截断到 20（`varchar(20)`） | 要保留得改列宽 |
| `users.email` 为 NULL 的 | 补 `<handle>@example.com`（保留域，收不到信） | 补不了真邮箱 |
| `mail_accounts` 的密文 | 只搬壳、密文置 NULL | 老站主密钥不在备份里，要在后台重填 API key |

## 四、上线那一刻的门面（**数据为空，不是功能缺失**）

- **下载页上线是空的**：`GET /launcher/releases` = `[]`、`/launcher/latest` = `404 common.not_found`（**业务** 404：路由在、只是没有已发布版本）。顶栏「下载」与页脚「启动器下载」都指向它，首屏会写「还没有发布稳定版」。
  **要么**上线前用管理端录一个 published release（`POST /admin/launcher/releases` + `/assets`），**要么**接受这个门面是空的 —— 这是**数据**，不是代码。
- **通知中心对所有人都是空的**（未读 0）：功能是通的，只是还没有触发过通知。
- **新站的帖子没有配图**（见第三节第 1 行）。