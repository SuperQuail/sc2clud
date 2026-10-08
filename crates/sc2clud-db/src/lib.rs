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
    BlobRow, CommentRow, FileRow, FileWithOwnerRow, PostRow, UploadSessionRow, UserRow,
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
}
