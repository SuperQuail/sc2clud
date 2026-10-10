//! 首页筛选、排序与分页。
use crate::{PostWithAuthorRow, db_err};
use sc2clud_core::Result;
use sqlx::{SqlitePool, query_as};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum FeedSort {
    #[default]
    Recommended,
    Active,
    Likes,
    Latest,
}
impl FeedSort {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("active") => Self::Active,
            Some("likes") => Self::Likes,
            Some("latest") => Self::Latest,
            _ => Self::Recommended,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Recommended => "recommended",
            Self::Active => "active",
            Self::Likes => "likes",
            Self::Latest => "latest",
        }
    }
    fn order(self) -> &'static str {
        match self {
            Self::Recommended => {
                "(CASE WHEN p.featured_at IS NULL THEN 5 * (COALESCE(l.like_count,0) + 3 * COALESCE(c.root_comment_count,0)) ELSE 6 * (COALESCE(l.like_count,0) + 3 * COALESCE(c.root_comment_count,0)) + 100 END) DESC"
            }
            Self::Active => {
                "max(p.created_at, COALESCE(c.active_at,p.created_at), COALESCE(i.active_at,p.created_at), COALESCE(ic.active_at,p.created_at)) DESC"
            }
            Self::Likes => "COALESCE(l.like_count,0) DESC",
            Self::Latest => "p.created_at DESC",
        }
    }
}
pub struct FeedFilter<'a> {
    pub section: Option<&'a str>,
    pub search: &'a str,
    pub sort: FeedSort,
}
const FILTER: &str = "p.deleted_at IS NULL AND p.archived_at IS NULL
AND NOT EXISTS (SELECT 1 FROM sections sec WHERE sec.key=p.section AND sec.archived_at IS NOT NULL)
AND (?3='' OR p.section=?3)
AND (?4='' OR instr(lower(p.title || ' ' || p.body),lower(?4))>0)
AND (p.review_state='approved' OR ?2=1 OR (p.review_state='pending' AND p.author_id=?1))";
const AGGREGATES: &str = "LEFT JOIN (SELECT post_id, COUNT(*) AS comment_count, SUM(CASE WHEN parent_id IS NULL THEN 1 ELSE 0 END) AS root_comment_count, MAX(created_at) AS active_at FROM comments WHERE deleted_at IS NULL GROUP BY post_id) c ON c.post_id=p.id
LEFT JOIN (SELECT post_id, COUNT(*) AS like_count FROM post_likes GROUP BY post_id) l ON l.post_id=p.id
LEFT JOIN (SELECT post_id, MAX(created_at) AS active_at FROM post_issues GROUP BY post_id) i ON i.post_id=p.id
LEFT JOIN (SELECT pi.post_id, MAX(ic.created_at) AS active_at FROM issue_comments ic JOIN post_issues pi ON pi.id=ic.issue_id WHERE ic.deleted_at IS NULL GROUP BY pi.post_id) ic ON ic.post_id=p.id";
const SELECT: &str = r#"SELECT p.id, p.title, p.body, p.kind, p.section, p.review_state, p.review_note,
                p.image_count, p.created_at, p.author_id, u.handle AS author_handle,
                u.display_name AS author_display_name, u.avatar_hash AS author_avatar,
                u.role AS author_role,
                (SELECT COALESCE(pi.display_hash, pi.original_hash)
                 FROM post_images pi WHERE pi.post_id=p.id AND pi.state <> 'failed' ORDER BY pi.position, pi.id LIMIT 1) AS cover_hash,
COALESCE(c.comment_count,0) AS comment_count, p.archived_at, p.featured_at,
COALESCE(l.like_count,0) AS like_count,
(SELECT COUNT(*) FROM post_bookmarks pb WHERE pb.post_id=p.id) AS bookmark_count
FROM posts p JOIN users u ON u.id=p.author_id"#;

pub async fn list_feed_filtered(
    pool: &SqlitePool,
    viewer_id: Option<i64>,
    is_staff: bool,
    filter: &FeedFilter<'_>,
    limit: i64,
    offset: i64,
) -> Result<Vec<PostWithAuthorRow>> {
    let sql = format!(
        "{SELECT} {AGGREGATES} WHERE {FILTER} ORDER BY p.pinned_rank DESC, {}, p.created_at DESC, p.id DESC LIMIT ?5 OFFSET ?6",
        filter.sort.order()
    );
    query_as::<_, PostWithAuthorRow>(&sql)
        .bind(viewer_id.unwrap_or(-1))
        .bind(i64::from(is_staff))
        .bind(filter.section.unwrap_or(""))
        .bind(filter.search)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await
        .map_err(db_err)
}
pub async fn count_feed_filtered(
    pool: &SqlitePool,
    viewer_id: Option<i64>,
    is_staff: bool,
    filter: &FeedFilter<'_>,
) -> Result<i64> {
    let sql =
        format!("SELECT COUNT(*) FROM posts p JOIN users u ON u.id=p.author_id WHERE {FILTER}");
    let row: (i64,) = query_as(&sql)
        .bind(viewer_id.unwrap_or(-1))
        .bind(i64::from(is_staff))
        .bind(filter.section.unwrap_or(""))
        .bind(filter.search)
        .fetch_one(pool)
        .await
        .map_err(db_err)?;
    Ok(row.0)
}
