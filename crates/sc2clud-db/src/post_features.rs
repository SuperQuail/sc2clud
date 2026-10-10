//! 精华条件更新与原子审计。

use sc2clud_core::Result;
use sqlx::{SqlitePool, query, query_as};

use crate::db_err;

/// 精华：显式设置目标状态，返回是否变化。条件更新与审计同事务提交。
pub async fn set_post_featured(
    pool: &SqlitePool,
    post_id: i64,
    featured: bool,
    by: Option<i64>,
    now: i64,
) -> Result<bool> {
    let mut tx = pool.begin().await.map_err(db_err)?;
    let affected = query(
        "UPDATE posts SET featured_at = CASE WHEN ? = 1 THEN ? ELSE NULL END, \
                featured_by = CASE WHEN ? = 1 THEN ? ELSE NULL END \
         WHERE id = ? AND deleted_at IS NULL AND (featured_at IS NOT NULL) <> ? \
           AND (? = 0 OR (review_state = 'approved' AND archived_at IS NULL \
                AND EXISTS (SELECT 1 FROM sections s WHERE s.key = posts.section AND s.archived_at IS NULL)))",
    )
    .bind(i64::from(featured))
    .bind(now)
    .bind(i64::from(featured))
    .bind(by)
    .bind(post_id)
    .bind(i64::from(featured))
    .bind(i64::from(featured))
    .execute(&mut *tx)
    .await
    .map_err(db_err)?
    .rows_affected();
    if affected == 1 {
        query("INSERT INTO audit_log (actor_id, action, target, detail, created_at) VALUES (?, ?, ?, NULL, ?)")
            .bind(by)
            .bind(if featured { "post.featured.set" } else { "post.featured.clear" })
            .bind(format!("post:{post_id}"))
            .bind(now)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    } else if featured {
        let blocked: Option<(i64,)> = query_as(
            "SELECT 1 FROM posts p WHERE p.id = ? AND p.deleted_at IS NULL \
             AND (p.review_state <> 'approved' OR p.archived_at IS NOT NULL \
                  OR NOT EXISTS (SELECT 1 FROM sections s WHERE s.key = p.section AND s.archived_at IS NULL))",
        ).bind(post_id).fetch_optional(&mut *tx).await.map_err(db_err)?;
        if blocked.is_some() {
            return Err(sc2clud_core::Error::Forbidden(
                "只能为已通过审核且未归档的帖子添加精华".to_string(),
            ));
        }
    }
    tx.commit().await.map_err(db_err)?;
    Ok(affected == 1)
}
