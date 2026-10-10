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
    AdminUserRow, AnnouncementRow, AuditRow, BannerRow, BlobRow, BlockRow, BookmarkRow,
    CommentWithAuthorRow, ConversationRow, DefaultAvatarRow, ExpEventRow, FileRow,
    FileWithOwnerRow, GroupSectionRuleRow, ImageJobRow, IssueCommentRow, MessageRow,
    NotificationRow, PaymentChannelRow, PostImageRow, PostIssueRow, PostRevisionRow, PostRow,
    PostSearchRow, PostSourceRow, PostWithAuthorRow, ReleaseAssetRow, ReleaseRow,
    SectionModeratorRow, SectionRow, SessionRow, SiteDomainRow, TitleRow, UploadSessionRow,
    UserGroupRow, UserHitRow, UserRow, UserTitleRow,
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
/// 该账号的密码默认是不可用的占位哈希，必须由运维执行
/// `sc2clud set-password <用户名> <密码>` 之后才能登录——所以不存在「默认密码」风险。
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
                    "引导账号已提升为超级管理员并激活（密码仍需 set-password 设置）"
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
            tracing::info!(user.id = id, %handle, "已创建引导超级管理员（密码待设置）");
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
    // 密码哈希留空：该账号不允许密码登录（没有登录路径），只能由会话绑定。
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

