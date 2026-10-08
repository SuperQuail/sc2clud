//! 行结构：与 `migrations/` 中的表一一对应。
//!
//! 时间字段一律是 Unix 秒（`INTEGER`），不引入日期库。

use sqlx::FromRow;

#[derive(Debug, Clone, FromRow)]
pub struct UserRow {
    pub id: i64,
    /// 登录名：账号标识，唯一，用于登录。
    pub handle: String,
    /// 显示名：对外展示，非空、≤ 20 字符，可改。
    pub display_name: String,
    /// 头像摘要（NULL = 未设置）。
    pub avatar_hash: Option<String>,
    /// 头像 MIME。
    pub avatar_mime: Option<String>,
    pub email: Option<String>,
    pub password_hash: String,
    pub role: String,
    pub quota_bytes: i64,
    pub used_bytes: i64,
    pub created_at: i64,
    pub disabled_at: Option<i64>,
    /// `None` = 未激活（能登录，但不能发帖/回复/上传）。
    pub activated_at: Option<i64>,
    pub activated_by: Option<i64>,
}

/// 会话行（库里只存令牌摘要）。
#[derive(Debug, Clone, FromRow)]
pub struct SessionRow {
    pub id: String,
    pub user_id: i64,
    pub csrf_token: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub last_seen_at: i64,
    pub user_agent: Option<String>,
}

/// 帖子 + 作者（feed 用一次 join 拿全，避免 N+1）。
#[derive(Debug, Clone, FromRow)]
pub struct PostWithAuthorRow {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub kind: String,
    pub section: String,
    pub review_state: String,
    pub review_note: Option<String>,
    pub image_count: i64,
    pub created_at: i64,
    pub author_id: i64,
    pub author_handle: String,
    /// 对外展示用：帖子卡片与详情页显示它。
    pub author_display_name: String,
    /// 作者头像的内容摘要（NULL = 没设置，页面回退到首字母）。
    pub author_avatar: Option<String>,
    pub author_role: String,
    /// 封面图：该帖第一张图（压缩图优先，未处理时用原图）；没有图则为 NULL。
    pub cover_hash: Option<String>,
    /// 回复数（列表视图的统计条用）。
    pub comment_count: i64,
}

/// 回复 + 作者。
#[derive(Debug, Clone, FromRow)]
pub struct CommentWithAuthorRow {
    pub id: i64,
    pub post_id: i64,
    pub author_id: i64,
    pub author_handle: String,
    pub author_display_name: String,
    pub author_avatar: Option<String>,
    pub body: String,
    pub created_at: i64,
}

/// 启动器发布版本。
#[derive(Debug, Clone, FromRow)]
pub struct ReleaseRow {
    pub id: i64,
    pub version: String,
    pub channel: String,
    pub title: Option<String>,
    pub notes: Option<String>,
    pub is_published: i64,
    pub created_by: Option<i64>,
    pub created_at: i64,
    pub published_at: Option<i64>,
}

/// 发布产物条目：**只有外部直链，没有本地副本**（本站不承载字节）。
#[derive(Debug, Clone, FromRow)]
pub struct ReleaseAssetRow {
    pub id: i64,
    pub release_id: i64,
    pub platform: String,
    pub arch: String,
    pub filename: String,
    /// 真正的分发地址（GitHub Releases / 对象存储 / 镜像）。
    pub url: String,
    pub size: i64,
    pub sha256: Option<String>,
    pub download_count: i64,
    pub created_at: i64,
}

/// 一条私信。
#[derive(Debug, Clone, FromRow)]
pub struct MessageRow {
    pub id: i64,
    pub sender_id: i64,
    pub recipient_id: i64,
    pub body: String,
    pub created_at: i64,
    pub read_at: Option<i64>,
}

/// 会话列表里的一行：对方 + 最后一条 + 未读数。
#[derive(Debug, Clone, FromRow)]
pub struct ConversationRow {
    pub other_id: i64,
    pub other_handle: String,
    pub other_display_name: String,
    pub other_avatar: Option<String>,
    pub last_body: String,
    pub last_at: i64,
    pub last_from_me: i64,
    pub unread: i64,
}

