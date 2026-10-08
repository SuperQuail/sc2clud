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
    AdminUserRow, AnnouncementRow, AuditRow, BlobRow, BlockRow, BookmarkRow, CommentWithAuthorRow,
    ConversationRow, FileRow, FileWithOwnerRow, ImageJobRow, MessageRow, NotificationRow,
    PostImageRow, PostRow, PostSourceRow, PostWithAuthorRow, ReleaseAssetRow, ReleaseRow,
    SessionRow, UploadSessionRow, UserRow,
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

/// 保证站点始终有一个可用的**超级管理员**账号（启动时调用）。
///
/// 该账号的口令默认是不可用的占位哈希，必须由运维执行
/// `sc2clud set-password <用户名> <口令>` 之后才能登录——所以不存在「默认口令」风险。
/// 已存在的账号若角色不是 super 或被停用，会在这里被纠正并记录一条警告。
pub async fn ensure_super_admin(
    pool: &SqlitePool,
    handle: &str,
    quota_bytes: i64,
    now: i64,
) -> Result<i64> {
    let existing: Option<UserRow> = query_as::<_, UserRow>("SELECT * FROM users WHERE handle = ?")
        .bind(handle)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;

    match existing {
        Some(user) => {
            if user.role != "super" || user.activated_at.is_none() {
                query(
                    "UPDATE users SET role = 'super', \
                     activated_at = COALESCE(activated_at, ?), \
                     display_name = CASE WHEN display_name = '' THEN handle ELSE display_name END \
                     WHERE id = ?",
                )
                .bind(now)
                .bind(user.id)
                .execute(pool)
                .await
                .map_err(db_err)?;
                tracing::warn!(
                    user.id = user.id,
                    "引导账号已提升为超级管理员并激活（口令仍需 set-password 设置）"
                );
            }
            Ok(user.id)
        }
        None => {
            let email = format!("{handle}@localhost");
            let id = register_user(
                pool,
                NewUser {
                    handle,
                    display_name: handle,
                    email: &email,
                    password_hash: "!",
                    activated: true,
                    now,
                },
            )
            .await?;
            query("UPDATE users SET role = 'super', quota_bytes = ? WHERE id = ?")
                .bind(quota_bytes)
                .bind(id)
                .execute(pool)
                .await
                .map_err(db_err)?;
            tracing::info!(user.id = id, %handle, "已创建引导超级管理员（口令待设置）");
            Ok(id)
        }
    }
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
    pub section: &'a str,
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
        "INSERT INTO posts (author_id, title, body, created_at, updated_at, kind, section, \
                            review_state, review_note, auto_reviewed, image_count) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
    )
    .bind(post.author_id)
    .bind(post.title)
    .bind(post.body)
    .bind(post.now)
    .bind(post.now)
    .bind(post.kind)
    .bind(post.section)
    .bind(post.review_state)
    .bind(post.review_note)
    .bind(post.image_count)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
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

/// 新增下载来源的入参。
pub struct NewPostSource<'a> {
    pub post_id: i64,
    pub position: i64,
    pub provider: &'a str,
    pub label: Option<&'a str>,
    pub url: &'a str,
    pub extract_code: Option<&'a str>,
    pub now: i64,
}

