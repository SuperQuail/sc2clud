//! 仓储函数：只做 SQL，不含业务规则（规则在 web / 领域层）。
//!
//! 约定：
//! - 多语句写操作一律放进事务；
//! - 软删除（`deleted_at`）保留审计线索，blob 的 `refcount` 同步扣减；
//! - 计数走 [`flush_counters`]，不在请求路径里直接 UPDATE。

use sc2clud_core::Result;
use sqlx::{SqlitePool, query, query_as};

use crate::db_err;
use crate::models::{BlobRow, FileRow, FileWithOwnerRow, PostRow, UploadSessionRow, UserRow};

// ---------------------------------------------------------------- 用户

pub async fn create_user(
    pool: &SqlitePool,
    handle: &str,
    email: Option<&str>,
    password_hash: &str,
    quota_bytes: i64,
    now: i64,
) -> Result<i64> {
    let res = query(
        "INSERT INTO users (handle, email, password_hash, role, quota_bytes, used_bytes, created_at) \
         VALUES (?, ?, ?, 'member', ?, 0, ?)",
    )
    .bind(handle)
    .bind(email)
    .bind(password_hash)
    .bind(quota_bytes)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

/// 累加用户已用空间（上传成功后调用；下限夹到 0，避免计数错乱导致负值）。
pub async fn add_used_bytes(pool: &SqlitePool, user_id: i64, delta: i64) -> Result<()> {
    query("UPDATE users SET used_bytes = MAX(0, used_bytes + ?) WHERE id = ?")
        .bind(delta)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

/// 启动时确保归属用户存在。
///
/// **脚手架阶段的临时设施**：尚未接入登录，站点内容先挂在这个用户下。
/// 会话/鉴权落地后，这里应改为「按会话解析当前用户」，并删除本函数。
pub async fn ensure_bootstrap_user(
    pool: &SqlitePool,
    handle: &str,
    quota_bytes: i64,
    now: i64,
) -> Result<i64> {
    if let Some(user) = find_user_by_handle(pool, handle).await? {
        return Ok(user.id);
    }
    // 口令哈希留空：该账号不允许口令登录（没有登录路径），只能由会话绑定。
    create_user(pool, handle, None, "!", quota_bytes, now).await
}

pub async fn find_user_by_id(pool: &SqlitePool, id: i64) -> Result<Option<UserRow>> {
    query_as::<_, UserRow>("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)
}

pub async fn find_user_by_handle(pool: &SqlitePool, handle: &str) -> Result<Option<UserRow>> {
    query_as::<_, UserRow>("SELECT * FROM users WHERE handle = ? AND disabled_at IS NULL")
        .bind(handle)
        .fetch_optional(pool)
        .await
        .map_err(db_err)
}

// ---------------------------------------------------------------- 内容寻址

/// 登记一份内容（幂等，秒传与普通上传共用）。
///
/// 返回 `true` 表示这是**首次**登记该内容——调用方据此判断是否真的写了盘。
pub async fn ensure_blob(pool: &SqlitePool, hash: &str, size: i64, now: i64) -> Result<bool> {
    let mut tx = pool.begin().await.map_err(db_err)?;
    let inserted =
        query("INSERT OR IGNORE INTO blobs (hash, size, refcount, created_at) VALUES (?, ?, 0, ?)")
            .bind(hash)
            .bind(size)
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?
            .rows_affected()
            == 1;
    query("UPDATE blobs SET refcount = refcount + 1 WHERE hash = ?")
        .bind(hash)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok(inserted)
}

pub async fn find_blob(pool: &SqlitePool, hash: &str) -> Result<Option<BlobRow>> {
    query_as::<_, BlobRow>("SELECT * FROM blobs WHERE hash = ?")
        .bind(hash)
        .fetch_optional(pool)
        .await
        .map_err(db_err)
}

/// 新建文件记录的入参。
///
/// 参数多且同型（两个 `&str`、两个 `i64`），用具名结构体避免调用处顺序错位。
pub struct NewFile<'a> {
    pub owner_id: i64,
    pub blob_hash: &'a str,
    pub name: &'a str,
    pub mime: &'a str,
    pub size: i64,
    pub now: i64,
}

/// 建立文件记录。调用方应先用 [`ensure_blob`] 登记内容。
pub async fn create_file(pool: &SqlitePool, file: NewFile<'_>) -> Result<i64> {
    let res = query(
        "INSERT INTO files (owner_id, blob_hash, name, mime, size, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(file.owner_id)
    .bind(file.blob_hash)
    .bind(file.name)
    .bind(file.mime)
    .bind(file.size)
    .bind(file.now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

pub async fn get_file(pool: &SqlitePool, id: i64) -> Result<Option<FileRow>> {
    query_as::<_, FileRow>("SELECT * FROM files WHERE id = ? AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)
}

pub async fn get_file_with_owner(pool: &SqlitePool, id: i64) -> Result<Option<FileWithOwnerRow>> {
    query_as::<_, FileWithOwnerRow>(
        "SELECT f.id, f.name, f.mime, f.size, f.blob_hash, f.download_count, f.created_at, \
                f.owner_id, u.handle AS owner_handle \
         FROM files f JOIN users u ON u.id = f.owner_id \
         WHERE f.id = ? AND f.deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)
}

pub async fn list_files(pool: &SqlitePool, owner_id: i64, limit: i64) -> Result<Vec<FileRow>> {
    query_as::<_, FileRow>(
        "SELECT * FROM files WHERE owner_id = ? AND deleted_at IS NULL \
         ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .bind(owner_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

/// 软删除文件并扣减内容引用计数；返回是否真的删了一条。
pub async fn soft_delete_file(pool: &SqlitePool, id: i64, owner_id: i64, now: i64) -> Result<bool> {
    let mut tx = pool.begin().await.map_err(db_err)?;

    let existing: Option<(String, i64)> = query_as(
        "SELECT blob_hash, size FROM files WHERE id = ? AND owner_id = ? AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(owner_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_err)?;

    let Some((blob_hash, size)) = existing else {
        return Ok(false);
    };

    query("UPDATE files SET deleted_at = ? WHERE id = ?")
        .bind(now)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    query("UPDATE blobs SET refcount = refcount - 1 WHERE hash = ?")
        .bind(&blob_hash)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    query("UPDATE users SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?")
        .bind(size)
        .bind(owner_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;

    tx.commit().await.map_err(db_err)?;
    Ok(true)
}

// ---------------------------------------------------------------- 分片上传

/// 新建分片上传会话的入参。
pub struct NewUploadSession<'a> {
    pub id: &'a str,
    pub owner_id: i64,
    pub name: &'a str,
    pub declared_size: i64,
    pub chunk_size: i64,
    pub now: i64,
    pub expires_at: i64,
}

pub async fn create_upload_session(pool: &SqlitePool, session: NewUploadSession<'_>) -> Result<()> {
    query(
        "INSERT INTO upload_sessions \
         (id, owner_id, name, expected_hash, declared_size, received_bytes, chunk_size, received_chunks, created_at, expires_at) \
         VALUES (?, ?, ?, NULL, ?, 0, ?, '[]', ?, ?)",
    )
    .bind(session.id)
    .bind(session.owner_id)
    .bind(session.name)
    .bind(session.declared_size)
    .bind(session.chunk_size)
    .bind(session.now)
    .bind(session.expires_at)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(())
}

pub async fn find_upload_session(pool: &SqlitePool, id: &str) -> Result<Option<UploadSessionRow>> {
    query_as::<_, UploadSessionRow>("SELECT * FROM upload_sessions WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)
}

// ---------------------------------------------------------------- 社区内容

pub async fn create_post(
    pool: &SqlitePool,
    author_id: i64,
    title: &str,
    body: &str,
    now: i64,
) -> Result<i64> {
    let res = query(
        "INSERT INTO posts (author_id, title, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(author_id)
    .bind(title)
    .bind(body)
    .bind(now)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

pub async fn list_posts(pool: &SqlitePool, limit: i64, offset: i64) -> Result<Vec<PostRow>> {
    query_as::<_, PostRow>(
        "SELECT * FROM posts WHERE deleted_at IS NULL \
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

pub async fn count_posts(pool: &SqlitePool) -> Result<i64> {
    let row: (i64,) = query_as("SELECT COUNT(*) FROM posts WHERE deleted_at IS NULL")
        .fetch_one(pool)
        .await
        .map_err(db_err)?;
    Ok(row.0)
}

// ---------------------------------------------------------------- 写回缓冲

/// 批量落库计数增量：**一个事务、一次提交**，这是写热点唯一的落点。
pub async fn flush_counters(pool: &SqlitePool, drained: &[(String, i64)]) -> Result<()> {
    if drained.is_empty() {
        return Ok(());
    }
    let mut tx = pool.begin().await.map_err(db_err)?;
    for (key, delta) in drained {
        query(
            "INSERT INTO counters (key, value) VALUES (?, ?) \
             ON CONFLICT(key) DO UPDATE SET value = value + excluded.value",
        )
        .bind(key)
        .bind(delta)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    Ok(())
}

pub async fn counter_value(pool: &SqlitePool, key: &str) -> Result<i64> {
    let row: Option<(i64,)> = query_as("SELECT value FROM counters WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;
    Ok(row.map(|r| r.0).unwrap_or(0))
}
