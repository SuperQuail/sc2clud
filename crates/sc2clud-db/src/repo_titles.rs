//! 头衔（titles / user_titles）相关的仓储函数。
//!
//! 从 repo.rs 拆出：那里已经贴到体量门禁的上限（见 scripts/check-size.mjs）。

use sc2clud_core::Result;
use sqlx::SqlitePool;
use sqlx::{query, query_as};

use crate::db_err;
use crate::models::{TitleRow, UserTitleRow};

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

/// 批量取「用户 → 持有的头衔 id」，给管理面板的列表一次拿全（不做 N+1）。
pub async fn held_title_ids_for(
    pool: &SqlitePool,
    user_ids: &[i64],
) -> Result<std::collections::HashMap<i64, Vec<i64>>> {
    let mut held: std::collections::HashMap<i64, Vec<i64>> = std::collections::HashMap::new();
    if user_ids.is_empty() {
        return Ok(held);
    }
    let marks = user_ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
    let sql = format!("SELECT user_id, title_id FROM user_titles WHERE user_id IN ({marks})");
    let mut q = query_as::<_, (i64, i64)>(&sql);
    for user_id in user_ids {
        q = q.bind(user_id);
    }
    for (user_id, title_id) in q.fetch_all(pool).await.map_err(db_err)? {
        held.entry(user_id).or_default().push(title_id);
    }
    Ok(held)
}
