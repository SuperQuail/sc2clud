# 图片的访问控制（`/img/{hash}`）

所有图片字节都落在内容寻址存储里，通过 `/img/{hash}` 读取。hash 不可猜（内容摘要），
因此**枚举**不是威胁；但「谁可以读」仍然要有明确规则。

## 可见性模型

记在 `blobs` 表的两个列上（迁移 `0034_blob_visibility.sql`）：

| `private` | 谁能读 |
| --- | --- |
| `0`（默认） | 任何人。内容寻址 + 长缓存 |
| `1` | **所有者本人**与**管理员及以上** |

实现位置：`crates/sc2clud-web/src/pages_media.rs::serve_image`。未在 `post_images` 登记过的 blob
（发帖前上传的插图、收款码等）也能读，MIME 从文件头 32 字节嗅探。

## 当前分类

| 图片 | 可见性 | 说明 |
| --- | --- | --- |
| 帖子配图、正文插图 | **公开** | 上传时不标记 |
| 头像 | **公开** | 走 `/avatar/{hash}`，同一套内容寻址判断 |
| **付款方式图片（收款码）** | **保密** | 上传时调用 `repo::mark_blob_private(pool, &hash, user.id)` |

## 新增一种保密图片

在写入处加一次调用即可（`blobs` 行必须先存在，所以先 `ensure_blob`）：

```rust
repo::ensure_blob(state.db.pool(), &hash, size, now).await?;
repo::mark_blob_private(state.db.pool(), &hash, owner_id).await?;
```

## 已知后果与待办

- **收款码现在只有所有者与管理员可见**：访客打开赞助弹窗时收款码取不到（裂图）。
  若将来要允许**已登录访客**查看，应新增一档「登录可见」（例如 `private = 2` 或单独一列），
  **不要**把它改回公开。
- blob 存储**默认公开**：任何不该公开的内容都不要放进去（这是设计前提，不是缺陷）。
- 未实现：删除图片时的级联清理（无引用 blob 靠引用计数回收，尚未接线）。