/// 删除一张配图。
///
/// 做四件事（在一个事务里）：删行 → 扣 blob 引用 → 让帖子的 image_count 与事实一致 →
/// 把剩下的位置重排成 0..n-1（不留空洞）。
///
/// 返回**引用归零、可以物理删除**的 blob 摘要列表（由调用方去删文件）；
/// 图片不存在时返回 `None`。
pub async fn delete_post_image(
    pool: &SqlitePool,
    post_id: i64,
    image_id: i64,
) -> Result<Option<Vec<String>>> {
    let mut tx = pool.begin().await.map_err(db_err)?;
    let row: Option<(String, Option<String>, Option<String>)> = query_as(
        "SELECT original_hash, display_hash, thumb_hash FROM post_images \
         WHERE id = ? AND post_id = ?",
    )
    .bind(image_id)
    .bind(post_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_err)?;
    let Some((original, display, thumb)) = row else {
        return Ok(None);
    };

    query("DELETE FROM post_images WHERE id = ?")
        .bind(image_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;

    // 同一个 blob 可能同时被 original/display/thumb 引用（去重后再扣）
    let mut hashes: Vec<String> = vec![original];
    for extra in [display, thumb].into_iter().flatten() {
        if !hashes.contains(&extra) {
            hashes.push(extra);
        }
    }
    let mut reclaim = Vec::new();
    for hash in &hashes {
        query("UPDATE blobs SET refcount = refcount - 1 WHERE hash = ?")
            .bind(hash)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    // 归零的 blob 顺手把元数据行也删掉，文件由调用方回收
    for hash in &hashes {
        let left: Option<(i64,)> = query_as("SELECT refcount FROM blobs WHERE hash = ?")
            .bind(hash)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_err)?;
        if left.map(|(n,)| n).unwrap_or(0) <= 0 {
            query("DELETE FROM blobs WHERE hash = ?")
                .bind(hash)
                .execute(&mut *tx)
                .await
                .map_err(db_err)?;
            reclaim.push(hash.clone());
        }
    }
    // 位置重排：删掉中间一张后不留空洞
    let ids: Vec<(i64,)> =
        query_as("SELECT id FROM post_images WHERE post_id = ? ORDER BY position, id")
            .bind(post_id)
            .fetch_all(&mut *tx)
            .await
            .map_err(db_err)?;
    for (index, (id,)) in ids.iter().enumerate() {
        query("UPDATE post_images SET position = ? WHERE id = ?")
            .bind(index as i64)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    query(
        "UPDATE posts SET image_count = (SELECT COUNT(*) FROM post_images WHERE post_id = posts.id) \
         WHERE id = ?",
    )
    .bind(post_id)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;

    tx.commit().await.map_err(db_err)?;
    Ok(Some(reclaim))
}

/// 把一张配图往前/往后挪一格（`forward = true` 表示往前）。
///
/// 直接按当前顺序整体重写位置，不依赖「相邻两张一定相差 1」的假设。
pub async fn move_post_image(
    pool: &SqlitePool,
    post_id: i64,
    image_id: i64,
    forward: bool,
) -> Result<bool> {
    let ids: Vec<(i64,)> =
        query_as("SELECT id FROM post_images WHERE post_id = ? ORDER BY position, id")
            .bind(post_id)
            .fetch_all(pool)
            .await
            .map_err(db_err)?;
    let mut order: Vec<i64> = ids.into_iter().map(|(id,)| id).collect();
    let Some(index) = order.iter().position(|id| *id == image_id) else {
        return Ok(false);
    };
    let target = if forward {
        index.checked_sub(1)
    } else {
        (index + 1 < order.len()).then_some(index + 1)
    };
    let Some(target) = target else {
        return Ok(false);
    };
    order.swap(index, target);

    let mut tx = pool.begin().await.map_err(db_err)?;
    for (position, id) in order.iter().enumerate() {
        query("UPDATE post_images SET position = ? WHERE id = ?")
            .bind(position as i64)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    Ok(true)
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

/// 踢掉某个用户的所有会话（改密码、停用、封禁时用）。
pub async fn delete_user_sessions(pool: &SqlitePool, user_id: i64) -> Result<u64> {
    let affected = query("DELETE FROM sessions WHERE user_id = ?")
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected)
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
                p.archived_at AS archived_at, \
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count, \
                (SELECT COUNT(*) FROM post_bookmarks pb WHERE pb.post_id = p.id) AS bookmark_count \
         FROM posts p JOIN users u ON u.id = p.author_id \
         WHERE p.deleted_at IS NULL \
           AND (p.review_state = 'approved' \
                OR ?2 = 1 \
                OR (p.review_state = 'pending' AND p.author_id = ?1)) \
         ORDER BY p.pinned_rank DESC, p.created_at DESC, p.id DESC LIMIT ?3 OFFSET ?4",
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
    list_feed_filtered(
        pool,
        viewer_id,
        is_staff,
        &FeedFilter {
            section,
            search: "",
            popular: false,
        },
        limit,
        offset,
    )
    .await
}

/// 首页筛选。关键词按字面匹配，百分号与下划线不作为通配符。
pub struct FeedFilter<'a> {
    pub section: Option<&'a str>,
    pub search: &'a str,
    pub popular: bool,
}

pub async fn list_feed_filtered(
    pool: &SqlitePool,
    viewer_id: Option<i64>,
    is_staff: bool,
    filter: &FeedFilter<'_>,
    limit: i64,
    offset: i64,
) -> Result<Vec<PostWithAuthorRow>> {
    let viewer = viewer_id.unwrap_or(-1);
    let staff = i64::from(is_staff);
    let section = filter.section.unwrap_or("");
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
                p.archived_at AS archived_at, \
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count, \
                (SELECT COUNT(*) FROM post_bookmarks pb WHERE pb.post_id = p.id) AS bookmark_count \
         FROM posts p JOIN users u ON u.id = p.author_id \
         WHERE p.deleted_at IS NULL AND p.archived_at IS NULL \
           -- 归档分区的内容不再出现在列表里（内容本身保留，取回分区即恢复）
           AND NOT EXISTS (SELECT 1 FROM sections sec WHERE sec.key = p.section AND sec.archived_at IS NOT NULL) \
           AND (?5 = '' OR p.section = ?5) \
           AND (?6 = '' OR instr(lower(p.title || ' ' || p.body), lower(?6)) > 0) \
           AND (p.review_state = 'approved' \
                OR ?2 = 1 \
                OR (p.review_state = 'pending' AND p.author_id = ?1)) \
         ORDER BY p.pinned_rank DESC, CASE WHEN ?7 = 1 THEN \
                    (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) \
                    + (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) \
                  ELSE 0 END DESC, p.created_at DESC, p.id DESC LIMIT ?3 OFFSET ?4",
    )
    .bind(viewer)
    .bind(staff)
    .bind(limit)
    .bind(offset)
    .bind(section)
    .bind(filter.search)
    .bind(i64::from(filter.popular))
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

/// 分页总数必须使用与帖子列表完全相同的权限和筛选条件。
pub async fn count_feed_filtered(
    pool: &SqlitePool,
    viewer_id: Option<i64>,
    is_staff: bool,
    filter: &FeedFilter<'_>,
) -> Result<i64> {
    let row: (i64,) = query_as(
        "SELECT COUNT(*) FROM posts p JOIN users u ON u.id = p.author_id \
         WHERE p.deleted_at IS NULL AND p.archived_at IS NULL \
           AND (?3 = '' OR p.section = ?3) \
           AND (?4 = '' OR instr(lower(p.title || ' ' || p.body), lower(?4)) > 0) \
           AND (p.review_state = 'approved' OR ?2 = 1 \
                OR (p.review_state = 'pending' AND p.author_id = ?1))",
    )
    .bind(viewer_id.unwrap_or(-1))
    .bind(i64::from(is_staff))
    .bind(filter.section.unwrap_or(""))
    .bind(filter.search)
    .fetch_one(pool)
    .await
    .map_err(db_err)?;
    Ok(row.0)
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
                p.archived_at AS archived_at, \
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count, \
                (SELECT COUNT(*) FROM post_bookmarks pb WHERE pb.post_id = p.id) AS bookmark_count \
         FROM posts p JOIN users u ON u.id = p.author_id \
         WHERE p.deleted_at IS NULL AND p.archived_at IS NULL \
           AND NOT EXISTS (SELECT 1 FROM sections sec WHERE sec.key = p.section AND sec.archived_at IS NOT NULL) \
           AND p.author_id = ?1 \
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
    parent_id: Option<i64>,
    now: i64,
) -> Result<i64> {
    // 回复表没有图片列：这是数据层对「回复不能带图」的硬保证。
    let res = query(
        "INSERT INTO comments (post_id, author_id, body, parent_id, created_at) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(post_id)
    .bind(author_id)
    .bind(body)
    .bind(parent_id)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

// ---------------------------------------------------------------- 回复投票（赞 / 踩）

/// 投票：value = 1 赞、-1 踩、0 取消。返回 (赞数, 踩数, 我的票)。
pub async fn vote_comment(
    pool: &SqlitePool,
    comment_id: i64,
    user_id: i64,
    value: i64,
    now: i64,
) -> Result<(i64, i64, i64)> {
    if value == 0 {
        query("DELETE FROM comment_votes WHERE comment_id = ? AND user_id = ?")
            .bind(comment_id)
            .bind(user_id)
            .execute(pool)
            .await
            .map_err(db_err)?;
    } else {
        query(
            "INSERT INTO comment_votes (comment_id, user_id, value, created_at) VALUES (?, ?, ?, ?) \
             ON CONFLICT(comment_id, user_id) DO UPDATE SET value = excluded.value, created_at = excluded.created_at",
        )
        .bind(comment_id)
        .bind(user_id)
        .bind(value)
        .bind(now)
        .execute(pool)
        .await
        .map_err(db_err)?;
    }
    let row: (i64, i64) = query_as(
        "SELECT COALESCE(SUM(value = 1), 0), COALESCE(SUM(value = -1), 0) FROM comment_votes WHERE comment_id = ?",
    )
    .bind(comment_id)
    .fetch_one(pool)
    .await
    .map_err(db_err)?;
    let mine: Option<(i64,)> =
        query_as("SELECT value FROM comment_votes WHERE comment_id = ? AND user_id = ?")
            .bind(comment_id)
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    Ok((row.0, row.1, mine.map(|(v,)| v).unwrap_or(0)))
}

/// 这条回复属于哪个帖子（投票前校验，别让人投别人看不到的帖子）。
pub async fn comment_post_id(pool: &SqlitePool, comment_id: i64) -> Result<Option<i64>> {
    let row: Option<(i64,)> =
        query_as("SELECT post_id FROM comments WHERE id = ? AND deleted_at IS NULL")
            .bind(comment_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    Ok(row.map(|(id,)| id))
}

/// 某个楼层的作者 id（回复通知用）。
pub async fn comment_author(pool: &SqlitePool, comment_id: i64) -> Result<Option<i64>> {
    let row: Option<(i64,)> =
        query_as("SELECT author_id FROM comments WHERE id = ? AND deleted_at IS NULL")
            .bind(comment_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    Ok(row.map(|(id,)| id))
}
/// 楼中楼只允许一层：父楼层如果本身是回复，就挂到它的根楼层下（B 站规则）。
pub async fn comment_root_of(
    pool: &SqlitePool,
    post_id: i64,
    parent_id: i64,
) -> Result<Option<i64>> {
    let row: Option<(i64, Option<i64>)> = query_as(
        "SELECT id, parent_id FROM comments WHERE id = ? AND post_id = ? AND deleted_at IS NULL",
    )
    .bind(parent_id)
    .bind(post_id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)?;
    Ok(row.map(|(id, parent)| parent.unwrap_or(id)))
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
                u.avatar_small AS author_avatar_small, \
                (SELECT t.name FROM titles t WHERE t.id = u.equipped_title_id) AS author_title, \
                (SELECT t.color FROM titles t WHERE t.id = u.equipped_title_id) AS author_title_color, \
                c.body, c.created_at, c.parent_id, \
                (SELECT COUNT(*) FROM comment_votes v WHERE v.comment_id = c.id AND v.value = 1) AS likes, \
                (SELECT COUNT(*) FROM comment_votes v WHERE v.comment_id = c.id AND v.value = -1) AS dislikes, \
                COALESCE((SELECT v.value FROM comment_votes v \
                          WHERE v.comment_id = c.id AND v.user_id = COALESCE(?2, -1)), 0) AS my_vote \
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
                u.avatar_small AS author_avatar_small, \
                (SELECT t.name FROM titles t WHERE t.id = u.equipped_title_id) AS author_title, \
                (SELECT t.color FROM titles t WHERE t.id = u.equipped_title_id) AS author_title_color, \
                c.body, c.created_at, c.parent_id, \
                (SELECT COUNT(*) FROM comment_votes v WHERE v.comment_id = c.id AND v.value = 1) AS likes, \
                (SELECT COUNT(*) FROM comment_votes v WHERE v.comment_id = c.id AND v.value = -1) AS dislikes, \
                COALESCE((SELECT v.value FROM comment_votes v \
                          WHERE v.comment_id = c.id AND v.user_id = -1), 0) AS my_vote \
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

/// 重置密码（命令行运维工具用）。
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

/// 列表页用的小图头像（48px）；没上传过返回 None，渲染时回落原图。
pub async fn avatar_small_of(pool: &SqlitePool, user_id: i64) -> Result<Option<String>> {
    let row: Option<(Option<String>,)> = query_as("SELECT avatar_small FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;
    Ok(row.and_then(|(hash,)| hash))
}

/// 记下小图头像（换头像后由页面自动生成并上传）。
pub async fn set_avatar_small(pool: &SqlitePool, user_id: i64, hash: Option<&str>) -> Result<()> {
    query("UPDATE users SET avatar_small = ? WHERE id = ?")
        .bind(hash)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(())
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

/// 按 id 取单个用户（编辑页用），字段与列表页一致。
pub async fn admin_get_user(pool: &SqlitePool, id: i64) -> Result<Option<AdminUserRow>> {
    query_as::<_, AdminUserRow>(
        "SELECT u.id, u.handle, u.display_name, u.email, u.role, u.created_at, \
                u.activated_at, u.avatar_hash, u.quota_bytes, u.used_bytes, u.trusted, \
                (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS last_seen_at \
         FROM users u WHERE u.id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
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
                u.activated_at, u.avatar_hash, u.quota_bytes, u.used_bytes, u.trusted, \
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
                p.archived_at AS archived_at, \
                (SELECT COUNT(*) FROM post_likes pl WHERE pl.post_id = p.id) AS like_count, \
                (SELECT COUNT(*) FROM post_bookmarks pb WHERE pb.post_id = p.id) AS bookmark_count \
         FROM posts p JOIN users u ON u.id = p.author_id \
         WHERE p.deleted_at IS NULL AND p.archived_at IS NULL AND p.review_state = 'pending' \
         ORDER BY p.created_at ASC LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

/// 编辑帖子的入参（作者或管理员编辑后调用）。
#[derive(Debug, Clone, Copy)]
pub struct PostEdit<'a> {
    pub id: i64,
    pub title: &'a str,
    pub body: &'a str,
    pub kind: &'a str,
    pub section: &'a str,
    pub review_state: &'a str,
    pub review_note: Option<&'a str>,
    /// 编辑者（待审修改要记提交人）。
    pub submitted_by: Option<i64>,
    pub now: i64,
}

/// 更新帖子内容，并把新的审核结果写回。
pub async fn update_post(pool: &SqlitePool, edit: PostEdit<'_>) -> Result<bool> {
    let affected = query(
        "UPDATE posts SET title = ?, body = ?, kind = ?, section = ?, \
                           review_state = ?, review_note = ?, auto_reviewed = 1, updated_at = ? \
         WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(edit.title)
    .bind(edit.body)
    .bind(edit.kind)
    .bind(edit.section)
    .bind(edit.review_state)
    .bind(edit.review_note)
    .bind(edit.now)
    .bind(edit.id)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

/// 归档 / 取消归档：归档只是不再展示，不删数据。
pub async fn set_post_archived(
    pool: &SqlitePool,
    id: i64,
    archived: bool,
    now: i64,
) -> Result<bool> {
    let affected =
        query("UPDATE posts SET archived_at = ? WHERE id = ? AND COALESCE(archived_at, 0) <> ?")
            .bind(if archived { Some(now) } else { None })
            .bind(id)
            .bind(if archived { now } else { 0 })
            .execute(pool)
            .await
            .map_err(db_err)?
            .rows_affected();
    Ok(affected == 1)
}

/// 管理端「编辑用户」弹窗的入参（一次性把资料改完）。
pub struct AdminUserUpdate<'a> {
    pub id: i64,
    pub display_name: &'a str,
    pub role: &'a str,
    pub quota_bytes: i64,
    pub trusted: bool,
    pub activated: bool,
    /// `None` = 不改密码。
    pub password_hash: Option<&'a str>,
}

/// 一次 UPDATE 改完弹窗里的所有字段（省得前端为每个字段各提交一次）。
///
/// 激活时写入激活时间，停用时清空；密码用 `COALESCE` 保持原值。
pub async fn admin_update_user(pool: &SqlitePool, update: AdminUserUpdate<'_>) -> Result<bool> {
    let trusted: i64 = i64::from(update.trusted);
    let activated: i64 = i64::from(update.activated);
    let now = sc2clud_core::now_unix();
    let affected = query(
        "UPDATE users SET display_name = ?, role = ?, quota_bytes = ?, trusted = ?, \
                activated_at = CASE WHEN ? = 1 THEN COALESCE(activated_at, ?) ELSE NULL END, \
                password_hash = COALESCE(?, password_hash) \
         WHERE id = ?",
    )
    .bind(update.display_name)
    .bind(update.role)
    .bind(update.quota_bytes)
    .bind(trusted)
    .bind(activated)
    .bind(now)
    .bind(update.password_hash)
    .bind(update.id)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

/// 设置「信任」标记：被信任的账号发帖只走自动审核。
pub async fn set_user_trusted(pool: &SqlitePool, user_id: i64, trusted: bool) -> Result<bool> {
    let value: i64 = i64::from(trusted);
    let affected = query("UPDATE users SET trusted = ? WHERE id = ? AND trusted <> ?")
        .bind(value)
        .bind(user_id)
        .bind(value)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected == 1)
}

/// 设置分区封面（内容寻址的图片摘要）。
pub async fn set_section_cover(
    pool: &SqlitePool,
    section: &str,
    hash: &str,
    mime: &str,
    by: i64,
    now: i64,
) -> Result<()> {
    query(
        "INSERT INTO section_covers (section, cover_hash, mime, updated_by, updated_at) \
         VALUES (?, ?, ?, ?, ?) \
         ON CONFLICT(section) DO UPDATE SET cover_hash = excluded.cover_hash, \
             mime = excluded.mime, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    )
    .bind(section)
    .bind(hash)
    .bind(mime)
    .bind(by)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(())
}

/// 全部分区封面：`(section, hash, mime)`。
pub async fn list_section_covers(pool: &SqlitePool) -> Result<Vec<(String, String, String)>> {
    let rows: Vec<(String, String, String)> =
        query_as("SELECT section, cover_hash, mime FROM section_covers")
            .fetch_all(pool)
            .await
            .map_err(db_err)?;
    Ok(rows)
}

/// 清空某帖的下载来源（编辑时整体重写）。
pub async fn delete_post_sources(pool: &SqlitePool, post_id: i64) -> Result<u64> {
    let affected = query("DELETE FROM post_sources WHERE post_id = ?")
        .bind(post_id)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected)
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

pub struct NewNotification<'a> {
    pub user_id: i64,
    /// 谁触发的（点赞者 / 审核人 / 发私信的人）；系统通知传 None。
    pub actor_id: Option<i64>,
    pub kind: &'a str,
    pub title: &'a str,
    pub body: Option<&'a str>,
    pub link: Option<&'a str>,
    pub now: i64,
}

pub async fn notify(pool: &SqlitePool, notice: NewNotification<'_>) -> Result<i64> {
    let res = query(
        "INSERT INTO notifications (user_id, actor_id, kind, title, body, link, created_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(notice.user_id)
    .bind(notice.actor_id)
    .bind(notice.kind)
    .bind(notice.title)
    .bind(notice.body)
    .bind(notice.link)
    .bind(notice.now)
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
        "SELECT n.id, n.kind, n.title, n.body, n.link, n.read_at, n.created_at, \
                a.handle AS actor_handle, a.display_name AS actor_display_name, \
                COALESCE(a.avatar_hash, a.default_avatar_hash) AS actor_avatar \
         FROM notifications n LEFT JOIN users a ON a.id = n.actor_id \
         WHERE n.user_id = ? AND n.deleted_at IS NULL \
           AND NOT EXISTS (SELECT 1 FROM notification_mutes m \
                           WHERE m.user_id = n.user_id AND m.kind = n.kind \
                             AND (m.link = '' OR m.link = COALESCE(n.link, ''))) \
         ORDER BY n.created_at DESC, n.id DESC LIMIT ?",
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

// ============================================================
// 社区结构：分区 / 分区管理员 / 用户组 / 头衔 / 等级经验 / 帖子置顶精华
// 说明：全部只做**加法**，与既有查询解耦（搜索结果用独立的瘦行结构）。
// ============================================================

fn section_from_row(row: SectionRow) -> sc2clud_core::community::SectionRecord {
    use sc2clud_core::auth::Role;
    sc2clud_core::community::SectionRecord {
        key: row.key,
        label: row.label,
        description: row.description,
        position: row.position,
        archived: row.archived_at.is_some(),
        post_min_role: Role::parse(&row.post_min_role).unwrap_or(Role::Member),
        reply_min_role: Role::parse(&row.reply_min_role).unwrap_or(Role::Member),
    }
}

/// 列分区；`include_archived = false` 时只给在用的（前台用）。
pub async fn list_sections(
    pool: &SqlitePool,
    include_archived: bool,
) -> Result<Vec<sc2clud_core::community::SectionRecord>> {
    let sql = if include_archived {
        "SELECT * FROM sections ORDER BY position, key"
    } else {
        "SELECT * FROM sections WHERE archived_at IS NULL ORDER BY position, key"
    };
    let rows: Vec<SectionRow> = query_as(sql).fetch_all(pool).await.map_err(db_err)?;
    Ok(rows.into_iter().map(section_from_row).collect())
}

/// 取单个分区（含归档的：归档后仍要能打开里面的内容）。
pub async fn get_section(
    pool: &SqlitePool,
    key: &str,
) -> Result<Option<sc2clud_core::community::SectionRecord>> {
    let row: Option<SectionRow> = query_as("SELECT * FROM sections WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;
    Ok(row.map(section_from_row))
}

/// 新建分区的入参（参数太多，收成结构体）。
pub struct NewSection<'a> {
    pub key: &'a str,
    pub label: &'a str,
    pub description: &'a str,
    pub position: i64,
    pub post_min_role: &'a str,
    pub reply_min_role: &'a str,
    pub now: i64,
}

/// 新建分区；key 已存在返回 `false`。
pub async fn create_section(pool: &SqlitePool, section: NewSection<'_>) -> Result<bool> {
    let affected = query(
        "INSERT OR IGNORE INTO sections (key, label, description, position, post_min_role, reply_min_role, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(section.key)
    .bind(section.label)
    .bind(section.description)
    .bind(section.position)
    .bind(section.post_min_role)
    .bind(section.reply_min_role)
    .bind(section.now)
    .bind(section.now)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

/// 改分区资料与权限门槛。
pub async fn update_section(
    pool: &SqlitePool,
    key: &str,
    label: &str,
    description: &str,
    post_min_role: &str,
    reply_min_role: &str,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "UPDATE sections SET label = ?, description = ?, post_min_role = ?, reply_min_role = ?, updated_at = ? \
         WHERE key = ?",
    )
    .bind(label)
    .bind(description)
    .bind(post_min_role)
    .bind(reply_min_role)
    .bind(now)
    .bind(key)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

/// 归档 / 取回分区。**只标记，不删内容**——取回后帖子原样回来。
pub async fn set_section_archived(
    pool: &SqlitePool,
    key: &str,
    archived: bool,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "UPDATE sections SET archived_at = ?, updated_at = ? \
         WHERE key = ? AND ((archived_at IS NULL) = ?)",
    )
    .bind(if archived { Some(now) } else { None })
    .bind(now)
    .bind(key)
    // 归档要求「当前没归档」，恢复要求「当前已归档」；绑定值与 archived 同向
    .bind(archived)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

/// 按给定的 key 顺序重排分区。
///
/// 只排**列出的**那几个，剩下的按原有顺序接在后面——
/// 否则「部分排序」会让没列出的分区与列出的撞在同一个 position 上（测试抓到过）。
pub async fn reorder_sections(pool: &SqlitePool, keys: &[String], now: i64) -> Result<u64> {
    let mut tx = pool.begin().await.map_err(db_err)?;
    let existing: Vec<(String,)> = query_as("SELECT key FROM sections ORDER BY position, key")
        .fetch_all(&mut *tx)
        .await
        .map_err(db_err)?;
    let mut ordered: Vec<String> = keys
        .iter()
        .filter(|key| existing.iter().any(|(k,)| k == *key))
        .cloned()
        .collect();
    for (key,) in existing {
        if !ordered.contains(&key) {
            ordered.push(key);
        }
    }
    let mut moved = 0u64;
    for (position, key) in ordered.iter().enumerate() {
        moved += query("UPDATE sections SET position = ?, updated_at = ? WHERE key = ?")
            .bind(position as i64)
            .bind(now)
            .bind(key)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?
            .rows_affected();
    }
    tx.commit().await.map_err(db_err)?;
    Ok(moved)
}

/// 追加分区时用：当前最大 position + 1。
pub async fn next_section_position(pool: &SqlitePool) -> Result<i64> {
    let row: Option<(i64,)> = query_as("SELECT COALESCE(MAX(position), -1) + 1 FROM sections")
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;
    Ok(row.map(|r| r.0).unwrap_or(0))
}

/// 分区管理员列表。
pub async fn list_section_moderators(
    pool: &SqlitePool,
    section: &str,
) -> Result<Vec<SectionModeratorRow>> {
    let rows = query_as::<_, SectionModeratorRow>(
        "SELECT m.user_id, u.handle, u.display_name, m.created_at \
         FROM section_moderators m JOIN users u ON u.id = m.user_id \
         WHERE m.section = ? ORDER BY m.created_at",
    )
    .bind(section)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows)
}

/// 指定分区管理员（当前不附带额外权限，位置先留出来）。
pub async fn add_section_moderator(
    pool: &SqlitePool,
    section: &str,
    user_id: i64,
    by: Option<i64>,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "INSERT OR IGNORE INTO section_moderators (section, user_id, created_at, created_by) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(section)
    .bind(user_id)
    .bind(now)
    .bind(by)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

pub async fn remove_section_moderator(
    pool: &SqlitePool,
    section: &str,
    user_id: i64,
) -> Result<bool> {
    let affected = query("DELETE FROM section_moderators WHERE section = ? AND user_id = ?")
        .bind(section)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected == 1)
}

pub async fn is_section_moderator(pool: &SqlitePool, section: &str, user_id: i64) -> Result<bool> {
    let row: Option<(i64,)> =
        query_as("SELECT 1 FROM section_moderators WHERE section = ? AND user_id = ?")
            .bind(section)
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    Ok(row.is_some())
}
// ---------------------------------------------------------------- 用户组

pub async fn list_user_groups(
    pool: &SqlitePool,
    include_archived: bool,
) -> Result<Vec<UserGroupRow>> {
    let sql = if include_archived {
        "SELECT * FROM user_groups ORDER BY id"
    } else {
        "SELECT * FROM user_groups WHERE archived_at IS NULL ORDER BY id"
    };
    query_as::<_, UserGroupRow>(sql)
        .fetch_all(pool)
        .await
        .map_err(db_err)
}

/// 新建用户组，返回 id；key 已存在则返回已存在的 id。
pub async fn create_user_group(
    pool: &SqlitePool,
    key: &str,
    name: &str,
    description: &str,
    now: i64,
) -> Result<i64> {
    query("INSERT OR IGNORE INTO user_groups (key, name, description, created_at) VALUES (?, ?, ?, ?)")
        .bind(key)
        .bind(name)
        .bind(description)
        .bind(now)
        .execute(pool)
        .await
        .map_err(db_err)?;
    let row: (i64,) = query_as("SELECT id FROM user_groups WHERE key = ?")
        .bind(key)
        .fetch_one(pool)
        .await
        .map_err(db_err)?;
    Ok(row.0)
}

pub async fn set_user_group_archived(
    pool: &SqlitePool,
    id: i64,
    archived: bool,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "UPDATE user_groups SET archived_at = ? WHERE id = ? AND ((archived_at IS NULL) = ?)",
    )
    .bind(if archived { Some(now) } else { None })
    .bind(id)
    .bind(archived)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

pub async fn add_group_member(
    pool: &SqlitePool,
    group_id: i64,
    user_id: i64,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "INSERT OR IGNORE INTO user_group_members (group_id, user_id, created_at) VALUES (?, ?, ?)",
    )
    .bind(group_id)
    .bind(user_id)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

pub async fn remove_group_member(pool: &SqlitePool, group_id: i64, user_id: i64) -> Result<bool> {
    let affected = query("DELETE FROM user_group_members WHERE group_id = ? AND user_id = ?")
        .bind(group_id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected == 1)
}

/// 组成员：`(user_id, handle, display_name)`。
pub async fn list_group_members(
    pool: &SqlitePool,
    group_id: i64,
) -> Result<Vec<(i64, String, String)>> {
    let rows: Vec<(i64, String, String)> = query_as(
        "SELECT u.id, u.handle, u.display_name FROM user_group_members m \
         JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.created_at",
    )
    .bind(group_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows)
}

/// 某人所在的（未归档）组。
pub async fn list_user_groups_for(pool: &SqlitePool, user_id: i64) -> Result<Vec<UserGroupRow>> {
    let rows = query_as::<_, UserGroupRow>(
        "SELECT g.* FROM user_groups g JOIN user_group_members m ON m.group_id = g.id \
         WHERE m.user_id = ? AND g.archived_at IS NULL ORDER BY g.id",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows)
}

/// 设置「组 × 分区」的发言规则（有行 = 该组在该分区可以发/回）。
pub async fn set_group_section_rule(
    pool: &SqlitePool,
    group_id: i64,
    section: &str,
    can_post: bool,
    can_reply: bool,
) -> Result<()> {
    // 兼容旧调用：只给「允许」时禁止位清零
    set_group_section_rule_full(pool, group_id, section, can_post, can_reply, false, false).await
}

/// 完整版：允许 / 禁止 一起设（禁止优先）。
pub async fn set_group_section_rule_full(
    pool: &SqlitePool,
    group_id: i64,
    section: &str,
    can_post: bool,
    can_reply: bool,
    deny_post: bool,
    deny_reply: bool,
) -> Result<()> {
    query(
        "INSERT INTO group_section_rules (group_id, section, can_post, can_reply, deny_post, deny_reply) \
         VALUES (?, ?, ?, ?, ?, ?) \
         ON CONFLICT(group_id, section) DO UPDATE SET can_post = excluded.can_post, \
             can_reply = excluded.can_reply, deny_post = excluded.deny_post, \
             deny_reply = excluded.deny_reply",
    )
    .bind(group_id)
    .bind(section)
    .bind(i64::from(can_post))
    .bind(i64::from(can_reply))
    .bind(i64::from(deny_post))
    .bind(i64::from(deny_reply))
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(())
}

pub async fn remove_group_section_rule(
    pool: &SqlitePool,
    group_id: i64,
    section: &str,
) -> Result<bool> {
    let affected = query("DELETE FROM group_section_rules WHERE group_id = ? AND section = ?")
        .bind(group_id)
        .bind(section)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected == 1)
}

pub async fn list_group_section_rules(
    pool: &SqlitePool,
    group_id: i64,
) -> Result<Vec<GroupSectionRuleRow>> {
    query_as::<_, GroupSectionRuleRow>(
        "SELECT * FROM group_section_rules WHERE group_id = ? ORDER BY section",
    )
    .bind(group_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

/// 影响「某人在某分区」的组规则（只取未归档的组）。
///
/// 判定策略：**任一组给了允许就算允许**（组是加成，不是限制）。
pub async fn group_rules_for_user_section(
    pool: &SqlitePool,
    user_id: i64,
    section: &str,
) -> Result<Vec<GroupSectionRuleRow>> {
    query_as::<_, GroupSectionRuleRow>(
        "SELECT r.* FROM group_section_rules r \
         JOIN user_group_members m ON m.group_id = r.group_id \
         JOIN user_groups g ON g.id = r.group_id \
         WHERE m.user_id = ? AND r.section = ? AND g.archived_at IS NULL",
    )
    .bind(user_id)
    .bind(section)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

// ---------------------------------------------------------------- 头衔

pub async fn list_titles(pool: &SqlitePool, include_archived: bool) -> Result<Vec<TitleRow>> {
    let sql = if include_archived {
        "SELECT * FROM titles ORDER BY id"
    } else {
        "SELECT * FROM titles WHERE archived_at IS NULL ORDER BY id"
    };
    query_as::<_, TitleRow>(sql)
        .fetch_all(pool)
        .await
        .map_err(db_err)
}

pub async fn create_title(
    pool: &SqlitePool,
    key: &str,
    name: &str,
    color: &str,
    description: &str,
    now: i64,
) -> Result<i64> {
    query("INSERT OR IGNORE INTO titles (key, name, color, description, created_at) VALUES (?, ?, ?, ?, ?)")
        .bind(key)
        .bind(name)
        .bind(color)
        .bind(description)
        .bind(now)
        .execute(pool)
        .await
        .map_err(db_err)?;
    let row: (i64,) = query_as("SELECT id FROM titles WHERE key = ?")
        .bind(key)
        .fetch_one(pool)
        .await
        .map_err(db_err)?;
    Ok(row.0)
}

pub async fn set_title_archived(
    pool: &SqlitePool,
    id: i64,
    archived: bool,
    now: i64,
) -> Result<bool> {
    let affected =
        query("UPDATE titles SET archived_at = ? WHERE id = ? AND ((archived_at IS NULL) = ?)")
            .bind(if archived { Some(now) } else { None })
            .bind(id)
            .bind(archived)
            .execute(pool)
            .await
            .map_err(db_err)?
            .rows_affected();
    Ok(affected == 1)
}

/// 授予头衔（同一个头衔重复授予是幂等的）。
pub async fn grant_title(
    pool: &SqlitePool,
    user_id: i64,
    title_id: i64,
    by: Option<i64>,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "INSERT OR IGNORE INTO user_titles (user_id, title_id, granted_at, granted_by) \
         VALUES (?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(title_id)
    .bind(now)
    .bind(by)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

/// 收回头衔；如果正戴着它，顺带摘掉。
pub async fn revoke_title(pool: &SqlitePool, user_id: i64, title_id: i64) -> Result<bool> {
    let mut tx = pool.begin().await.map_err(db_err)?;
    query("DELETE FROM user_titles WHERE user_id = ? AND title_id = ?")
        .bind(user_id)
        .bind(title_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    query("UPDATE users SET equipped_title_id = NULL WHERE id = ? AND equipped_title_id = ?")
        .bind(user_id)
        .bind(title_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok(true)
}

/// 某人持有的全部头衔（带「是否正在佩戴」标记）。
pub async fn list_user_titles(pool: &SqlitePool, user_id: i64) -> Result<Vec<UserTitleRow>> {
    query_as::<_, UserTitleRow>(
        "SELECT t.id AS title_id, t.key, t.name, t.color, ut.granted_at, \
                CASE WHEN u.equipped_title_id = t.id THEN 1 ELSE 0 END AS equipped \
         FROM user_titles ut \
         JOIN titles t ON t.id = ut.title_id \
         JOIN users u ON u.id = ut.user_id \
         WHERE ut.user_id = ? ORDER BY ut.granted_at DESC, t.id",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

/// 佩戴某个头衔；传 `None` 表示都不戴。**必须持有该头衔**，否则返回 `false`。
pub async fn set_equipped_title(
    pool: &SqlitePool,
    user_id: i64,
    title_id: Option<i64>,
) -> Result<bool> {
    if let Some(id) = title_id {
        let owns: Option<(i64,)> =
            query_as("SELECT 1 FROM user_titles WHERE user_id = ? AND title_id = ?")
                .bind(user_id)
                .bind(id)
                .fetch_optional(pool)
                .await
                .map_err(db_err)?;
        if owns.is_none() {
            return Ok(false);
        }
    }
    query("UPDATE users SET equipped_title_id = ? WHERE id = ?")
        .bind(title_id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(true)
}

// ---------------------------------------------------------------- 等级 / 经验

/// 记一笔经验并重算等级，返回 `(exp, level)`。
///
/// 当前**只记账**：增长规则与前端之后再接（用户要求「先做数据库注册」）。
pub async fn add_exp(
    pool: &SqlitePool,
    user_id: i64,
    delta: i64,
    reason: &str,
    reference: Option<&str>,
    now: i64,
) -> Result<(i64, i64)> {
    let mut tx = pool.begin().await.map_err(db_err)?;
    query(
        "INSERT INTO exp_events (user_id, delta, reason, ref, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(delta)
    .bind(reason)
    .bind(reference)
    .bind(now)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    let row: (i64,) = query_as("SELECT exp FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?;
    let exp = (row.0 + delta).max(0);
    let level = sc2clud_core::community::level_for_exp(exp);
    query("UPDATE users SET exp = ?, level = ? WHERE id = ?")
        .bind(exp)
        .bind(level)
        .bind(user_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok((exp, level))
}

pub async fn list_exp_events(
    pool: &SqlitePool,
    user_id: i64,
    limit: i64,
) -> Result<Vec<ExpEventRow>> {
    query_as::<_, ExpEventRow>(
        "SELECT id, delta, reason, created_at FROM exp_events \
         WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
    )
    .bind(user_id)
    .bind(limit.clamp(1, 200))
    .fetch_all(pool)
    .await
    .map_err(db_err)
}
// ---------------------------------------------------------------- 帖子：置顶 / 精华 / 推送 / 搜索

/// 置顶：`rank` 越大越靠前，0 = 取消置顶。
pub async fn set_post_pinned(
    pool: &SqlitePool,
    post_id: i64,
    rank: i64,
    by: Option<i64>,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "UPDATE posts SET pinned_rank = ?, \
                pinned_at = CASE WHEN ? > 0 THEN ? ELSE NULL END, \
                pinned_by = CASE WHEN ? > 0 THEN ? ELSE NULL END \
         WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(rank.max(0))
    .bind(rank.max(0))
    .bind(now)
    .bind(rank.max(0))
    .bind(by)
    .bind(post_id)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

/// 精华：标记 / 取消。
pub async fn set_post_featured(
    pool: &SqlitePool,
    post_id: i64,
    featured: bool,
    by: Option<i64>,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "UPDATE posts SET featured_at = CASE WHEN ? = 1 THEN ? ELSE NULL END, \
                featured_by = CASE WHEN ? = 1 THEN ? ELSE NULL END \
         WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(i64::from(featured))
    .bind(now)
    .bind(i64::from(featured))
    .bind(by)
    .bind(post_id)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

/// 记一次「推送」（发系统通知的动作由 Web 层做，这里只落时间戳）。
pub async fn mark_post_pushed(pool: &SqlitePool, post_id: i64, now: i64) -> Result<bool> {
    let affected = query("UPDATE posts SET pushed_at = ? WHERE id = ?")
        .bind(now)
        .bind(post_id)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected == 1)
}

/// 把 LIKE 的通配符转义掉（用户输入里的 % 和 _ 不该当通配符）。
fn like_pattern(term: &str) -> String {
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// 帖子搜索：标题优先于正文（标题命中排前面），再按置顶、时间。
///
/// 用 LIKE 而不是 FTS5：迁移不能失败——线上 SQLite 是否编译了 FTS5 不确定，
/// 而帖子量级（几千条）下 LIKE + 索引已经够用。
pub async fn search_posts(
    pool: &SqlitePool,
    term: &str,
    section: Option<&str>,
    limit: i64,
    offset: i64,
) -> Result<Vec<PostSearchRow>> {
    let pattern = like_pattern(term);
    let section = section.unwrap_or_default();
    let rows = query_as::<_, PostSearchRow>(
        "SELECT p.id, p.title, p.section, p.created_at, p.pinned_rank, p.featured_at, \
                p.author_id, u.handle AS author_handle, \
                COALESCE(NULLIF(u.display_name, ''), u.handle) AS author_display_name, \
                (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count, \
                (SELECT COALESCE(i.display_hash, i.original_hash) FROM post_images i \
                   WHERE i.post_id = p.id ORDER BY i.position LIMIT 1) AS cover_hash \
         FROM posts p JOIN users u ON u.id = p.author_id \
         WHERE p.deleted_at IS NULL AND p.archived_at IS NULL AND p.review_state = 'approved' \
           AND NOT EXISTS (SELECT 1 FROM sections sec WHERE sec.key = p.section AND sec.archived_at IS NOT NULL) \
           AND (? = '' OR p.section = ?) \
           AND (p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\') \
         ORDER BY (p.title LIKE ? ESCAPE '\\') DESC, p.pinned_rank DESC, p.created_at DESC \
         LIMIT ? OFFSET ?",
    )
    .bind(section)
    .bind(section)
    .bind(&pattern)
    .bind(&pattern)
    .bind(&pattern)
    .bind(limit.clamp(1, 100))
    .bind(offset.max(0))
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows)
}

/// 精华帖列表（可按分区过滤）。
pub async fn list_featured_posts(
    pool: &SqlitePool,
    section: Option<&str>,
    limit: i64,
) -> Result<Vec<PostSearchRow>> {
    let section = section.unwrap_or_default();
    let rows = query_as::<_, PostSearchRow>(
        "SELECT p.id, p.title, p.section, p.created_at, p.pinned_rank, p.featured_at, \
                p.author_id, u.handle AS author_handle, \
                COALESCE(NULLIF(u.display_name, ''), u.handle) AS author_display_name, \
                (SELECT COUNT(*) FROM comments c WHERE c.post_id = p.id AND c.deleted_at IS NULL) AS comment_count, \
                (SELECT COALESCE(i.display_hash, i.original_hash) FROM post_images i \
                   WHERE i.post_id = p.id ORDER BY i.position LIMIT 1) AS cover_hash \
         FROM posts p JOIN users u ON u.id = p.author_id \
         WHERE p.deleted_at IS NULL AND p.archived_at IS NULL AND p.review_state = 'approved' \
           AND p.featured_at IS NOT NULL \
           AND NOT EXISTS (SELECT 1 FROM sections sec WHERE sec.key = p.section AND sec.archived_at IS NOT NULL) \
           AND (? = '' OR p.section = ?) \
         ORDER BY p.featured_at DESC LIMIT ?",
    )
    .bind(section)
    .bind(section)
    .bind(limit.clamp(1, 100))
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    Ok(rows)
}
// ---------------------------------------------------------------- 横幅 / 资源帖状态 / 收款码

/// 该用户**当前应该看到**的横幅：生效中 + 在时间窗内 + 他没点过确认。
///
/// 一条 SQL 解决，不做「先查全部再逐个过滤」——横幅数量少但请求频繁。
pub async fn visible_banners(pool: &SqlitePool, user_id: i64, now: i64) -> Result<Vec<BannerRow>> {
    query_as::<_, BannerRow>(
        "SELECT b.* FROM banners b \
         WHERE b.active = 1 \
           AND (b.starts_at IS NULL OR b.starts_at <= ?) \
           AND (b.ends_at IS NULL OR b.ends_at > ?) \
           AND NOT EXISTS (SELECT 1 FROM banner_dismissals d WHERE d.banner_id = b.id AND d.user_id = ?) \
           -- 定向：没有配组 = 所有人；配了就只给这些组的成员
           AND (NOT EXISTS (SELECT 1 FROM banner_groups g WHERE g.banner_id = b.id) \
                OR EXISTS (SELECT 1 FROM banner_groups g \
                           JOIN user_group_members m ON m.group_id = g.group_id \
                           WHERE g.banner_id = b.id AND m.user_id = ?)) \
         ORDER BY b.id DESC",
    )
    .bind(now)
    .bind(now)
    .bind(user_id)
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

/// 新建横幅的入参。
pub struct NewBanner<'a> {
    pub title: &'a str,
    pub body: &'a str,
    pub kind: &'a str,
    pub url: Option<&'a str>,
    pub starts_at: Option<i64>,
    pub ends_at: Option<i64>,
    pub created_by: Option<i64>,
    pub now: i64,
}

pub async fn create_banner(pool: &SqlitePool, banner: NewBanner<'_>) -> Result<i64> {
    let res = query(
        "INSERT INTO banners (title, body, kind, url, active, starts_at, ends_at, created_at, created_by) \
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)",
    )
    .bind(banner.title)
    .bind(banner.body)
    .bind(banner.kind)
    .bind(banner.url)
    .bind(banner.starts_at)
    .bind(banner.ends_at)
    .bind(banner.now)
    .bind(banner.created_by)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

pub async fn set_banner_active(pool: &SqlitePool, id: i64, active: bool) -> Result<bool> {
    let affected = query("UPDATE banners SET active = ? WHERE id = ? AND active <> ?")
        .bind(i64::from(active))
        .bind(id)
        .bind(i64::from(active))
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected == 1)
}

/// 用户点「确认」：记一条，之后不再给他看（幂等）。
pub async fn dismiss_banner(
    pool: &SqlitePool,
    banner_id: i64,
    user_id: i64,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "INSERT OR IGNORE INTO banner_dismissals (banner_id, user_id, dismissed_at) VALUES (?, ?, ?)",
    )
    .bind(banner_id)
    .bind(user_id)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

/// 发帖时解析链接、或做占用检查用：只认「已通过、未删除、未归档」的帖子。
pub async fn resolved_post_title(pool: &SqlitePool, id: i64) -> Result<Option<String>> {
    let row: Option<(String,)> = query_as(
        "SELECT title FROM posts \
         WHERE id = ? AND deleted_at IS NULL AND archived_at IS NULL AND review_state = 'approved'",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)?;
    Ok(row.map(|r| r.0))
}

/// 设置资源帖状态；非资源帖也能存（展示由前台决定）。
pub async fn set_post_resource_status(
    pool: &SqlitePool,
    post_id: i64,
    status: &str,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "UPDATE posts SET resource_status = ?, resource_status_at = ? \
         WHERE id = ? AND deleted_at IS NULL",
    )
    .bind(status)
    .bind(now)
    .bind(post_id)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

pub async fn post_resource_status(pool: &SqlitePool, post_id: i64) -> Result<Option<String>> {
    let row: Option<(String,)> =
        query_as("SELECT resource_status FROM posts WHERE id = ? AND deleted_at IS NULL")
            .bind(post_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    Ok(row.map(|r| r.0))
}

/// 加一个收款渠道（渠道名自由填，不限定支付宝/微信）。
pub async fn add_payment_channel(
    pool: &SqlitePool,
    user_id: i64,
    channel: &str,
    label: &str,
    image_hash: &str,
    mime: &str,
    now: i64,
) -> Result<i64> {
    let res = query(
        "INSERT INTO payment_channels (user_id, channel, label, image_hash, mime, created_at) \
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(channel)
    .bind(label)
    .bind(image_hash)
    .bind(mime)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(res.last_insert_rowid())
}

pub async fn list_payment_channels(
    pool: &SqlitePool,
    user_id: i64,
) -> Result<Vec<PaymentChannelRow>> {
    query_as::<_, PaymentChannelRow>("SELECT * FROM payment_channels WHERE user_id = ? ORDER BY id")
        .bind(user_id)
        .fetch_all(pool)
        .await
        .map_err(db_err)
}

/// 删除收款码，返回图片摘要（调用方负责回收文件）；不是自己的则返回 None。
pub async fn delete_payment_channel(
    pool: &SqlitePool,
    user_id: i64,
    id: i64,
) -> Result<Option<String>> {
    let row: Option<(String,)> =
        query_as("SELECT image_hash FROM payment_channels WHERE id = ? AND user_id = ?")
            .bind(id)
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    let Some((hash,)) = row else {
        return Ok(None);
    };
    query("DELETE FROM payment_channels WHERE id = ? AND user_id = ?")
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    query("UPDATE blobs SET refcount = refcount - 1 WHERE hash = ?")
        .bind(&hash)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(Some(hash))
}

/// 读作者的赞助提示设置：`(显示开关, 自定义文本)`。
/// 没配过就返回默认（开 + 空）。
pub async fn donation_notice_settings(pool: &SqlitePool, user_id: i64) -> Result<(bool, String)> {
    let row: Option<(i64, String)> =
        query_as("SELECT donation_notice_visible, donation_notice_text FROM users WHERE id = ?")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    Ok(row
        .map(|(visible, text)| (visible != 0, text))
        .unwrap_or((true, String::new())))
}

/// 作者自己的赞助提示设置：显示开关 + 自定义文本（空 = 用渠道默认）。
pub async fn set_donation_notice(
    pool: &SqlitePool,
    user_id: i64,
    visible: bool,
    text: &str,
) -> Result<()> {
    query("UPDATE users SET donation_notice_visible = ?, donation_notice_text = ? WHERE id = ?")
        .bind(i64::from(visible))
        .bind(text)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

/// 超管配某个渠道的默认提示文本。
pub async fn set_donation_notice_default(
    pool: &SqlitePool,
    channel: &str,
    text: &str,
    by: Option<i64>,
    now: i64,
) -> Result<()> {
    query(
        "INSERT INTO donation_notice_defaults (channel, text, updated_at, updated_by) \
         VALUES (?, ?, ?, ?) \
         ON CONFLICT(channel) DO UPDATE SET text = excluded.text, \
             updated_at = excluded.updated_at, updated_by = excluded.updated_by",
    )
    .bind(channel)
    .bind(text)
    .bind(now)
    .bind(by)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(())
}

pub async fn list_donation_notice_defaults(pool: &SqlitePool) -> Result<Vec<(String, String)>> {
    query_as("SELECT channel, text FROM donation_notice_defaults ORDER BY channel")
        .fetch_all(pool)
        .await
        .map_err(db_err)
}

/// 打赏弹窗要显示的那段提示：作者自己写了用他的；没写就按**他第一个渠道**取超管默认；都没有则 None。
/// 开关关掉直接 None（前端就不用管逻辑了）。
pub async fn donation_notice_for(
    pool: &SqlitePool,
    user_id: i64,
    channels: &[PaymentChannelRow],
) -> Result<Option<String>> {
    let row: Option<(i64, String)> =
        query_as("SELECT donation_notice_visible, donation_notice_text FROM users WHERE id = ?")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    let Some((visible, own_text)) = row else {
        return Ok(None);
    };
    if visible == 0 {
        return Ok(None);
    }
    if !own_text.trim().is_empty() {
        return Ok(Some(own_text));
    }
    for channel in channels {
        let found: Option<(String,)> =
            query_as("SELECT text FROM donation_notice_defaults WHERE channel = ?")
                .bind(&channel.channel)
                .fetch_optional(pool)
                .await
                .map_err(db_err)?;
        if let Some((text,)) = found
            && !text.trim().is_empty()
        {
            return Ok(Some(text));
        }
    }
    Ok(None)
}
/// 清掉头像（回到默认头像），返回原来的 hash —— 调用方负责回收文件。
pub async fn clear_avatar(pool: &SqlitePool, user_id: i64) -> Result<Option<String>> {
    let row: Option<(Option<String>,)> = query_as("SELECT avatar_hash FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;
    let previous = row.and_then(|r| r.0);
    query(
        "UPDATE users SET avatar_hash = NULL, avatar_mime = NULL, avatar_small = NULL WHERE id = ?",
    )
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(previous)
}

// ---------------------------------------------------------------- 站点文本（超管可改的默认文案）

/// 读一条站点文本；没有就用 `fallback`。
pub async fn site_text(pool: &SqlitePool, key: &str, fallback: &str) -> Result<String> {
    let row: Option<(String,)> = query_as("SELECT value FROM site_texts WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;
    Ok(row.map(|r| r.0).unwrap_or_else(|| fallback.to_string()))
}

pub async fn set_site_text(
    pool: &SqlitePool,
    key: &str,
    value: &str,
    by: Option<i64>,
    now: i64,
) -> Result<()> {
    query(
        "INSERT INTO site_texts (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, \
             updated_at = excluded.updated_at, updated_by = excluded.updated_by",
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
// ---------------------------------------------------------------- 默认头像池 / 通知删除

pub async fn list_default_avatars(pool: &SqlitePool) -> Result<Vec<DefaultAvatarRow>> {
    query_as::<_, DefaultAvatarRow>("SELECT * FROM site_default_avatars ORDER BY id")
        .fetch_all(pool)
        .await
        .map_err(db_err)
}

/// 把一个 blob 加进默认头像池；重复加返回 false。
pub async fn add_default_avatar(
    pool: &SqlitePool,
    hash: &str,
    mime: &str,
    note: &str,
    by: Option<i64>,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "INSERT OR IGNORE INTO site_default_avatars (hash, mime, note, created_at, created_by) \
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(hash)
    .bind(mime)
    .bind(note)
    .bind(now)
    .bind(by)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

/// 移出池子，返回被移掉的那张的 hash（调用方负责回收文件）。
pub async fn remove_default_avatar(pool: &SqlitePool, id: i64) -> Result<Option<String>> {
    let row: Option<(String,)> = query_as("SELECT hash FROM site_default_avatars WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;
    let Some((hash,)) = row else { return Ok(None) };
    query("DELETE FROM site_default_avatars WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(Some(hash))
}

/// 给还没有头像的用户随机分一个默认头像（分过就固定不变）。
/// 池子为空时返回 None —— 调用方用内置兜底资源。
pub async fn ensure_default_avatar(pool: &SqlitePool, user_id: i64) -> Result<Option<String>> {
    let current: Option<(Option<String>, Option<String>)> =
        query_as("SELECT default_avatar_hash, avatar_hash FROM users WHERE id = ?")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    let Some((assigned, own)) = current else {
        return Ok(None);
    };
    if let Some(hash) = assigned {
        return Ok(Some(hash));
    }
    // 已经有自己的头像就不用分（默认头像是给「没头像」的人兜底）
    if own.is_some() {
        return Ok(None);
    }
    let picked: Option<(String,)> =
        query_as("SELECT hash FROM site_default_avatars ORDER BY RANDOM() LIMIT 1")
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    let Some((hash,)) = picked else {
        return Ok(None);
    };
    query("UPDATE users SET default_avatar_hash = ? WHERE id = ?")
        .bind(&hash)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(Some(hash))
}

/// 删除一条通知（只对自己隐藏）。
pub async fn delete_notification(
    pool: &SqlitePool,
    user_id: i64,
    id: i64,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "UPDATE notifications SET deleted_at = ? WHERE id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(now)
    .bind(id)
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

/// 「不再通知」：对某条内容（link）或某类别静音；`link` 传空表示整个类别。
pub async fn mute_notification(
    pool: &SqlitePool,
    user_id: i64,
    kind: &str,
    link: &str,
    now: i64,
) -> Result<()> {
    query(
        "INSERT OR IGNORE INTO notification_mutes (user_id, kind, link, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(user_id)
    .bind(kind)
    .bind(link)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(())
}
// ---------------------------------------------------------------- 用户搜索

/// 按登录名 / 显示名搜用户（只搜已激活；按发帖数排序）。
pub async fn search_users(pool: &SqlitePool, term: &str, limit: i64) -> Result<Vec<UserHitRow>> {
    let pattern = like_pattern(term);
    query_as::<_, UserHitRow>(
        "SELECT u.id, u.handle, u.display_name, u.avatar_hash, u.role, u.bio, \
                (SELECT COUNT(*) FROM posts p WHERE p.author_id = u.id \
                   AND p.deleted_at IS NULL AND p.review_state = 'approved') AS post_count \
         FROM users u \
         WHERE u.activated_at IS NOT NULL \
           AND (u.handle LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\') \
         ORDER BY post_count DESC, u.id LIMIT ?",
    )
    .bind(&pattern)
    .bind(&pattern)
    .bind(limit.clamp(1, 50))
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

// ---------------------------------------------------------------- 个人简介

/// 写个人简介。作者自己改时 `state` 传审核结论（当前一律 `approved`），
/// 管理员直接改也走同一个函数，只是 `note` 里记下原因。
pub async fn set_bio(
    pool: &SqlitePool,
    user_id: i64,
    bio: &str,
    state: &str,
    note: Option<&str>,
    now: i64,
) -> Result<()> {
    query(
        "UPDATE users SET bio = ?, bio_review_state = ?, bio_review_note = ?, bio_updated_at = ? \
         WHERE id = ?",
    )
    .bind(bio)
    .bind(state)
    .bind(note)
    .bind(now)
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(())
}

/// 读个人简介：`(文本, 审核态, 审核意见)`。
pub async fn user_bio(pool: &SqlitePool, user_id: i64) -> Result<(String, String, Option<String>)> {
    let row: Option<(String, String, Option<String>)> =
        query_as("SELECT bio, bio_review_state, bio_review_note FROM users WHERE id = ?")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    Ok(row.unwrap_or((String::new(), "approved".to_string(), None)))
}
// ---------------------------------------------------------------- 打赏展示（作者侧开关 + 页面用的展示块）

/// 作者是否开启「支持作者」展示。
pub async fn donation_visible(pool: &SqlitePool, user_id: i64) -> Result<bool> {
    let row: Option<(i64,)> = query_as("SELECT donation_visible FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;
    Ok(row.map(|r| r.0).unwrap_or(0) != 0)
}

pub async fn set_donation_visible(pool: &SqlitePool, user_id: i64, visible: bool) -> Result<bool> {
    let value = i64::from(visible);
    let affected =
        query("UPDATE users SET donation_visible = ? WHERE id = ? AND donation_visible <> ?")
            .bind(value)
            .bind(user_id)
            .bind(value)
            .execute(pool)
            .await
            .map_err(db_err)?
            .rows_affected();
    Ok(affected == 1)
}

/// 页面用的「作者展示块」：头衔 + 等级经验 + 打赏开关与渠道。
/// 一次取齐，帖子页/主页直接渲染，不用为每张卡片各查四遍。
pub struct AuthorShowcase {
    pub title: Option<TitleRow>,
    pub level: i64,
    pub exp: i64,
    pub donation_visible: bool,
    pub channels: Vec<PaymentChannelRow>,
}

pub async fn author_showcase(pool: &SqlitePool, user_id: i64) -> Result<AuthorShowcase> {
    let row: Option<(i64, i64, i64)> =
        query_as("SELECT level, exp, donation_visible FROM users WHERE id = ?")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    let (level, exp, donation) = row.unwrap_or((1, 0, 0));
    let channels = if donation != 0 {
        list_payment_channels(pool, user_id).await?
    } else {
        Vec::new()
    };
    Ok(AuthorShowcase {
        title: equipped_title_for(pool, user_id).await?,
        level,
        exp,
        donation_visible: donation != 0,
        channels,
    })
}
// ---------------------------------------------------------------- 待审修改（编辑帖子先不动原帖）

/// 提交一次编辑的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditOutcome {
    /// 直接生效（管理员编辑，或审核机直接放行）。
    Applied,
    /// 先存为待审修改，原帖保持不变。
    Staged,
}

/// 提交编辑：`review_state` 是审核机给的结论。
///
/// - `approved` → 直接写回 posts（原行为）；
/// - 其余（`pending`）→ **只写 post_revisions**，posts 保持原样，
///   对外仍显示原帖，发布者侧看到「修改内容审核中」。
pub async fn submit_post_edit(
    pool: &SqlitePool,
    edit: PostEdit<'_>,
    review_state: &str,
) -> Result<EditOutcome> {
    if review_state == "approved" {
        let ok = update_post(pool, edit).await?;
        if !ok {
            return Ok(EditOutcome::Applied);
        }
        let _ = drop_pending_revision(pool, edit.id).await;
        return Ok(EditOutcome::Applied);
    }
    query(
        "INSERT INTO post_revisions (post_id, title, body, kind, section, submitted_by, submitted_at, note) \
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
         ON CONFLICT(post_id) DO UPDATE SET title = excluded.title, body = excluded.body, \
             kind = excluded.kind, section = excluded.section, \
             submitted_by = excluded.submitted_by, submitted_at = excluded.submitted_at, \
             note = excluded.note",
    )
    .bind(edit.id)
    .bind(edit.title)
    .bind(edit.body)
    .bind(edit.kind)
    .bind(edit.section)
    .bind(edit.submitted_by)
    .bind(edit.now)
    .bind(edit.review_note)
    .execute(pool)
    .await
    .map_err(db_err)?;
    Ok(EditOutcome::Staged)
}

/// 某帖是否有待审修改。
pub async fn has_pending_revision(pool: &SqlitePool, post_id: i64) -> Result<bool> {
    Ok(pending_revision(pool, post_id).await?.is_some())
}

pub async fn pending_revision(pool: &SqlitePool, post_id: i64) -> Result<Option<PostRevisionRow>> {
    query_as::<_, PostRevisionRow>("SELECT * FROM post_revisions WHERE post_id = ?")
        .bind(post_id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)
}

/// 审核通过：把待审内容写回 posts 并清掉待审记录。
pub async fn apply_pending_revision(pool: &SqlitePool, post_id: i64, now: i64) -> Result<bool> {
    let Some(revision) = pending_revision(pool, post_id).await? else {
        return Ok(false);
    };
    let mut tx = pool.begin().await.map_err(db_err)?;
    query(
        "UPDATE posts SET title = ?, body = ?, kind = ?, section = ?, updated_at = ? WHERE id = ?",
    )
    .bind(&revision.title)
    .bind(&revision.body)
    .bind(&revision.kind)
    .bind(&revision.section)
    .bind(now)
    .bind(post_id)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    query("DELETE FROM post_revisions WHERE post_id = ?")
        .bind(post_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok(true)
}

/// 拒绝 / 打回：丢掉待审修改（原帖内容不受影响）。
pub async fn drop_pending_revision(pool: &SqlitePool, post_id: i64) -> Result<bool> {
    let affected = query("DELETE FROM post_revisions WHERE post_id = ?")
        .bind(post_id)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected == 1)
}

/// 待审修改队列（管理端审核用）：帖子标题 + 修改标题 + 提交时间 + 提交人。
pub async fn list_pending_revisions(
    pool: &SqlitePool,
    limit: i64,
    offset: i64,
) -> Result<Vec<(i64, String, String, i64, String)>> {
    query_as(
        "SELECT r.post_id, p.title, r.title, r.submitted_at, \
                COALESCE(NULLIF(u.display_name, ''), u.handle) \
         FROM post_revisions r \
         JOIN posts p ON p.id = r.post_id \
         LEFT JOIN users u ON u.id = r.submitted_by \
         WHERE p.deleted_at IS NULL \
         ORDER BY r.submitted_at LIMIT ? OFFSET ?",
    )
    .bind(limit.clamp(1, 100))
    .bind(offset.max(0))
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

// ---------------------------------------------------------------- 站点域名 / issue / 横幅定向

/// 登记一个站点域名（规范化后）；已存在返回 `false`。
pub async fn add_site_domain(
    pool: &SqlitePool,
    domain: &str,
    note: &str,
    now: i64,
) -> Result<bool> {
    let affected =
        query("INSERT OR IGNORE INTO site_domains (domain, note, created_at) VALUES (?, ?, ?)")
            .bind(domain)
            .bind(note)
            .bind(now)
            .execute(pool)
            .await
            .map_err(db_err)?
            .rows_affected();
    Ok(affected == 1)
}

pub async fn list_site_domains(pool: &SqlitePool) -> Result<Vec<SiteDomainRow>> {
    query_as::<_, SiteDomainRow>("SELECT * FROM site_domains ORDER BY created_at, domain")
        .fetch_all(pool)
        .await
        .map_err(db_err)
}

pub async fn remove_site_domain(pool: &SqlitePool, domain: &str) -> Result<bool> {
    let affected = query("DELETE FROM site_domains WHERE domain = ?")
        .bind(domain)
        .execute(pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    Ok(affected == 1)
}

// ---------------- issue ----------------

pub struct NewIssue<'a> {
    pub post_id: i64,
    pub author_id: i64,
    pub kind: &'a str,
    pub title: &'a str,
    pub body: &'a str,
    pub now: i64,
}

pub async fn create_issue(pool: &SqlitePool, issue: NewIssue<'_>) -> Result<i64> {
    let affected = query(
        "INSERT INTO post_issues (post_id, author_id, kind, title, body, state, created_at, updated_at) \
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?)",
    )
    .bind(issue.post_id)
    .bind(issue.author_id)
    .bind(issue.kind)
    .bind(issue.title)
    .bind(issue.body)
    .bind(issue.now)
    .bind(issue.now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    let issue_id = affected.last_insert_rowid();
    // 通知帖作者：有人给他提了 issue（自己提的不通知）
    let author: Option<(i64, String)> = query_as("SELECT author_id, title FROM posts WHERE id = ?")
        .bind(issue.post_id)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;
    if let Some((post_author, post_title)) = author
        && post_author != issue.author_id
    {
        let _ = notify(
            pool,
            NewNotification {
                user_id: post_author,
                actor_id: Some(issue.author_id),
                kind: "issue",
                title: &format!("《{post_title}》收到新的 {}：{}", issue.kind, issue.title),
                body: Some(issue.body),
                link: Some(&format!("/p/{}", issue.post_id)),
                now: issue.now,
            },
        )
        .await;
    }
    Ok(issue_id)
}

/// 列出某帖的 issue；`include_closed = false` 时只看待处理的。
pub async fn list_issues(
    pool: &SqlitePool,
    post_id: i64,
    include_closed: bool,
    limit: i64,
    offset: i64,
) -> Result<Vec<PostIssueRow>> {
    query_as::<_, PostIssueRow>(
        "SELECT i.id, i.post_id, i.author_id, i.kind, i.title, i.body, i.state, i.created_at, \
                i.updated_at, u.handle AS author_handle, \
                COALESCE(NULLIF(u.display_name, ''), u.handle) AS author_display_name, \
                (SELECT COUNT(*) FROM issue_comments c WHERE c.issue_id = i.id AND c.deleted_at IS NULL) AS comment_count \
         FROM post_issues i JOIN users u ON u.id = i.author_id \
         WHERE i.post_id = ? AND (? = 1 OR i.state = 'open') \
         ORDER BY i.state = 'open' DESC, i.id DESC LIMIT ? OFFSET ?",
    )
    .bind(post_id)
    .bind(i64::from(include_closed))
    .bind(limit.clamp(1, 100))
    .bind(offset.max(0))
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

pub async fn get_issue(pool: &SqlitePool, issue_id: i64) -> Result<Option<PostIssueRow>> {
    query_as::<_, PostIssueRow>(
        "SELECT i.id, i.post_id, i.author_id, i.kind, i.title, i.body, i.state, i.created_at, \
                i.updated_at, u.handle AS author_handle, \
                COALESCE(NULLIF(u.display_name, ''), u.handle) AS author_display_name, \
                (SELECT COUNT(*) FROM issue_comments c WHERE c.issue_id = i.id AND c.deleted_at IS NULL) AS comment_count \
         FROM post_issues i JOIN users u ON u.id = i.author_id WHERE i.id = ?",
    )
    .bind(issue_id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)
}

/// 开 / 关 issue（权限判定在 Web 层：提 issue 的人、帖作者、管理员都行）。
pub async fn set_issue_state(
    pool: &SqlitePool,
    issue_id: i64,
    state: &str,
    by: Option<i64>,
    now: i64,
) -> Result<bool> {
    let affected = query(
        "UPDATE post_issues SET state = ?, updated_at = ?, \
                closed_at = CASE WHEN ? = 'closed' THEN ? ELSE NULL END, \
                closed_by = CASE WHEN ? = 'closed' THEN ? ELSE NULL END \
         WHERE id = ? AND state <> ?",
    )
    .bind(state)
    .bind(now)
    .bind(state)
    .bind(now)
    .bind(state)
    .bind(by)
    .bind(issue_id)
    .bind(state)
    .execute(pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(affected == 1)
}

/// 某帖待处理的 issue 数（帖子上挂个小角标用）。
pub async fn count_open_issues(pool: &SqlitePool, post_id: i64) -> Result<i64> {
    let row: Option<(i64,)> =
        query_as("SELECT COUNT(*) FROM post_issues WHERE post_id = ? AND state = 'open'")
            .bind(post_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    Ok(row.map(|r| r.0).unwrap_or(0))
}

pub async fn add_issue_comment(
    pool: &SqlitePool,
    issue_id: i64,
    author_id: i64,
    body: &str,
    now: i64,
) -> Result<i64> {
    let res = query(
        "INSERT INTO issue_comments (issue_id, author_id, body, created_at) VALUES (?, ?, ?, ?)",
    )
    .bind(issue_id)
    .bind(author_id)
    .bind(body)
    .bind(now)
    .execute(pool)
    .await
    .map_err(db_err)?;
    // 有新回复就把 issue 的 updated_at 顶上去（列表排序/未读判断都用它）
    query("UPDATE post_issues SET updated_at = ? WHERE id = ?")
        .bind(now)
        .bind(issue_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    // 通知 issue 提出者：有人回复了（自己回自己的不通知）
    let issue: Option<(i64, i64, String)> =
        query_as("SELECT post_id, author_id, title FROM post_issues WHERE id = ?")
            .bind(issue_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    if let Some((post_id, issue_author, issue_title)) = issue
        && issue_author != author_id
    {
        let _ = notify(
            pool,
            NewNotification {
                user_id: issue_author,
                actor_id: Some(author_id),
                kind: "issue_reply",
                title: &format!("你的 issue「{issue_title}」有新回复"),
                body: Some(body),
                link: Some(&format!("/p/{post_id}")),
                now,
            },
        )
        .await;
    }
    Ok(res.last_insert_rowid())
}

pub async fn list_issue_comments(pool: &SqlitePool, issue_id: i64) -> Result<Vec<IssueCommentRow>> {
    query_as::<_, IssueCommentRow>(
        "SELECT c.id, c.issue_id, c.author_id, c.body, c.created_at, u.handle AS author_handle, \
                COALESCE(NULLIF(u.display_name, ''), u.handle) AS author_display_name \
         FROM issue_comments c JOIN users u ON u.id = c.author_id \
         WHERE c.issue_id = ? AND c.deleted_at IS NULL ORDER BY c.id",
    )
    .bind(issue_id)
    .fetch_all(pool)
    .await
    .map_err(db_err)
}

// ---------------- 横幅定向 ----------------

/// 设置横幅的定向用户组；空列表 = 所有人可见。
pub async fn set_banner_groups(pool: &SqlitePool, banner_id: i64, group_ids: &[i64]) -> Result<()> {
    let mut tx = pool.begin().await.map_err(db_err)?;
    query("DELETE FROM banner_groups WHERE banner_id = ?")
        .bind(banner_id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    for group_id in group_ids {
        query("INSERT OR IGNORE INTO banner_groups (banner_id, group_id) VALUES (?, ?)")
            .bind(banner_id)
            .bind(group_id)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    Ok(())
}

pub async fn list_banner_groups(pool: &SqlitePool, banner_id: i64) -> Result<Vec<i64>> {
    let rows: Vec<(i64,)> =
        query_as("SELECT group_id FROM banner_groups WHERE banner_id = ? ORDER BY group_id")
            .bind(banner_id)
            .fetch_all(pool)
            .await
            .map_err(db_err)?;
    Ok(rows.into_iter().map(|r| r.0).collect())
}
// ---------------------------------------------------------------- 后端补完：能力判定 / 通知 / 推送 / 头衔 / 经验

/// 某人在某分区的完整能力：**角色门槛 + 用户组规则（含禁止）+ 是否分区管理员**。
///
/// 一个函数给出全部判定，避免调用方自己拼（拼错一处就是一个越权口子）。
pub async fn section_capabilities(
    pool: &SqlitePool,
    user_id: i64,
    role: sc2clud_core::auth::Role,
    section: &str,
) -> Result<Option<sc2clud_core::community::SectionCapabilities>> {
    use sc2clud_core::community::{RuleVerdict, SectionCapabilities, resolve_section_action};
    let Some(record) = get_section(pool, section).await? else {
        return Ok(None);
    };
    let rules = group_rules_for_user_section(pool, user_id, section).await?;
    let post_verdicts: Vec<RuleVerdict> = rules
        .iter()
        .map(|rule| RuleVerdict::from_flags(rule.deny_post, rule.can_post))
        .collect();
    let reply_verdicts: Vec<RuleVerdict> = rules
        .iter()
        .map(|rule| RuleVerdict::from_flags(rule.deny_reply, rule.can_reply))
        .collect();
    let is_moderator = is_section_moderator(pool, section, user_id).await?;
    Ok(Some(SectionCapabilities {
        can_post: resolve_section_action(record.can_post(Some(role)), &post_verdicts),
        can_reply: resolve_section_action(record.can_reply(Some(role)), &reply_verdicts),
        is_moderator,
    }))
}

/// 按用户组推送帖子：标记 pushed_at + 给这些组的成员写通知（跳过作者自己）。
///
/// 一条 SQL 扇出，避免按成员逐个 insert（组可能几百人）。
pub async fn push_post_to_groups(
    pool: &SqlitePool,
    post_id: i64,
    group_ids: &[i64],
    now: i64,
) -> Result<u64> {
    if group_ids.is_empty() {
        return Ok(0);
    }
    let placeholders = group_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let title: Option<(String, i64)> =
        query_as("SELECT title, author_id FROM posts WHERE id = ? AND deleted_at IS NULL")
            .bind(post_id)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    let Some((post_title, author_id)) = title else {
        return Ok(0);
    };
    let sql = format!(
        "INSERT INTO notifications (user_id, kind, title, body, link, created_at) \
         SELECT DISTINCT m.user_id, 'push', ?, NULL, ?, ? \
         FROM user_group_members m JOIN user_groups g ON g.id = m.group_id \
         WHERE m.group_id IN ({placeholders}) AND g.archived_at IS NULL AND m.user_id <> ?"
    );
    let mut q = query(&sql).bind(format!("新帖：{post_title}"));
    q = q.bind(format!("/p/{post_id}"));
    q = q.bind(now);
    for group_id in group_ids {
        q = q.bind(group_id);
    }
    q = q.bind(author_id);
    let sent = q.execute(pool).await.map_err(db_err)?.rows_affected();
    query("UPDATE posts SET pushed_at = ? WHERE id = ?")
        .bind(now)
        .bind(post_id)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(sent)
}

/// 某人当前佩戴的头衔（没戴或没头衔则为 None）。
pub async fn equipped_title_for(pool: &SqlitePool, user_id: i64) -> Result<Option<TitleRow>> {
    query_as::<_, TitleRow>(
        "SELECT t.* FROM titles t JOIN users u ON u.equipped_title_id = t.id WHERE u.id = ?",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(db_err)
}

/// `equipped_titles_for` 的查询行：用户 id + 头衔各列。
type EquippedTitleRow = (i64, i64, String, String, String, String, Option<i64>);

/// 批量取「用户 → 佩戴的头衔」，给列表渲染用（一次查询，不做 N+1）。
pub async fn equipped_titles_for(
    pool: &SqlitePool,
    user_ids: &[i64],
) -> Result<Vec<(i64, TitleRow)>> {
    if user_ids.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = user_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT u.id AS uid, t.id, t.key, t.name, t.color, t.description, t.archived_at \
         FROM users u JOIN titles t ON t.id = u.equipped_title_id WHERE u.id IN ({placeholders})"
    );
    let mut q = query_as::<_, EquippedTitleRow>(&sql);
    for user_id in user_ids {
        q = q.bind(user_id);
    }
    let rows: Vec<EquippedTitleRow> = q.fetch_all(pool).await.map_err(db_err)?;
    Ok(rows
        .into_iter()
        .map(
            |(user_id, id, key, name, color, description, archived_at)| {
                (
                    user_id,
                    TitleRow {
                        id,
                        key,
                        name,
                        color,
                        description,
                        archived_at,
                    },
                )
            },
        )
        .collect())
}

/// 按动作发经验（数值来自 `core::community::ExpAction`，触发点由业务层决定）。
pub async fn award_exp(
    pool: &SqlitePool,
    user_id: i64,
    action: sc2clud_core::community::ExpAction,
    reference: Option<&str>,
    now: i64,
) -> Result<(i64, i64)> {
    add_exp(pool, user_id, action.exp(), action.as_str(), reference, now).await
}

pub async fn counter_value(pool: &SqlitePool, key: &str) -> Result<i64> {
    let row: Option<(i64,)> = query_as("SELECT value FROM counters WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(db_err)?;
    Ok(row.map(|r| r.0).unwrap_or(0))
}

#[cfg(test)]
mod discovery_tests {
    use super::*;
    use crate::Db;

    #[tokio::test]
    async fn search_and_pagination_keep_private_posts_private() {
        let db = Db::in_memory().await.unwrap();
        db.migrate().await.unwrap();
        let author = create_user(db.pool(), "author", None, "hash", 0, 1)
            .await
            .unwrap();
        for (title, section, review_state, now) in [
            ("Alpha 战役", "custom_campaign", "approved", 1),
            ("ALPHA 工具", "tool_player", "approved", 2),
            ("Alpha 私密", "custom_campaign", "pending", 3),
            ("Alpha 被拒", "custom_campaign", "rejected", 4),
        ] {
            create_post_reviewed(
                db.pool(),
                NewPost {
                    author_id: author,
                    kind: "discussion",
                    section,
                    title,
                    body: "内容介绍",
                    image_count: 0,
                    review_state,
                    review_note: None,
                    now,
                },
            )
            .await
            .unwrap();
        }
        let filter = FeedFilter {
            section: None,
            search: "alpha",
            popular: false,
        };
        assert_eq!(
            count_feed_filtered(db.pool(), None, false, &filter)
                .await
                .unwrap(),
            2
        );
        let first = list_feed_filtered(db.pool(), None, false, &filter, 1, 0)
            .await
            .unwrap();
        let second = list_feed_filtered(db.pool(), None, false, &filter, 1, 1)
            .await
            .unwrap();
        assert_eq!(first[0].title, "ALPHA 工具");
        assert_eq!(second[0].title, "Alpha 战役");
        assert_eq!(
            count_feed_filtered(db.pool(), Some(author), false, &filter)
                .await
                .unwrap(),
            3
        );
        assert_eq!(
            count_feed_filtered(db.pool(), None, true, &filter)
                .await
                .unwrap(),
            4
        );
        let section_filter = FeedFilter {
            section: Some("tool_player"),
            ..filter
        };
        assert_eq!(
            count_feed_filtered(db.pool(), None, false, &section_filter)
                .await
                .unwrap(),
            1
        );
        let literal = FeedFilter {
            section: None,
            search: "%",
            popular: false,
        };
        assert_eq!(
            count_feed_filtered(db.pool(), None, false, &literal)
                .await
                .unwrap(),
            0
        );
        let body = FeedFilter {
            section: None,
            search: "内容介绍",
            popular: false,
        };
        assert_eq!(
            count_feed_filtered(db.pool(), None, false, &body)
                .await
                .unwrap(),
            2
        );
        query("UPDATE posts SET archived_at = 5 WHERE title = 'ALPHA 工具'")
            .execute(db.pool())
            .await
            .unwrap();
        assert_eq!(
            count_feed_filtered(db.pool(), None, false, &body)
                .await
                .unwrap(),
            1
        );
    }

    #[tokio::test]
    async fn popular_order_uses_real_interactions() {
        let db = Db::in_memory().await.unwrap();
        db.migrate().await.unwrap();
        let author = create_user(db.pool(), "author", None, "hash", 0, 1)
            .await
            .unwrap();
        let old = create_post(db.pool(), author, "旧帖", "旧帖正文", 1)
            .await
            .unwrap();
        create_post(db.pool(), author, "新帖", "新帖正文", 2)
            .await
            .unwrap();
        create_comment(db.pool(), old, author, "实际回复", None, 3)
            .await
            .unwrap();
        let filter = FeedFilter {
            section: None,
            search: "",
            popular: true,
        };
        let rows = list_feed_filtered(db.pool(), None, false, &filter, 20, 0)
            .await
            .unwrap();
        assert_eq!(rows[0].id, old);
    }
}
