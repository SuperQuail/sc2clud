//! 仓储函数：只做 SQL，不含业务规则（规则在 web / 领域层）。
//!
//! 约定：
//! - 多语句写操作一律放进事务；
//! - 软删除（`deleted_at`）保留审计线索，blob 的 `refcount` 同步扣减；
//! - 计数走 [`flush_counters`]，不在请求路径里直接 UPDATE。

use sc2clud_core::Result;
use sqlx::{SqlitePool, query, query_as};

use crate::db_err;
use crate::models::{
    AuditRow, BlobRow, FileRow, FileWithOwnerRow, ImageJobRow, PostImageRow, PostRow,
    UploadSessionRow, UserRow,
};

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

/// 文件统计（首页展示用）。
#[derive(Debug, Clone, Default)]
pub struct FileStats {
    pub files: i64,
    pub bytes: i64,
    pub downloads: i64,
}

/// 一次聚合查询拿到三个数字，避免首页发三条 SQL。
pub async fn file_stats(pool: &SqlitePool, owner_id: i64) -> Result<FileStats> {
    let row: (i64, i64, i64) = query_as(
        "SELECT COUNT(*), COALESCE(SUM(size), 0), COALESCE(SUM(download_count), 0) \
         FROM files WHERE owner_id = ? AND deleted_at IS NULL",
    )
    .bind(owner_id)
    .fetch_one(pool)
    .await
    .map_err(db_err)?;
    Ok(FileStats {
        files: row.0,
        bytes: row.1,
        downloads: row.2,
    })
}

// ---------------------------------------------------------------- 帖子（类型 + 审核）

/// 新建帖子的入参（含审核结论）。
///
/// 参数多且同型（四个 `&str`、两个 `i64`），用具名结构体避免调用处顺序错位。
pub struct NewPost<'a> {
    pub author_id: i64,
    pub kind: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub image_count: i64,
    pub review_state: &'a str,
    pub review_note: Option<&'a str>,
    pub now: i64,
}

