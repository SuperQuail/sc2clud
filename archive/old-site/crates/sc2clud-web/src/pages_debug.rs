//! 调试页：开发自检面板。
//!
//! **默认关闭**（`server.debug_pages = false`，关闭时路由根本不存在）。
//! 打开也只在回环监听时被 `config.validate` 接受——所以它不可能被公网直接访问到。
//! 面板是只读的：表计数、存储余量、最近审计、配置摘要（**不含任何密钥**）。

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;

use sc2clud_core::auth::Permission;
use sc2clud_db::repo;

use crate::AppState;
use crate::error::AppResult;
use crate::routes::require_user;
use crate::session;
use crate::templates::{DebugAuditView, DebugTemplate, format_date, render};

pub async fn page(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match build(&state, &headers).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

async fn build<'a>(state: &'a AppState, headers: &HeaderMap) -> AppResult<DebugTemplate<'a>> {
    // 只有管理员能看；再叠加「开关打开」这一层（路由层已经拦过一次）。
    let user = require_user(state, headers).await?;
    session::guard(Some(&user), Permission::ManageUsers)?;

    let pool = state.db.pool();
    let free_bytes = state.storage.available_bytes().await.unwrap_or(0);
    let storage_ok = state.storage.health().await.is_ok();
    let audit = repo::recent_audit(pool, 20).await.unwrap_or_default();

    Ok(DebugTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        is_staff: true,
        csrf: user.csrf_token.clone(),
        version: env!("CARGO_PKG_VERSION"),
        bind: state.config.server.bind.clone(),
        data_dir: state.config.paths.data_dir.display().to_string(),
        download_mode: format!("{:?}", state.config.download.mode),
        free_human: crate::templates::human_bytes(free_bytes),
        min_free_human: crate::templates::human_bytes(state.config.limits.min_free_bytes),
        storage_ok,
        users: repo::count_users(pool).await.unwrap_or(0),
        posts: repo::count_posts(pool).await.unwrap_or(0),
        comments: repo::count_comments(pool).await.unwrap_or(0),
        pending_images: repo::pending_image_jobs(pool).await.unwrap_or(0),
        audit: audit
            .into_iter()
            .map(|row| DebugAuditView {
                created_at: format_date(row.created_at),
                action: row.action,
                target: row.target.unwrap_or_default(),
                detail: row.detail.unwrap_or_default(),
            })
            .collect(),
    })
}