/// 黑名单里的一行。
#[derive(Debug, Clone, FromRow)]
pub struct BlockRow {
    pub handle: String,
    pub display_name: String,
    pub avatar_hash: Option<String>,
    pub created_at: i64,
}

/// 管理页的用户行：比 `UserRow` 多带「最后在线」（取该用户最近一次会话）。
#[derive(Debug, Clone, FromRow)]
pub struct AdminUserRow {
    pub id: i64,
    pub handle: String,
    pub display_name: String,
    pub email: Option<String>,
    pub role: String,
    pub created_at: i64,
    pub activated_at: Option<i64>,
    pub avatar_hash: Option<String>,
    pub last_seen_at: Option<i64>,
    /// 分配给该账号的磁盘预算（字节）。默认 0 = 不分配。
    pub quota_bytes: i64,
    /// 已占用（消费逻辑之后再做，现在恒为 0）。
    pub used_bytes: i64,
}

/// 资源帖的下载来源（网盘 / GitHub / 直链）。
#[derive(Debug, Clone, FromRow)]
pub struct PostSourceRow {
    pub id: i64,
    pub post_id: i64,
    pub position: i64,
    /// baidu | quark | aliyun | lanzou | 123pan | weiyun | github | direct
    pub provider: String,
    pub label: Option<String>,
    pub url: String,
    pub extract_code: Option<String>,
    pub created_at: i64,
}

/// 审核流水 / 管理动作审计行。
#[derive(Debug, Clone, FromRow)]
pub struct AuditRow {
    pub id: i64,
    pub actor_id: Option<i64>,
    pub action: String,
    pub target: Option<String>,
    pub detail: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct BlobRow {
    pub hash: String,
    pub size: i64,
    pub refcount: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct FileRow {
    pub id: i64,
    pub owner_id: i64,
    pub blob_hash: String,
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub created_at: i64,
    pub deleted_at: Option<i64>,
    pub download_count: i64,
}

/// 下载页需要的联合视图（文件 + 上传者）。
#[derive(Debug, Clone, FromRow)]
pub struct FileWithOwnerRow {
    pub id: i64,
    pub name: String,
    pub mime: String,
    pub size: i64,
    pub blob_hash: String,
    pub download_count: i64,
    pub created_at: i64,
    pub owner_id: i64,
    pub owner_handle: String,
}

#[derive(Debug, Clone, FromRow)]
pub struct PostRow {
    pub id: i64,
    pub author_id: i64,
    pub title: String,
    pub body: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
    /// discussion | resource | repost
    pub kind: String,
    /// 分区（vanilla_mod | custom_campaign | tool_player | tool_dev）
    pub section: String,
    /// pending | approved | rejected（只有 rejected 不可见）
    pub review_state: String,
    pub review_note: Option<String>,
    pub reviewed_at: Option<i64>,
    pub reviewed_by: Option<i64>,
    pub auto_reviewed: i64,
    pub image_count: i64,
}

/// 帖子图片：原图永久保留，压缩图/缩略图由后台任务补齐。
#[derive(Debug, Clone, FromRow)]
pub struct PostImageRow {
    pub id: i64,
    pub post_id: i64,
    pub position: i64,
    pub original_hash: String,
    pub display_hash: Option<String>,
    pub thumb_hash: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub original_bytes: i64,
    pub display_bytes: Option<i64>,
    pub mime: String,
    /// processing | ready | failed
    pub state: String,
    pub created_at: i64,
}

/// 图片处理队列项（请求路径内绝不转码）。
#[derive(Debug, Clone, FromRow)]
pub struct ImageJobRow {
    pub id: i64,
    pub image_id: i64,
    pub original_hash: String,
    pub state: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, FromRow)]
pub struct CommentRow {
    pub id: i64,
    pub post_id: i64,
    pub author_id: i64,
    pub body: String,
    pub created_at: i64,
    pub deleted_at: Option<i64>,
}

#[derive(Debug, Clone, FromRow)]
pub struct UploadSessionRow {
    pub id: String,
    pub owner_id: i64,
    pub name: String,
    pub expected_hash: Option<String>,
    pub declared_size: i64,
    pub received_bytes: i64,
    pub chunk_size: i64,
    pub received_chunks: String,
    pub created_at: i64,
    pub expires_at: i64,
}