/// 新建帖子并写入审核结论。返回帖子 id。
pub async fn create_post_reviewed(pool: &SqlitePool, post: NewPost<'_>) -> Result<i64> {
    let res = query(
        "INSERT INTO posts (author_id, title, body, created_at, updated_at, kind, review_state, \
                            review_note, auto_reviewed, image_count) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
    )
    .bind(post.author_id)
    .bind(post.title)
    .bind(post.body)
    .bind(post.now)
    .bind(post.now)
    .bind(post.kind)
    .bind(post.review_state)
    .bind(post.review_note)
    .bind(post.image_count)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

/// feed：只排除被拒的帖子（审核中仍然可见——当前阶段不卡审核）。
pub async fn list_visible_posts(
    pool: &SqlitePool,
    limit: i64,
    offset: i64,
) -> Result<Vec<PostRow>> {
    query_as::<_, PostRow>(
        "SELECT * FROM posts WHERE deleted_at IS NULL AND review_state <> 'rejected' \
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
    )
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

pub async fn get_post(pool: &SqlitePool, id: i64) -> Result<Option<PostRow>> {
    query_as::<_, PostRow>("SELECT * FROM posts WHERE id = ? AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)
}

/// 管理员人工改判（把审核机判 pending 的帖子放行或拒绝）。
pub async fn set_post_review_state(
    pool: &SqlitePool,
    post_id: i64,
    state: &str,
    note: Option<&str>,
    by: i64,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "UPDATE posts SET review_state = ?, review_note = ?, reviewed_at = ?, reviewed_by = ?, \
                           auto_reviewed = 0 \
         WHERE id = ?",
    )
    .bind(state)
    .bind(note)
    .bind(now)
    .bind(by)
    .bind(post_id)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

// ---------------------------------------------------------------- 帖子图片

/// 登记一张帖子图片并**同时排入处理队列**（同一事务，避免图丢了任务）。
///
/// 原图哈希是内容寻址的原图；压缩结果稍后由后台工作线程回填到同一行。
pub async fn add_post_image(
    pool: &SqlitePool,
    post_id: i64,
    position: i64,
    original_hash: &str,
    original_bytes: i64,
    mime: &str,
    now: i64,
) -> Result<i64> {
    let mut tx = pool.begin().await.map_err(db_err)?;
    let image_id = query(
        "INSERT INTO post_images (post_id, position, original_hash, original_bytes, mime, state, created_at) \
         VALUES (?, ?, ?, ?, ?, 'processing', ?)",
    )
    .bind(post_id)
    .bind(position)
    .bind(original_hash)
    .bind(original_bytes)
    .bind(mime)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?
    .last_insert_rowid();

    query(
        "INSERT INTO image_jobs (image_id, original_hash, state, attempts, created_at, updated_at) \
         VALUES (?, ?, 'queued', 0, ?, ?)",
    )
    .bind(image_id)
    .bind(original_hash)
    .bind(now)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;

    query("UPDATE posts SET image_count = image_count + 1 WHERE id = ?")
        .bind(post_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;

    tx.commit().await.map_err(db_err)?;
    Ok(image_id)
}

pub async fn list_post_images(pool: &SqlitePool, post_id: i64) -> Result<Vec<PostImageRow>> {
    query_as::<_, PostImageRow>("SELECT * FROM post_images WHERE post_id = ? ORDER BY position, id")
        .bind(post_id)
        .fetch_all(pool)
        .await
        .map_err(db_err)
}

/// 回填压缩结果（工作线程调用）。
pub async fn finish_post_image(
    pool: &SqlitePool,
    image_id: i64,
    display_hash: &str,
    thumb_hash: &str,
    width: i64,
    height: i64,
    display_bytes: i64,
) -> Result<()> {
    query(
        "UPDATE post_images SET display_hash = ?, thumb_hash = ?, width = ?, height = ?, \
                                 display_bytes = ?, state = 'ready' \
         WHERE id = ?",
    )
    .bind(display_hash)
    .bind(thumb_hash)
    .bind(width)
    .bind(height)
    .bind(display_bytes)
    .bind(image_id)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(())
}

pub async fn fail_post_image(pool: &SqlitePool, image_id: i64) -> Result<()> {
    query("UPDATE post_images SET state = 'failed' WHERE id = ?")
        .bind(image_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

// ---------------------------------------------------------------- 图片任务队列

/// 取一批待处理任务并**在事务里标记 running**（多进程/多线程都不会重复取）。
pub async fn claim_image_jobs(pool: &SqlitePool, limit: i64, now: i64) -> Result<Vec<ImageJobRow>> {
    let mut tx = pool.begin().await.map_err(db_err)?;
    let mut jobs = query_as::<_, ImageJobRow>(
        "SELECT * FROM image_jobs WHERE state = 'queued' ORDER BY id LIMIT ?",
    )
    .bind(limit)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;

    for job in &jobs {
        query("UPDATE image_jobs SET state = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ?")
            .bind(now)
            .bind(job.id)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;

    // 上面读的是更新前的快照，这里同步成事务提交后的真实状态，避免调用方看到过期值。
    for job in &mut jobs {
        job.state = "running".to_string();
        job.attempts += 1;
        job.updated_at = now;
    }
    Ok(jobs)
}

pub async fn finish_image_job(pool: &SqlitePool, job_id: i64, now: i64) -> Result<()> {
    query("UPDATE image_jobs SET state = 'done', updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(job_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

pub async fn fail_image_job(pool: &SqlitePool, job_id: i64, error: &str, now: i64) -> Result<()> {
    query("UPDATE image_jobs SET state = 'failed', last_error = ?, updated_at = ? WHERE id = ?")
        .bind(error)
        .bind(now)
        .bind(job_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

pub async fn pending_image_jobs(pool: &SqlitePool) -> Result<i64> {
    let row: (i64,) =
        query_as("SELECT COUNT(*) FROM image_jobs WHERE state IN ('queued','running')")
            .fetch_one(pool)
            .await
            .map_err(db_err)?;
    Ok(row.0)
}
// ---------------------------------------------------------------- 账号、激活与角色

/// 注册：创建账号。`activated` 由调用方按站点设置决定（默认要求管理员激活）。
pub async fn register_user(
    pool: &SqlitePool,
    handle: &str,
    email: &str,
    password_hash: &str,
    activated: bool,
    now: i64,
) -> Result<i64> {
    let activated_at: Option<i64> = activated.then_some(now);
    let res = query(
        "INSERT INTO users (handle, email, password_hash, role, quota_bytes, used_bytes, created_at, activated_at, activated_by) \
         VALUES (?, ?, ?, 'member', 1073741824, 0, ?, ?, NULL)",
    )
    .bind(handle)
    .bind(email)
    .bind(password_hash)
    .bind(now)
    .bind(activated_at)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

pub async fn find_user_by_email(pool: &SqlitePool, email: &str) -> Result<Option<UserRow>> {
    query_as::<_, UserRow>("SELECT * FROM users WHERE email = ?")
        .bind(email)
        .fetch_optional(pool)
        .await
        .map_err(db_err)
}

/// 激活 / 停用。返回是否真的改了状态（幂等：重复调用返回 false）。
pub async fn set_user_activated(
    pool: &SqlitePool,
    user_id: i64,
    activated: bool,
    by: i64,
    now: i64,
) -> Result<bool> {
    let affected = if activated {
        query(
            "UPDATE users SET activated_at = ?, activated_by = ? \
             WHERE id = ? AND activated_at IS NULL",
        )
        .bind(now)
        .bind(by)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected()
    } else {
        query("UPDATE users SET activated_at = NULL, activated_by = ? WHERE id = ? AND activated_at IS NOT NULL")
            .bind(by)
            .bind(user_id)
            .execute(pool)
            .await
            .map_err(db_err)?
            .rows_affected()
    };
    Ok(affected == 1)
}

pub async fn set_user_role(pool: &SqlitePool, user_id: i64, role: &str) -> Result<bool> {
    let affected = query("UPDATE users SET role = ? WHERE id = ? AND role <> ?")
        .bind(role)
        .bind(user_id)
        .bind(role)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected == 1)
}

pub async fn find_user_by_id_any(pool: &SqlitePool, id: i64) -> Result<Option<UserRow>> {
    query_as::<_, UserRow>("SELECT * FROM users WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)
}

pub async fn list_users(pool: &SqlitePool, limit: i64, offset: i64) -> Result<Vec<UserRow>> {
    query_as::<_, UserRow>("SELECT * FROM users ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await
        .map_err(db_err)
}

pub async fn count_users(pool: &SqlitePool) -> Result<i64> {
    let row: (i64,) = query_as("SELECT COUNT(*) FROM users")
        .fetch_one(pool)
        .await
        .map_err(db_err)?;
    Ok(row.0)
}

// ---------------------------------------------------------------- 站点设置

pub async fn get_setting(pool: &SqlitePool, key: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = query_as("SELECT value FROM settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;
    Ok(row.map(|r| r.0))
}

pub async fn set_setting(
    pool: &SqlitePool,
    key: &str,
    value: &str,
    by: Option<i64>,
    now: i64,
) -> Result<()> {
    query(
        "INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, \
                                 updated_by = excluded.updated_by",
    )
    .bind(key)
    .bind(value)
    .bind(now)
    .bind(by)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(())
}

/// 注册后是否需要管理员手动激活（默认需要；超级管理员可关掉）。
pub const SETTING_REQUIRE_ACTIVATION: &str = "registration.require_activation";

pub async fn registration_requires_activation(pool: &SqlitePool) -> Result<bool> {
    let raw = get_setting(pool, SETTING_REQUIRE_ACTIVATION).await?;
    Ok(raw.as_deref() != Some("0"))
}

// ---------------------------------------------------------------- 审计

pub async fn record_audit(
    pool: &SqlitePool,
    actor_id: Option<i64>,
    action: &str,
    target: Option<&str>,
    detail: Option<&str>,
    now: i64,
) -> Result<()> {
    query("INSERT INTO audit_log (actor_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(actor_id)
        .bind(action)
        .bind(target)
        .bind(detail)
        .bind(now)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

pub async fn recent_audit(pool: &SqlitePool, limit: i64) -> Result<Vec<AuditRow>> {
    query_as::<_, AuditRow>("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(db_err)
}

pub async fn counter_value(pool: &SqlitePool, key: &str) -> Result<i64> {
    let row: Option<(i64,)> = query_as("SELECT value FROM counters WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;
    Ok(row.map(|r| r.0).unwrap_or(0))
}
