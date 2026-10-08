//! SQLite（WAL）元数据库访问层。
//!
//! 选型理由：SQLite 没有独立进程、没有专属缓冲池，省下来的内存全部变成文件缓存；
//! 单实例应用下并发完全够用。详见 `docs/TECH_STACK.md`。
//!
//! **写并发约束**：SQLite 是单写者。浏览数、下载数这类写热点一律先进内存聚合
//! （`sc2clud_core::Counters`），再由 [`repo::flush_counters`] 批量落库；
//! 禁止在请求路径里每请求一条 `UPDATE`。
//!
//! 迁移在**编译期**嵌入二进制（`sqlx::migrate!`），因此单文件部署不必额外携带 SQL 目录。

use std::path::Path;
use std::time::Duration;

use sc2clud_core::{Error, Result};
use sqlx::SqlitePool;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous};

pub mod models;
pub mod repo;

pub use models::{
    AuditRow, BlobRow, CommentRow, CommentWithAuthorRow, FileRow, FileWithOwnerRow, ImageJobRow,
    PostImageRow, PostRow, PostWithAuthorRow, ReleaseAssetRow, ReleaseRow, SessionRow,
    UploadSessionRow, UserRow,
};

/// 编译期嵌入的迁移集合。
pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../migrations");

/// 连接池上限：SQLite 单写者，池子给大反而增加写锁竞争。
const MAX_CONNECTIONS: u32 = 4;

/// 写锁等待上限：超过就报错返回，让 nginx 的限流去挡流量。
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);

/// 页缓存 16 MiB（负值单位为 KiB）。不设过大：文件缓存靠 OS page cache，
/// SQLite 自己的缓存只服务于索引与热点行。
const CACHE_SIZE_KIB: i32 = -16_000;

/// mmap 读放大：虚拟地址映射，实际占用由 page cache 决定。
const MMAP_SIZE_BYTES: i64 = 256 * 1024 * 1024;

/// 元数据库句柄（连接池 + 迁移）。
#[derive(Clone)]
pub struct Db {
    pool: SqlitePool,
}

impl Db {
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    /// 打开（必要时创建）磁盘库，并启用 WAL。
    pub async fn connect(db_path: &Path) -> Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                Error::Config(format!("无法创建数据库目录 {}：{e}", parent.display()))
            })?;
        }
        let options = base_options()
            .filename(db_path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal);
        Self::from_options(options, MAX_CONNECTIONS).await
    }

    /// 内存库：**只用于测试**。连接数固定为 1——内存库的每个连接都是独立数据库。
    pub async fn in_memory() -> Result<Self> {
        let options = base_options().filename(":memory:");
        Self::from_options(options, 1).await
    }

    async fn from_options(options: SqliteConnectOptions, max_connections: u32) -> Result<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(max_connections)
            .acquire_timeout(Duration::from_secs(10))
            .connect_with(options)
            .await
            .map_err(db_err)?;
        Ok(Self { pool })
    }

    /// 跑迁移（幂等：已应用的版本会被跳过）。
    pub async fn migrate(&self) -> Result<()> {
        // Migrator::run 返回的是 MigrateError（迁移专用的错误类型），单独转换。
        MIGRATOR
            .run(&self.pool)
            .await
            .map_err(|e| Error::Database(format!("迁移失败：{e}")))
    }

    /// 就绪探针：真的打一次数据库（`/readyz` 用）。
    pub async fn ping(&self) -> Result<()> {
        sqlx::query("SELECT 1")
            .fetch_one(&self.pool)
            .await
            .map_err(db_err)?;
        Ok(())
    }

    /// 优雅关闭：等待在途语句结束后关闭池。
    pub async fn close(self) {
        self.pool.close().await;
    }
}

/// 与内存库/磁盘库共用的 PRAGMA 基线。
fn base_options() -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .busy_timeout(BUSY_TIMEOUT)
        .foreign_keys(true)
        .pragma("cache_size", CACHE_SIZE_KIB.to_string())
        .pragma("temp_store", "MEMORY")
        .pragma("mmap_size", MMAP_SIZE_BYTES.to_string())
}

