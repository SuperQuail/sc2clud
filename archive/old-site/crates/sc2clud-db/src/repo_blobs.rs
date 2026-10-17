//! blob（内容寻址存储）相关的仓储函数。
//!\n//! 从 repo.rs 拆出：该文件属于体量门禁的待重构清单（见 scripts/check-size.mjs）。

use crate::{Result, db_err};
use sqlx::SqlitePool;
use sqlx::{query, query_as};

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

pub async fn blob_visibility(pool: &SqlitePool, hash: &str) -> Result<Option<(Option<i64>, i64)>> {
    let row: Option<(Option<i64>, i64)> =
        query_as("SELECT owner_id, visibility FROM blobs WHERE hash = ?")
            .bind(hash)
            .fetch_optional(pool)
            .await
            .map_err(db_err)?;
    Ok(row)
}

pub async fn set_blob_visibility(
    pool: &SqlitePool,
    hash: &str,
    owner_id: i64,
    level: i64,
) -> Result<()> {
    query("UPDATE blobs SET visibility = ?, owner_id = ? WHERE hash = ?")
        .bind(level)
        .bind(owner_id)
        .bind(hash)
        .execute(pool)
        .await
        .map_err(db_err)?;
    Ok(())
}
