//! 管理页的帖子审核动作：人工过审 / 拒绝 / 归档 / 取消归档。
//!
//! 从 pages_admin.rs 拆出（该文件超出体量门禁的 500 行）。这里只负责
//! 「鉴权 → 落审核状态（+ 处理待审修改）→ 写审计」，判定规则在 core::review。

use axum::Form;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use sc2clud_core::auth::Permission;
use sc2clud_core::now_unix;
use sc2clud_db::repo;
use serde::Deserialize;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::pages_admin::done;
use crate::routes::require_user;
use crate::session;

/// 人工过审 / 拒绝的表单：意见留空则用默认文案。
#[derive(Debug, Deserialize)]
pub struct ReviewForm {
    pub csrf: String,
    #[serde(default)]
    pub note: Option<String>,
}

/// 归档 / 取消归档：走的是同一份「可选意见」表单。
#[derive(Debug, Deserialize)]
pub struct ArchiveForm {
    pub csrf: String,
    #[serde(default)]
    pub note: Option<String>,
}

/// 表单里的意见：只有空白等于没填（各审核端点共用同一份判断）。
pub(crate) fn typed_note(note: Option<&str>) -> Option<&str> {
    // shortcut: 只去空白，不做长度校验；等出现超长意见撑爆审计日志时再补上限
    note.map(str::trim).filter(|s| !s.is_empty())
}

/// 人工通过：待审修改落地（替换原帖），帖子转 approved。
pub async fn approve(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<ReviewForm>,
) -> AppResult<Response> {
    review(&state, id, &headers, &form, true).await
}

/// 人工拒绝：丢弃待审修改（原帖不受影响），帖子转 rejected。
pub async fn reject(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<ReviewForm>,
) -> AppResult<Response> {
    review(&state, id, &headers, &form, false).await
}

/// 归档 = 不删除、不再展示（列表里消失，直链仍可打开）。
pub async fn archive(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<ArchiveForm>,
) -> AppResult<Response> {
    set_archived(state, id, headers, form, true).await
}

pub async fn unarchive(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<ArchiveForm>,
) -> AppResult<Response> {
    set_archived(state, id, headers, form, false).await
}

/// 人工过审 / 拒绝的公共流程。管理员及以上（Permission::ReviewPost，产品要求从开发者上调）。
async fn review(
    state: &AppState,
    id: i64,
    headers: &HeaderMap,
    form: &ReviewForm,
    allow: bool,
) -> AppResult<Response> {
    let actor = require_user(state, headers).await?;
    session::guard(Some(&actor), Permission::ReviewPost)?;
    session::check_csrf(&actor, &form.csrf)?;
    let (fallback, review_state, action, message) = if allow {
        ("管理员人工通过", "approved", "post.approve", "已通过")
    } else {
        ("管理员人工拒绝", "rejected", "post.reject", "已拒绝")
    };
    // 待审修改：通过就落地（替换原帖），拒绝就丢弃（原帖不受影响）
    let _ = if allow {
        repo::apply_pending_revision(state.db.pool(), id, now_unix()).await
    } else {
        repo::drop_pending_revision(state.db.pool(), id).await
    };
    let now = now_unix();
    let note = typed_note(form.note.as_deref()).unwrap_or(fallback);
    if !repo::set_post_review_state(state.db.pool(), id, review_state, Some(note), actor.id, now)
        .await?
    {
        return Err(AppError::not_found("帖子不存在"));
    }
    tracing::info!(
        post.id = id,
        review_state,
        actor.id = actor.id,
        "人工改判审核状态"
    );
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        action,
        Some(&format!("post:{id}")),
        Some(note),
        now,
    )
    .await;
    Ok(done(headers, message, "/admin/users/overview"))
}

async fn set_archived(
    state: AppState,
    id: i64,
    headers: HeaderMap,
    form: ArchiveForm,
    archived: bool,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ReviewPost)?;
    session::check_csrf(&actor, &form.csrf)?;
    let now = now_unix();
    if !repo::set_post_archived(state.db.pool(), id, archived, now).await? {
        return Ok(done(&headers, "已是最新状态", "/admin/users/overview"));
    }
    tracing::info!(post.id = id, archived, actor.id = actor.id, "归档变更");
    let (action, message) = if archived {
        ("post.archive", "已归档")
    } else {
        ("post.unarchive", "已取消归档")
    };
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        action,
        Some(&format!("post:{id}")),
        None,
        now,
    )
    .await;
    Ok(done(&headers, message, "/admin/users/overview"))
}