/// 把 sqlx 的错误归一到领域错误，避免 sqlx 类型泄漏到上层。
pub(crate) fn db_err(e: sqlx::Error) -> Error {
    Error::Database(e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo;

    async fn db() -> Db {
        let db = Db::in_memory().await.expect("内存库");
        db.migrate().await.expect("迁移应成功");
        db
    }

    #[tokio::test]
    async fn migrations_create_expected_tables() {
        let db = db().await;
        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
                .fetch_all(db.pool())
                .await
                .expect("查询");
        let names: Vec<String> = rows.into_iter().map(|r| r.0).collect();
        for expected in [
            "blobs",
            "comments",
            "counters",
            "files",
            "notifications",
            "posts",
            "sessions",
            "upload_sessions",
            "users",
        ] {
            assert!(
                names.iter().any(|n| n == expected),
                "缺表 {expected}，实际 {names:?}"
            );
        }
    }

    #[tokio::test]
    async fn ensure_blob_is_idempotent_and_tracks_refcount() {
        let db = db().await;
        let now = sc2clud_core::now_unix();
        assert!(
            repo::ensure_blob(db.pool(), "aa", 10, now)
                .await
                .expect("首次")
        );
        assert!(
            !repo::ensure_blob(db.pool(), "aa", 10, now)
                .await
                .expect("再次")
        );
        let blob = repo::find_blob(db.pool(), "aa")
            .await
            .expect("查询")
            .expect("存在");
        assert_eq!(blob.refcount, 2, "两次登记应累加引用计数");
        assert_eq!(blob.size, 10);
    }

    #[tokio::test]
    async fn file_lifecycle_with_soft_delete() {
        let db = db().await;
        let now = sc2clud_core::now_unix();
        let user = repo::create_user(db.pool(), "tester", None, "argon2-hash", 1024, now)
            .await
            .expect("建用户");
        repo::ensure_blob(db.pool(), "ab", 5, now)
            .await
            .expect("登记内容");
        let file = repo::create_file(
            db.pool(),
            repo::NewFile {
                owner_id: user,
                blob_hash: "ab",
                name: "地图.zip",
                mime: "application/zip",
                size: 5,
                now,
            },
        )
        .await
        .expect("建文件");

        let row = repo::get_file(db.pool(), file)
            .await
            .expect("查询")
            .expect("存在");
        assert_eq!(row.name, "地图.zip");
        assert_eq!(row.download_count, 0);

        let joined = repo::get_file_with_owner(db.pool(), file)
            .await
            .expect("查询")
            .expect("存在");
        assert_eq!(joined.owner_handle, "tester");

        assert!(
            repo::soft_delete_file(db.pool(), file, user, now + 1)
                .await
                .expect("软删除")
        );
        assert!(
            repo::get_file(db.pool(), file)
                .await
                .expect("查询")
                .is_none()
        );
        assert!(
            !repo::soft_delete_file(db.pool(), file, user, now + 2)
                .await
                .expect("重复删除"),
            "重复软删除应返回 false"
        );
        let blob = repo::find_blob(db.pool(), "ab")
            .await
            .expect("查询")
            .expect("存在");
        assert_eq!(blob.refcount, 0, "文件删除后引用计数应归零");
    }

    #[tokio::test]
    async fn counters_flush_accumulates_across_batches() {
        let db = db().await;
        let first = vec![
            ("post:1:views".to_string(), 3),
            ("file:9:downloads".to_string(), 1),
        ];
        let second = vec![("post:1:views".to_string(), 4)];

        repo::flush_counters(db.pool(), &first)
            .await
            .expect("第一批");
        repo::flush_counters(db.pool(), &second)
            .await
            .expect("第二批");
        repo::flush_counters(db.pool(), &[])
            .await
            .expect("空批次应是 no-op");

        assert_eq!(
            repo::counter_value(db.pool(), "post:1:views")
                .await
                .expect("查询"),
            7
        );
        assert_eq!(
            repo::counter_value(db.pool(), "file:9:downloads")
                .await
                .expect("查询"),
            1
        );
        assert_eq!(
            repo::counter_value(db.pool(), "missing")
                .await
                .expect("查询"),
            0
        );
    }

    #[tokio::test]
    async fn posts_are_listed_newest_first() {
        let db = db().await;
        let now = sc2clud_core::now_unix();
        let user = repo::create_user(db.pool(), "author", None, "h", 0, now)
            .await
            .expect("建用户");
        repo::create_post(db.pool(), user, "第一篇", "body1", now)
            .await
            .expect("post1");
        repo::create_post(db.pool(), user, "第二篇", "body2", now + 1)
            .await
            .expect("post2");

        let posts = repo::list_posts(db.pool(), 10, 0).await.expect("列表");
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[0].title, "第二篇");
        assert_eq!(repo::count_posts(db.pool()).await.expect("计数"), 2);
    }

    #[tokio::test]
    async fn upload_session_round_trip() {
        let db = db().await;
        let now = sc2clud_core::now_unix();
        let user = repo::create_user(db.pool(), "uploader", None, "h", 0, now)
            .await
            .expect("建用户");
        repo::create_upload_session(
            db.pool(),
            repo::NewUploadSession {
                id: "sess-1",
                owner_id: user,
                name: "big.iso",
                declared_size: 8_388_608,
                chunk_size: 4_194_304,
                now,
                expires_at: now + 3600,
            },
        )
        .await
        .expect("建会话");

        let found = repo::find_upload_session(db.pool(), "sess-1")
            .await
            .expect("查询")
            .expect("存在");
        assert_eq!(found.declared_size, 8_388_608);
        assert_eq!(found.received_chunks, "[]");
        assert!(
            repo::find_upload_session(db.pool(), "nope")
                .await
                .expect("查询")
                .is_none()
        );
    }

    #[tokio::test]
    async fn registration_is_inactive_by_default() {
        let db = db().await;
        let now = sc2clud_core::now_unix();
        let id = repo::register_user(
            db.pool(),
            repo::NewUser {
                handle: "newbie",
                display_name: "新人",
                email: "n@example.com",
                password_hash: "$argon2id$hash",
                activated: false,
                now,
            },
        )
        .await
        .expect("注册");
        let user = repo::find_user_by_email(db.pool(), "n@example.com")
            .await
            .expect("查询")
            .expect("存在");
        assert_eq!(user.id, id);
        assert!(user.activated_at.is_none(), "注册用户默认未激活");
        assert_eq!(user.role, "member");
        assert!(
            repo::registration_requires_activation(db.pool())
                .await
                .expect("设置")
        );
        repo::set_setting(db.pool(), repo::SETTING_REQUIRE_ACTIVATION, "0", None, now)
            .await
            .expect("改设置");
        assert!(
            !repo::registration_requires_activation(db.pool())
                .await
                .expect("设置")
        );
    }

    #[tokio::test]
    async fn display_name_is_stored_and_shown_in_feed() {
        let db = db().await;
        let now = sc2clud_core::now_unix();
        let user = repo::register_user(
            db.pool(),
            repo::NewUser {
                handle: "miyin_fan",
                display_name: "弥音小助手",
                email: "fan@example.com",
                password_hash: "h",
                activated: true,
                now,
            },
        )
        .await
        .expect("注册");

        let row = repo::find_user_by_handle(db.pool(), "miyin_fan")
            .await
            .expect("查询")
            .expect("存在");
        assert_eq!(row.handle, "miyin_fan", "登录名保持 ASCII 标识");
        assert_eq!(row.display_name, "弥音小助手", "显示名可与登录名不同");

        let post = repo::create_post_reviewed(
            db.pool(),
            repo::NewPost {
                author_id: user,
                kind: "discussion",
                title: "显示名测试",
                body: "看卡片上显示的是哪个名字。",
                image_count: 0,
                review_state: "approved",
                review_note: None,
                now,
            },
        )
        .await
        .expect("发帖");
        repo::create_comment(db.pool(), post, user, "回复也用显示名。", now)
            .await
            .expect("回复");

        let feed = repo::list_feed(db.pool(), None, false, 10, 0)
            .await
            .expect("feed");
        assert_eq!(feed[0].author_handle, "miyin_fan");
        assert_eq!(
            feed[0].author_display_name, "弥音小助手",
            "feed 必须带显示名，页面展示它"
        );

        let comments = repo::list_comments(db.pool(), post, 10)
            .await
            .expect("回复");
        assert_eq!(comments[0].author_display_name, "弥音小助手");

        // 改显示名不影响登录名
        assert!(
            repo::set_display_name(db.pool(), user, "改名后的小助手")
                .await
                .expect("改名")
        );
        let feed = repo::list_feed(db.pool(), None, false, 10, 0)
            .await
            .expect("feed");
        assert_eq!(feed[0].author_display_name, "改名后的小助手");
        assert_eq!(feed[0].author_handle, "miyin_fan");
    }

    #[tokio::test]
    async fn activation_and_role_changes_are_idempotent() {
        let db = db().await;
        let now = sc2clud_core::now_unix();
        let admin = repo::register_user(
            db.pool(),
            repo::NewUser {
                handle: "admin1",
                display_name: "管理员一号",
                email: "a@example.com",
                password_hash: "h",
                activated: true,
                now,
            },
        )
        .await
        .expect("管理员");
        let member = repo::register_user(
            db.pool(),
            repo::NewUser {
                handle: "member1",
                display_name: "普通用户一号",
                email: "m@example.com",
                password_hash: "h",
                activated: false,
                now,
            },
        )
        .await
        .expect("普通用户");

        assert!(
            repo::set_user_activated(db.pool(), member, true, admin, now)
                .await
                .expect("激活")
        );
        assert!(
            !repo::set_user_activated(db.pool(), member, true, admin, now)
                .await
                .expect("重复激活"),
            "重复激活应幂等"
        );
        let row = repo::find_user_by_id_any(db.pool(), member)
            .await
            .expect("查询")
            .expect("存在");
        assert!(row.activated_at.is_some());
        assert_eq!(row.activated_by, Some(admin));

        assert!(
            repo::set_user_role(db.pool(), member, "developer")
                .await
                .expect("改角色")
        );
        assert!(
            !repo::set_user_role(db.pool(), member, "developer")
                .await
                .expect("重复改角色"),
            "角色没变时不该报告改动"
        );
        assert!(
            repo::set_user_activated(db.pool(), member, false, admin, now)
                .await
                .expect("停用")
        );
        assert!(
            repo::find_user_by_id_any(db.pool(), member)
                .await
                .expect("查询")
                .expect("存在")
                .activated_at
                .is_none()
        );
        assert_eq!(repo::count_users(db.pool()).await.expect("计数"), 2);
    }

    #[tokio::test]
    async fn audit_log_keeps_newest_first() {
        let db = db().await;
        let now = sc2clud_core::now_unix();
        repo::record_audit(
            db.pool(),
            Some(1),
            "user.activate",
            Some("user:2"),
            Some("由管理员激活"),
            now,
        )
        .await
        .expect("写审计");
        repo::record_audit(db.pool(), None, "system.bootstrap", None, None, now + 1)
            .await
            .expect("写审计");
        let rows = repo::recent_audit(db.pool(), 10).await.expect("读审计");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].action, "system.bootstrap", "最新在前");
    }

    #[tokio::test]
    async fn post_review_state_gates_visibility() {
        let db = db().await;
        let now = sc2clud_core::now_unix();
        let user = repo::register_user(
            db.pool(),
            repo::NewUser {
                handle: "poster",
                display_name: "发帖人",
                email: "p@example.com",
                password_hash: "h",
                activated: true,
                now,
            },
        )
        .await
        .expect("用户");

        let approved = repo::create_post_reviewed(
            db.pool(),
            repo::NewPost {
                author_id: user,
                kind: "resource",
                title: "地图包",
                body: "看 http://x.example",
                image_count: 0,
                review_state: "approved",
                review_note: None,
                now,
            },
        )
        .await
        .expect("发帖");
        let pending = repo::create_post_reviewed(
            db.pool(),
            repo::NewPost {
                author_id: user,
                kind: "discussion",
                title: "好物",
                body: "加微信",
                image_count: 0,
                review_state: "pending",
                review_note: Some("命中可疑词"),
                now: now + 1,
            },
        )
        .await
        .expect("发帖");
        let rejected = repo::create_post_reviewed(
            db.pool(),
            repo::NewPost {
                author_id: user,
                kind: "discussion",
                title: "x",
                body: "y",
                image_count: 0,
                review_state: "rejected",
                review_note: Some("标题过短"),
                now: now + 2,
            },
        )
        .await
        .expect("发帖");

        // 游客视角：只看得到 approved
        let guest = repo::list_feed(db.pool(), None, false, 10, 0)
            .await
            .expect("游客列表");
        let guest_ids: Vec<i64> = guest.iter().map(|p| p.id).collect();
        assert!(guest_ids.contains(&approved));
        assert!(!guest_ids.contains(&pending), "游客看不到审核中的帖子");
        assert!(!guest_ids.contains(&rejected));

        // 作者视角：能看到自己被审的帖子
        let mine = repo::list_feed(db.pool(), Some(user), false, 10, 0)
            .await
            .expect("作者列表");
        let mine_ids: Vec<i64> = mine.iter().map(|p| p.id).collect();
        assert!(mine_ids.contains(&pending), "作者能看到自己的待审帖");
        assert!(!mine_ids.contains(&rejected));

        // 管理员视角：全部可见
        let staff = repo::list_feed(db.pool(), None, true, 10, 0)
            .await
            .expect("管理员列表");
        let staff_ids: Vec<i64> = staff.iter().map(|p| p.id).collect();
        assert!(staff_ids.contains(&approved) && staff_ids.contains(&pending));
        assert!(staff_ids.contains(&rejected), "管理员能复查被拒的帖子");

        assert!(
            repo::get_post_for(db.pool(), pending, None, false)
                .await
                .expect("查询")
                .is_none(),
            "游客取不到审核中的帖子"
        );
        assert!(
            repo::get_post_for(db.pool(), pending, Some(user), false)
                .await
                .expect("查询")
                .is_some(),
            "作者取得到自己的待审帖"
        );
        assert!(
            repo::get_post_for(db.pool(), pending, None, true)
                .await
                .expect("查询")
                .is_some(),
            "管理员取得到"
        );

        let row = repo::get_post(db.pool(), pending)
            .await
            .expect("查询")
            .expect("存在");
        assert_eq!(row.kind, "discussion");
        assert_eq!(row.review_state, "pending");
        assert_eq!(row.auto_reviewed, 1);

        assert!(
            repo::set_post_review_state(db.pool(), pending, "approved", None, user, now + 3)
                .await
                .expect("人工改判")
        );
        let row = repo::get_post(db.pool(), pending)
            .await
            .expect("查询")
            .expect("存在");
        assert_eq!(row.review_state, "approved");
        assert_eq!(row.auto_reviewed, 0, "人工改判后不再是自动结论");
    }

    #[tokio::test]
    async fn post_images_are_queued_and_claimed_once() {
        let db = db().await;
        let now = sc2clud_core::now_unix();
        let user = repo::register_user(
            db.pool(),
            repo::NewUser {
                handle: "sharer",
                display_name: "分享者",
                email: "s@example.com",
                password_hash: "h",
                activated: true,
                now,
            },
        )
        .await
        .expect("用户");
        let post = repo::create_post_reviewed(
            db.pool(),
            repo::NewPost {
                author_id: user,
                kind: "resource",
                title: "图集",
                body: "看图",
                image_count: 0,
                review_state: "approved",
                review_note: None,
                now,
            },
        )
        .await
        .expect("发帖");

        let image = repo::add_post_image(db.pool(), post, 0, "abc123", 4096, "image/png", now)
            .await
            .expect("加图");
        let images = repo::list_post_images(db.pool(), post).await.expect("读图");
        assert_eq!(images.len(), 1);
        assert_eq!(images[0].state, "processing");
        assert_eq!(images[0].original_hash, "abc123", "原图哈希永久保留");
        assert!(images[0].display_hash.is_none());
        assert_eq!(repo::pending_image_jobs(db.pool()).await.expect("队列"), 1);

        let jobs = repo::claim_image_jobs(db.pool(), 10, now)
            .await
            .expect("领取");
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].image_id, image);
        assert_eq!(jobs[0].attempts, 1);
        assert!(
            repo::claim_image_jobs(db.pool(), 10, now)
                .await
                .expect("再领")
                .is_empty(),
            "已被领取的任务不能被重复领取"
        );

        repo::finish_post_image(db.pool(), image, "disp", "thumb", 1280, 720, 2048)
            .await
            .expect("回填");
        repo::finish_image_job(db.pool(), jobs[0].id, now)
            .await
            .expect("完成任务");
        let images = repo::list_post_images(db.pool(), post).await.expect("读图");
        assert_eq!(images[0].state, "ready");
        assert_eq!(images[0].display_hash.as_deref(), Some("disp"));
        assert_eq!(images[0].width, Some(1280));
        assert_eq!(repo::pending_image_jobs(db.pool()).await.expect("队列"), 0);
    }
}
