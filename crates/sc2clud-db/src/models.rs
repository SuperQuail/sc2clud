//! 行结构：与 `migrations/` 中的表一一对应。
//!
//! 时间字段一律是 Unix 秒（`INTEGER`），不引入日期库。

use sqlx::FromRow;

#[derive(Debug, Clone, FromRow)]
pub struct UserRow {
    pub id: i64,
    pub handle: String,
    pub email: Option<String>,
    pub password_hash: String,
    pub role: String,
    pub quota_bytes: i64,
    pub used_bytes: i64,
    pub created_at: i64,
    pub disabled_at: Option<i64>,
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