/// 追加一个下载来源。
pub async fn add_post_source(pool: &SqlitePool, source: NewPostSource<'_>) -> Result<i64> {
    let res = query(
        "INSERT INTO post_sources (post_id, position, provider, label, url, extract_code, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(source.post_id)
    .bind(source.position)
    .bind(source.provider)
    .bind(source.label)
    .bind(source.url)
    .bind(source.extract_code)
    .bind(source.now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

pub async fn list_post_sources(pool: &SqlitePool, post_id: i64) -> Result<Vec<PostSourceRow>> {
    query_as::<_, PostSourceRow>(
        "SELECT * FROM post_sources WHERE post_id = ? ORDER BY position, id",
    )
    .bind(post_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

pub async fn count_post_images(pool: &SqlitePool, post_id: i64) -> Result<i64> {
    let row: (i64,) =
        query_as("SELECT COUNT(*) FROM post_images WHERE post_id = ? AND state <> 'failed'")
            .bind(post_id)
            .fetch_one(pool)
            .await
            .map_err(db_err)?;
    Ok(row.0)
}

/// 按内容摘要找图片记录：`/img/{hash}` 只服务**确实登记为帖子图片**的内容，
/// 避免把接口变成任意 blob 的公开读入口。
pub async fn find_post_image_by_hash(
    pool: &SqlitePool,
    hash: &str,
) -> Result<Option<PostImageRow>> {
    query_as::<_, PostImageRow>(
        "SELECT * FROM post_images \
         WHERE (original_hash = ?1 OR display_hash = ?1 OR thumb_hash = ?1) \
           AND state <> 'failed' LIMIT 1",
    )
    .bind(hash)
    .fetch_optional(pool)
    .await
    .map_err(db_err)
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
// ---------------------------------------------------------------- 会话

/// 建会话：库里存的是令牌摘要（`id_hash`），不是令牌本身。
pub async fn create_session(
    pool: &SqlitePool,
    id_hash: &str,
    user_id: i64,
    csrf_token: &str,
    now: i64,
    expires_at: i64,
    user_agent: Option<&str>,
) -> Result<()> {
    query(
        "INSERT INTO sessions (id, user_id, csrf_token, created_at, expires_at, last_seen_at, user_agent) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(id_hash)
    .bind(user_id)
    .bind(csrf_token)
    .bind(now)
    .bind(expires_at)
    .bind(now)
    .bind(user_agent)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(())
}

/// 取会话与用户；过期或被停用的账号直接当不存在。
pub async fn load_session(
    pool: &SqlitePool,
    id_hash: &str,
    now: i64,
) -> Result<Option<(SessionRow, UserRow)>> {
    let session = query_as::<_, SessionRow>("SELECT * FROM sessions WHERE id = ?")
        .bind(id_hash)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;
    let Some(session) = session else {
        return Ok(None);
    };
    if session.expires_at <= now {
        let _ = delete_session(pool, id_hash).await;
        return Ok(None);
    }
    let Some(user) = find_user_by_id_any(pool, session.user_id).await? else {
        return Ok(None);
    };
    if user.disabled_at.is_some() {
        return Ok(None);
    }
    Ok(Some((session, user)))
}

pub async fn touch_session(pool: &SqlitePool, id_hash: &str, now: i64) -> Result<()> {
    query("UPDATE sessions SET last_seen_at = ? WHERE id = ?")
        .bind(now)
        .bind(id_hash)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

pub async fn delete_session(pool: &SqlitePool, id_hash: &str) -> Result<bool> {
    let affected = query("DELETE FROM sessions WHERE id = ?")
        .bind(id_hash)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected == 1)
}

/// 清理过期会话（启动时与后台任务调用）。
pub async fn purge_expired_sessions(pool: &SqlitePool, now: i64) -> Result<u64> {
    let affected = query("DELETE FROM sessions WHERE expires_at <= ?")
        .bind(now)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected)
}

// ---------------------------------------------------------------- feed（按查看者过滤）

/// 帖子流：**审核中的只有作者本人与管理员及以上可见**，被拒的只有管理员可见。
///
/// `viewer_id` 为 `None` 表示游客；`is_staff` 表示管理员及以上。
pub async fn list_feed(
    pool: &SqlitePool,
    viewer_id: Option<i64>,
    is_staff: bool,
    limit: i64,
    offset: i64,
) -> Result<Vec<PostWithAuthorRow>> {
    let viewer = viewer_id.unwrap_or(-1);
    let staff = i64::from(is_staff);
    query_as::<_, PostWithAuthorRow>(
        "SELECT p.id, p.title, p.body, p.kind, p.section, p.review_state, p.review_note, p.image_count, \
                p.created_at, p.author_id, u.handle AS author_handle, \
                u.display_name AS author_display_name, u.avatar_hash AS author_avatar, \
                u.role AS author_role, \
                (SELECT COALESCE(pi.display_hash, pi.original_hash) \
                 FROM post_images pi \
                 WHERE pi.post_id = p.id AND pi.state <> 'failed' \
                 ORDER BY pi.position, pi.id LIMIT 1) AS cover_hash, \
                (SELECT COUNT(*) FROM comments c \
                 WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count, \
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count, \
                (SELECT COUNT(*) FROM post_bookmarks pb WHERE pb.post_id = p.id) AS bookmark_count \
         FROM posts p JOIN users u ON u.id = p.author_id \
         WHERE p.deleted_at IS NULL \
           AND (p.review_state = 'approved' \
                OR ?2 = 1 \
                OR (p.review_state = 'pending' AND p.author_id = ?1)) \
         ORDER BY p.created_at DESC, p.id DESC LIMIT ?3 OFFSET ?4",
    )
    .bind(viewer)
    .bind(staff)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

/// 帖子流（可按分区过滤）。`section` 为 `None` 时返回全部分区。
pub async fn list_feed_by_section(
    pool: &SqlitePool,
    viewer_id: Option<i64>,
    is_staff: bool,
    section: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<PostWithAuthorRow>> {
    let viewer = viewer_id.unwrap_or(-1);
    let staff = i64::from(is_staff);
    let section = section.unwrap_or("");
    query_as::<_, PostWithAuthorRow>(
        "SELECT p.id, p.title, p.body, p.kind, p.section, p.review_state, p.review_note, \
                p.image_count, p.created_at, p.author_id, u.handle AS author_handle, \
                u.display_name AS author_display_name, u.avatar_hash AS author_avatar, \
                u.role AS author_role, \
                (SELECT COALESCE(pi.display_hash, pi.original_hash) \
                 FROM post_images pi \
                 WHERE pi.post_id = p.id AND pi.state <> 'failed' \
                 ORDER BY pi.position, pi.id LIMIT 1) AS cover_hash, \
                (SELECT COUNT(*) FROM comments c \
                 WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count, \
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count, \
                (SELECT COUNT(*) FROM post_bookmarks pb WHERE pb.post_id = p.id) AS bookmark_count \
         FROM posts p JOIN users u ON u.id = p.author_id \
         WHERE p.deleted_at IS NULL \
           AND (?5 = '' OR p.section = ?5) \
           AND (p.review_state = 'approved' \
                OR ?2 = 1 \
                OR (p.review_state = 'pending' AND p.author_id = ?1)) \
         ORDER BY p.created_at DESC, p.id DESC LIMIT ?3 OFFSET ?4",
    )
    .bind(viewer)
    .bind(staff)
    .bind(limit)
    .bind(offset)
    .bind(section)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

/// 某个作者的帖子（个人主页用）。
///
/// 非本人/非管理员只看得到已通过的帖子——和首页同一套可见性规则。
pub async fn list_posts_by_author(
    pool: &SqlitePool,
    author_id: i64,
    include_pending: bool,
    limit: i64,
) -> Result<Vec<PostWithAuthorRow>> {
    query_as::<_, PostWithAuthorRow>(
        "SELECT p.id, p.title, p.body, p.kind, p.section, p.review_state, p.review_note, \
                p.image_count, p.created_at, p.author_id, u.handle AS author_handle, \
                u.display_name AS author_display_name, u.avatar_hash AS author_avatar, \
                u.role AS author_role, \
                (SELECT COALESCE(pi.display_hash, pi.original_hash) \
                 FROM post_images pi \
                 WHERE pi.post_id = p.id AND pi.state <> 'failed' \
                 ORDER BY pi.position, pi.id LIMIT 1) AS cover_hash, \
                (SELECT COUNT(*) FROM comments c \
                 WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count, \
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count, \
                (SELECT COUNT(*) FROM post_bookmarks pb WHERE pb.post_id = p.id) AS bookmark_count \
         FROM posts p JOIN users u ON u.id = p.author_id \
         WHERE p.deleted_at IS NULL AND p.author_id = ?1 \
           AND (p.review_state = 'approved' OR ?2 = 1) \
         ORDER BY p.created_at DESC, p.id DESC LIMIT ?3",
    )
    .bind(author_id)
    .bind(i64::from(include_pending))
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

/// 取单帖，并按查看者判定可见性（只有被拒/审核中的帖子会因身份不同而不同）。
pub async fn get_post_for(
    pool: &SqlitePool,
    id: i64,
    viewer_id: Option<i64>,
    is_staff: bool,
) -> Result<Option<PostRow>> {
    let Some(row) = get_post(pool, id).await? else {
        return Ok(None);
    };
    let state = sc2clud_core::review::ReviewState::parse(&row.review_state)?;
    let is_author = viewer_id == Some(row.author_id);
    if state.visible_to(is_author, is_staff) {
        Ok(Some(row))
    } else {
        Ok(None)
    }
}

// ---------------------------------------------------------------- 回复（不带图）

pub async fn create_comment(
    pool: &SqlitePool,
    post_id: i64,
    author_id: i64,
    body: &str,
    now: i64,
) -> Result<i64> {
    // 回复表没有图片列：这是数据层对「回复不能带图」的硬保证。
    let res =
        query("INSERT INTO comments (post_id, author_id, body, created_at) VALUES (?, ?, ?, ?)")
            .bind(post_id)
            .bind(author_id)
            .bind(body)
            .bind(now)
            .execute(pool)
            .await
            .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

/// 回复列表：**过滤掉查看者拉黑的人**（拉黑的另一半意义就在这里）。
pub async fn list_comments_for(
    pool: &SqlitePool,
    post_id: i64,
    viewer_id: Option<i64>,
    limit: i64,
) -> Result<Vec<CommentWithAuthorRow>> {
    query_as::<_, CommentWithAuthorRow>(
        "SELECT c.id, c.post_id, c.author_id, u.handle AS author_handle, \
                u.display_name AS author_display_name, u.avatar_hash AS author_avatar, \
                c.body, c.created_at \
         FROM comments c JOIN users u ON u.id = c.author_id \
         WHERE c.post_id = ?1 AND c.deleted_at IS NULL \
           AND NOT EXISTS (SELECT 1 FROM blocks b \
                           WHERE b.blocker_id = COALESCE(?2, -1) AND b.blocked_id = c.author_id) \
         ORDER BY c.created_at, c.id LIMIT ?3",
    )
    .bind(post_id)
    .bind(viewer_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

pub async fn list_comments(
    pool: &SqlitePool,
    post_id: i64,
    limit: i64,
) -> Result<Vec<CommentWithAuthorRow>> {
    query_as::<_, CommentWithAuthorRow>(
        "SELECT c.id, c.post_id, c.author_id, u.handle AS author_handle, \
                u.display_name AS author_display_name, u.avatar_hash AS author_avatar, \
                c.body, c.created_at \
         FROM comments c JOIN users u ON u.id = c.author_id \
         WHERE c.post_id = ? AND c.deleted_at IS NULL ORDER BY c.created_at, c.id LIMIT ?",
    )
    .bind(post_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

// ---------------------------------------------------------------- 启动器发布

/// 建一个（未发布的）release。
pub async fn create_release(
    pool: &SqlitePool,
    version: &str,
    channel: &str,
    title: Option<&str>,
    notes: Option<&str>,
    by: Option<i64>,
    now: i64,
) -> Result<i64> {
    let res = query(
        "INSERT INTO releases (version, channel, title, notes, created_by, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(version)
    .bind(channel)
    .bind(title)
    .bind(notes)
    .bind(by)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

pub async fn set_release_published(
    pool: &SqlitePool,
    release_id: i64,
    published: bool,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "UPDATE releases SET is_published = ?, published_at = ? WHERE id = ? AND is_published <> ?",
    )
    .bind(i64::from(published))
    .bind(published.then_some(now))
    .bind(release_id)
    .bind(i64::from(published))
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

/// 最新已发布版本（`channel` 为 `None` 时不限通道）。
pub async fn latest_release(
    pool: &SqlitePool,
    channel: Option<&str>,
) -> Result<Option<ReleaseRow>> {
    match channel {
        Some(channel) => query_as::<_, ReleaseRow>(
            "SELECT * FROM releases WHERE is_published = 1 AND channel = ? \
                 ORDER BY published_at DESC, id DESC LIMIT 1",
        )
        .bind(channel)
        .fetch_optional(pool)
        .await
        .map_err(db_err),
        None => query_as::<_, ReleaseRow>(
            "SELECT * FROM releases WHERE is_published = 1 \
                 ORDER BY published_at DESC, id DESC LIMIT 1",
        )
        .fetch_optional(pool)
        .await
        .map_err(db_err),
    }
}

pub async fn list_releases(pool: &SqlitePool, limit: i64) -> Result<Vec<ReleaseRow>> {
    query_as::<_, ReleaseRow>(
        "SELECT * FROM releases WHERE is_published = 1 \
         ORDER BY published_at DESC, id DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

/// 登记发布直链的入参（字段多且同型，用具名结构体）。
pub struct NewReleaseAsset<'a> {
    pub release_id: i64,
    pub platform: &'a str,
    pub arch: &'a str,
    pub filename: &'a str,
    pub url: &'a str,
    pub size: i64,
    pub sha256: Option<&'a str>,
    pub now: i64,
}

/// 登记一个分发直链。**只存地址，不下载、不落盘**。
pub async fn add_release_asset(pool: &SqlitePool, asset: NewReleaseAsset<'_>) -> Result<i64> {
    let res = query(
        "INSERT INTO release_assets (release_id, platform, arch, filename, url, size, sha256, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(asset.release_id)
    .bind(asset.platform)
    .bind(asset.arch)
    .bind(asset.filename)
    .bind(asset.url)
    .bind(asset.size)
    .bind(asset.sha256)
    .bind(asset.now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

pub async fn list_release_assets(
    pool: &SqlitePool,
    release_id: i64,
) -> Result<Vec<ReleaseAssetRow>> {
    query_as::<_, ReleaseAssetRow>(
        "SELECT * FROM release_assets WHERE release_id = ? ORDER BY platform, id",
    )
    .bind(release_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

pub async fn get_release_asset(
    pool: &SqlitePool,
    asset_id: i64,
) -> Result<Option<ReleaseAssetRow>> {
    query_as::<_, ReleaseAssetRow>("SELECT * FROM release_assets WHERE id = ?")
        .bind(asset_id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)
}

pub async fn bump_release_asset_downloads(pool: &SqlitePool, asset_id: i64) -> Result<()> {
    query("UPDATE release_assets SET download_count = download_count + 1 WHERE id = ?")
        .bind(asset_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

// ---------------------------------------------------------------- 账号、激活与角色

/// 注册入参：**登录名与显示名分开**。
///
/// 登录名是账号标识（唯一、ASCII、用于登录）；显示名是对外展示（可改、可重名、≤ 20 字符）。
pub struct NewUser<'a> {
    pub handle: &'a str,
    pub display_name: &'a str,
    pub email: &'a str,
    pub password_hash: &'a str,
    pub activated: bool,
    pub now: i64,
}

/// 注册：创建账号。`activated` 由调用方按站点设置决定（默认要求管理员激活）。
pub async fn register_user(pool: &SqlitePool, user: NewUser<'_>) -> Result<i64> {
    let activated_at: Option<i64> = user.activated.then_some(user.now);
    let res = query(
        "INSERT INTO users (handle, display_name, email, password_hash, role, quota_bytes, used_bytes, created_at, activated_at, activated_by) \
         VALUES (?, ?, ?, ?, 'member', 0, 0, ?, ?, NULL)",
    )
    .bind(user.handle)
    .bind(user.display_name)
    .bind(user.email)
    .bind(user.password_hash)
    .bind(user.now)
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

/// 重置口令（命令行运维工具用）。
pub async fn set_user_password(pool: &SqlitePool, user_id: i64, password_hash: &str) -> Result<()> {
    query("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(password_hash)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

/// 改显示名（不影响登录名）。为空或超长由领域层校验，这里只做写入。
/// 设置头像（内容摘要）。传 NULL 即清除。
pub async fn set_user_avatar(
    pool: &SqlitePool,
    user_id: i64,
    avatar_hash: Option<&str>,
    avatar_mime: Option<&str>,
) -> Result<bool> {
    let affected = query(
        "UPDATE users SET avatar_hash = ?, avatar_mime = ? \
         WHERE id = ? AND COALESCE(avatar_hash, '') <> COALESCE(?, '')",
    )
    .bind(avatar_hash)
    .bind(avatar_mime)
    .bind(user_id)
    .bind(avatar_hash)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

/// 某个作者的头像摘要是否被某个用户使用（`/avatar/{hash}` 只服务登记过的内容）。
pub async fn avatar_is_used(pool: &SqlitePool, hash: &str) -> Result<bool> {
    let row: Option<(i64,)> = query_as("SELECT 1 FROM users WHERE avatar_hash = ? LIMIT 1")
        .bind(hash)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;
    Ok(row.is_some())
}

/// 头像的 MIME（给 `/avatar/{hash}` 定 Content-Type）。
pub async fn avatar_mime(pool: &SqlitePool, hash: &str) -> Result<Option<String>> {
    let row: Option<(Option<String>,)> =
        query_as("SELECT avatar_mime FROM users WHERE avatar_hash = ? LIMIT 1")
            .bind(hash)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    Ok(row.and_then(|r| r.0))
}

pub async fn set_display_name(pool: &SqlitePool, user_id: i64, display_name: &str) -> Result<bool> {
    let affected = query("UPDATE users SET display_name = ? WHERE id = ? AND display_name <> ?")
        .bind(display_name)
        .bind(user_id)
        .bind(display_name)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
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

/// 管理页用户列表：支持按登录名 / 显示名 / 邮箱模糊搜索，并带上最后在线时间。
pub async fn admin_list_users(
    pool: &SqlitePool,
    query: &str,
    limit: i64,
) -> Result<Vec<AdminUserRow>> {
    let needle = format!("%{}%", query.trim());
    query_as::<_, AdminUserRow>(
        "SELECT u.id, u.handle, u.display_name, u.email, u.role, u.created_at, \
                u.activated_at, u.avatar_hash, u.quota_bytes, u.used_bytes, \
                (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at \
         FROM users u \
         WHERE ?1 = '' OR u.handle LIKE ?2 OR u.display_name LIKE ?2 \
               OR COALESCE(u.email, '') LIKE ?2 \
         ORDER BY u.created_at DESC, u.id DESC LIMIT ?3",
    )
    .bind(query.trim())
    .bind(needle)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

/// 设置某个账号的磁盘预算（字节）。管理员可改；0 = 不分配。
pub async fn set_user_quota(pool: &SqlitePool, user_id: i64, quota_bytes: i64) -> Result<bool> {
    let affected = query("UPDATE users SET quota_bytes = ? WHERE id = ? AND quota_bytes <> ?")
        .bind(quota_bytes)
        .bind(user_id)
        .bind(quota_bytes)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected == 1)
}

/// 磁盘预算总览：`(已分配, 已占用)`。
pub async fn quota_totals(pool: &SqlitePool) -> Result<(i64, i64)> {
    let row: (i64, i64) =
        query_as("SELECT COALESCE(SUM(quota_bytes), 0), COALESCE(SUM(used_bytes), 0) FROM users")
            .fetch_one(pool)
            .await
            .map_err(db_err)?;
    Ok(row)
}

// ------------------------------------------------------------ 私信与拉黑

/// 发一条私信。
///
/// 业务规则（双方任一拉黑即禁止）由调用方先判断；这里只负责落库。
pub async fn send_message(
    pool: &SqlitePool,
    sender_id: i64,
    recipient_id: i64,
    body: &str,
    now: i64,
) -> Result<i64> {
    let res = query(
        "INSERT INTO messages (sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(sender_id)
    .bind(recipient_id)
    .bind(body)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

/// 双方之间是否存在拉黑（任一方向）。
pub async fn blocked_between(pool: &SqlitePool, a: i64, b: i64) -> Result<bool> {
    let row: Option<(i64,)> = query_as(
        "SELECT 1 FROM blocks WHERE (blocker_id = ?1 AND blocked_id = ?2) \
         OR (blocker_id = ?2 AND blocked_id = ?1) LIMIT 1",
    )
    .bind(a)
    .bind(b)
    .fetch_optional(pool)
    .await
    .map_err(db_err)?;
    Ok(row.is_some())
}

/// 把某人加入自己的黑名单（幂等）。
pub async fn block_user(
    pool: &SqlitePool,
    blocker_id: i64,
    blocked_id: i64,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?) \
         ON CONFLICT(blocker_id, blocked_id) DO NOTHING",
    )
    .bind(blocker_id)
    .bind(blocked_id)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

pub async fn unblock_user(pool: &SqlitePool, blocker_id: i64, blocked_id: i64) -> Result<bool> {
    let affected = query("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?")
        .bind(blocker_id)
        .bind(blocked_id)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected == 1)
}

/// 我拉黑了谁。
pub async fn list_blocks(pool: &SqlitePool, blocker_id: i64) -> Result<Vec<BlockRow>> {
    query_as::<_, BlockRow>(
        "SELECT u.handle, u.display_name, u.avatar_hash, b.created_at \
         FROM blocks b JOIN users u ON u.id = b.blocked_id \
         WHERE b.blocker_id = ? ORDER BY b.created_at DESC",
    )
    .bind(blocker_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

/// 会话列表：每个聊过的人一行，带最后一条与未读数。
pub async fn list_conversations(pool: &SqlitePool, user_id: i64) -> Result<Vec<ConversationRow>> {
    query_as::<_, ConversationRow>(
        "SELECT u.id AS other_id, u.handle AS other_handle, u.display_name AS other_display_name, \
                u.avatar_hash AS other_avatar, \
                m.body AS last_body, m.created_at AS last_at, \
                CASE WHEN m.sender_id = ?1 THEN 1 ELSE 0 END AS last_from_me, \
                (SELECT COUNT(*) FROM messages x \
                 WHERE x.sender_id = u.id AND x.recipient_id = ?1 \
                   AND x.read_at IS NULL AND x.recipient_deleted = 0) AS unread \
         FROM messages m JOIN users u \
           ON u.id = CASE WHEN m.sender_id = ?1 THEN m.recipient_id ELSE m.sender_id END \
         WHERE (m.sender_id = ?1 AND m.sender_deleted = 0) \
            OR (m.recipient_id = ?1 AND m.recipient_deleted = 0) \
         GROUP BY u.id \
         HAVING m.created_at = MAX(m.created_at) \
         ORDER BY m.created_at DESC LIMIT 100",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

/// 与某个人的往来消息（按时间正序）。
pub async fn list_thread(
    pool: &SqlitePool,
    me: i64,
    other: i64,
    limit: i64,
) -> Result<Vec<MessageRow>> {
    query_as::<_, MessageRow>(
        "SELECT id, sender_id, recipient_id, body, created_at, read_at FROM messages \
         WHERE ((sender_id = ?1 AND recipient_id = ?2 AND sender_deleted = 0) \
             OR (sender_id = ?2 AND recipient_id = ?1 AND recipient_deleted = 0)) \
         ORDER BY created_at DESC, id DESC LIMIT ?3",
    )
    .bind(me)
    .bind(other)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

/// 打开会话即标记已读。
pub async fn mark_thread_read(pool: &SqlitePool, me: i64, other: i64, now: i64) -> Result<u64> {
    let affected = query(
        "UPDATE messages SET read_at = ? \
         WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL",
    )
    .bind(now)
    .bind(me)
    .bind(other)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected)
}

/// 未读私信总数（顶栏红点用）。
pub async fn unread_message_count(pool: &SqlitePool, user_id: i64) -> Result<i64> {
    let row: (i64,) = query_as(
        "SELECT COUNT(*) FROM messages \
         WHERE recipient_id = ? AND read_at IS NULL AND recipient_deleted = 0",
    )
    .bind(user_id)
    .fetch_one(pool)
    .await
    .map_err(db_err)?;
    Ok(row.0)
}

/// 待审核的帖子（管理面板用）。
pub async fn list_pending_posts(pool: &SqlitePool, limit: i64) -> Result<Vec<PostWithAuthorRow>> {
    query_as::<_, PostWithAuthorRow>(
        "SELECT p.id, p.title, p.body, p.kind, p.section, p.review_state, p.review_note, \
                p.image_count, p.created_at, p.author_id, u.handle AS author_handle, \
                u.display_name AS author_display_name, u.avatar_hash AS author_avatar, \
                u.role AS author_role, \
                (SELECT COALESCE(pi.display_hash, pi.original_hash) FROM post_images pi \
                 WHERE pi.post_id = p.id AND pi.state <> 'failed' \
                 ORDER BY pi.position, pi.id LIMIT 1) AS cover_hash, \
                (SELECT COUNT(*) FROM comments c \
                 WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count, \
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count, \
                (SELECT COUNT(*) FROM post_bookmarks pb WHERE pb.post_id = p.id) AS bookmark_count \
         FROM posts p JOIN users u ON u.id = p.author_id \
         WHERE p.deleted_at IS NULL AND p.review_state = 'pending' \
         ORDER BY p.created_at ASC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

// ------------------------------------------------------------ 点赞 / 收藏 / 通知 / 公告

/// 点赞开关：返回点赞后的状态（true = 已赞）。
pub async fn toggle_like(pool: &SqlitePool, post_id: i64, user_id: i64, now: i64) -> Result<bool> {
    let removed = query("DELETE FROM post_likes WHERE post_id = ? AND user_id = ?")
        .bind(post_id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    if removed > 0 {
        return Ok(false);
    }
    query("INSERT INTO post_likes (post_id, user_id, created_at) VALUES (?, ?, ?)")
        .bind(post_id)
        .bind(user_id)
        .bind(now)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(true)
}

/// 收藏开关：返回收藏后的状态（true = 已收藏）。
pub async fn toggle_bookmark(
    pool: &SqlitePool,
    post_id: i64,
    user_id: i64,
    now: i64,
) -> Result<bool> {
    let removed = query("DELETE FROM post_bookmarks WHERE post_id = ? AND user_id = ?")
        .bind(post_id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    if removed > 0 {
        return Ok(false);
    }
    query("INSERT INTO post_bookmarks (post_id, user_id, created_at) VALUES (?, ?, ?)")
        .bind(post_id)
        .bind(user_id)
        .bind(now)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(true)
}

/// 我是否赞过 / 收藏过某帖：`(liked, bookmarked)`。
pub async fn my_post_flags(pool: &SqlitePool, post_id: i64, user_id: i64) -> Result<(bool, bool)> {
    let liked: Option<(i64,)> =
        query_as("SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?")
            .bind(post_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    let marked: Option<(i64,)> =
        query_as("SELECT 1 FROM post_bookmarks WHERE post_id = ? AND user_id = ?")
            .bind(post_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    Ok((liked.is_some(), marked.is_some()))
}

pub async fn post_like_count(pool: &SqlitePool, post_id: i64) -> Result<i64> {
    let row: (i64,) = query_as("SELECT COUNT(*) FROM post_likes WHERE post_id = ?")
        .bind(post_id)
        .fetch_one(pool)
        .await
        .map_err(db_err)?;
    Ok(row.0)
}

/// 我的收藏（按收藏时间倒序）。
pub async fn list_bookmarks(
    pool: &SqlitePool,
    user_id: i64,
    limit: i64,
) -> Result<Vec<BookmarkRow>> {
    query_as::<_, BookmarkRow>(
        "SELECT p.id AS post_id, p.title, p.section, p.created_at, b.created_at AS saved_at \
         FROM post_bookmarks b JOIN posts p ON p.id = b.post_id \
         WHERE b.user_id = ? AND p.deleted_at IS NULL \
         ORDER BY b.created_at DESC LIMIT ?",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

// ---------------- 通知 ----------------

pub async fn notify(
    pool: &SqlitePool,
    user_id: i64,
    kind: &str,
    title: &str,
    body: Option<&str>,
    link: Option<&str>,
    now: i64,
) -> Result<i64> {
    let res = query(
        "INSERT INTO notifications (user_id, kind, title, body, link, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(kind)
    .bind(title)
    .bind(body)
    .bind(link)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

/// 公告/全员通知：一次插一批（避开逐条往返）。
pub async fn notify_all(
    pool: &SqlitePool,
    kind: &str,
    title: &str,
    body: Option<&str>,
    link: Option<&str>,
    now: i64,
) -> Result<u64> {
    let affected = query(
        "INSERT INTO notifications (user_id, kind, title, body, link, created_at) \
         SELECT id, ?, ?, ?, ?, ? FROM users",
    )
    .bind(kind)
    .bind(title)
    .bind(body)
    .bind(link)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected)
}

pub async fn list_notifications(
    pool: &SqlitePool,
    user_id: i64,
    limit: i64,
) -> Result<Vec<NotificationRow>> {
    query_as::<_, NotificationRow>(
        "SELECT id, kind, title, body, link, read_at, created_at FROM notifications \
         WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .bind(user_id)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

pub async fn unread_notification_count(pool: &SqlitePool, user_id: i64) -> Result<i64> {
    let row: (i64,) =
        query_as("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND read_at IS NULL")
            .bind(user_id)
            .fetch_one(pool)
            .await
            .map_err(db_err)?;
    Ok(row.0)
}

pub async fn mark_notifications_read(pool: &SqlitePool, user_id: i64, now: i64) -> Result<u64> {
    let affected =
        query("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL")
            .bind(now)
            .bind(user_id)
            .execute(pool)
            .await
            .map_err(db_err)?
            .rows_affected();
    Ok(affected)
}

// ---------------- 系统公告 ----------------

pub async fn create_announcement(
    pool: &SqlitePool,
    title: &str,
    body: &str,
    by: i64,
    now: i64,
) -> Result<i64> {
    let res = query(
        "INSERT INTO announcements (title, body, created_by, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(title)
    .bind(body)
    .bind(by)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

pub async fn list_announcements(pool: &SqlitePool, limit: i64) -> Result<Vec<AnnouncementRow>> {
    query_as::<_, AnnouncementRow>(
        "SELECT id, title, body, created_at FROM announcements \
         ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

pub async fn latest_announcement(pool: &SqlitePool) -> Result<Option<AnnouncementRow>> {
    query_as::<_, AnnouncementRow>(
        "SELECT id, title, body, created_at FROM announcements \
         ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .map_err(db_err)
}

/// 备份用：把数据库一致地写到目标文件（SQLite 的 VACUUM INTO，不用停服）。
pub async fn backup_to(pool: &SqlitePool, path: &str) -> Result<()> {
    let statement = format!("VACUUM INTO '{}'", path.replace('\'', "''"));
    query(&statement).execute(pool).await.map_err(db_err)?;
    Ok(())
}

pub async fn count_comments(pool: &SqlitePool) -> Result<i64> {
    let row: (i64,) = query_as("SELECT COUNT(*) FROM comments WHERE deleted_at IS NULL")
        .fetch_one(pool)
        .await
        .map_err(db_err)?;
    Ok(row.0)
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

/// 某个用户相关的审计记录（`actor_id` 是他，或对象是他）。
pub async fn list_user_audit(pool: &SqlitePool, user_id: i64, limit: i64) -> Result<Vec<AuditRow>> {
    let target = format!("user:{user_id}");
    query_as::<_, AuditRow>(
        "SELECT * FROM audit_log WHERE actor_id = ?1 OR target = ?2 \
         ORDER BY created_at DESC, id DESC LIMIT ?3",
    )
    .bind(user_id)
    .bind(target)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_err)
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
