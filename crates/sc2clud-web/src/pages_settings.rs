//! 账户设置：基本资料、账号安全、变动日志。
//!
//! 形态参考常见的云服务控制台：左侧分栏 + 右侧内容。
//! 头像的裁剪与压缩在浏览器里做（前端岛），这里只负责改显示名与改密码。

use axum::Form;
use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{Redirect, Response};
use serde::Deserialize;

use sc2clud_core::auth::Role;
use sc2clud_core::auth::{
    hash_password, validate_display_name, validate_password, verify_password,
};
use sc2clud_core::now_unix;
use sc2clud_db::repo;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::routes::require_user;
use crate::session;
use crate::templates::{DebugAuditView, SettingsTemplate, format_date, render};

#[derive(Debug, Deserialize)]
pub struct DisplayNameForm {
    pub csrf: String,
    pub display_name: String,
}

#[derive(Debug, Deserialize)]
pub struct PasswordForm {
    pub csrf: String,
    pub current: String,
    pub new_password: String,
    pub confirm: String,
}

#[derive(Debug, Deserialize)]
pub struct NoticeQuery {
    #[serde(default)]
    pub ok: Option<String>,
    #[serde(default)]
    pub err: Option<String>,
}

fn notice_of(query: &NoticeQuery) -> (Option<String>, Option<String>) {
    let ok = match query.ok.as_deref() {
        Some("display") => Some("显示名已更新".to_string()),
        Some("password") => Some("密码已更新".to_string()),
        _ => None,
    };
    let err = match query.err.as_deref() {
        Some("current") => Some("当前密码不正确".to_string()),
        Some("confirm") => Some("两次输入的新密码不一致".to_string()),
        Some("weak") => Some("新密码不符合要求（至少 8 位）".to_string()),
        _ => None,
    };
    (ok, err)
}

pub async fn page(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<NoticeQuery>,
) -> Response {
    match build(&state, &headers, query).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

async fn build<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
    query: NoticeQuery,
) -> AppResult<SettingsTemplate<'a>> {
    let user = require_user(state, headers).await?;
    let row = repo::find_user_by_handle(state.db.pool(), &user.handle)
        .await?
        .ok_or_else(|| AppError::not_found("账号不存在"))?;
    let audit = repo::list_user_audit(state.db.pool(), user.id, 20)
        .await?
        .into_iter()
        .map(|row| DebugAuditView {
            created_at: format_date(row.created_at),
            action: row.action,
            target: row.target.unwrap_or_default(),
            detail: row.detail.unwrap_or_default(),
        })
        .collect();
    let blocks = repo::list_blocks(state.db.pool(), user.id)
        .await?
        .into_iter()
        .map(|row| crate::templates::BlockView {
            handle: row.handle,
            display_name: row.display_name,
            avatar: row.avatar_hash,
            when: format_date(row.created_at),
        })
        .collect();
    let (notice, error) = notice_of(&query);
    Ok(SettingsTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        is_staff: user.is_staff(),
        csrf: user.csrf_token.clone(),
        handle: row.handle.clone(),
        display_name: if row.display_name.trim().is_empty() {
            row.handle.clone()
        } else {
            row.display_name.clone()
        },
        role_label: Role::parse(&row.role)
            .map(|r| r.label().to_string())
            .unwrap_or_else(|_| row.role.clone()),
        avatar: row.avatar_hash.clone(),
        joined_at: format_date(row.created_at),
        audit,
        blocks,
        notice,
        error,
    })
}

pub async fn update_display_name(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<DisplayNameForm>,
) -> AppResult<Redirect> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), sc2clud_core::auth::Permission::SetAvatar)?;
    session::check_csrf(&user, &form.csrf)?;
    let display_name = validate_display_name(&form.display_name)?;
    let now = now_unix();
    if repo::set_display_name(state.db.pool(), user.id, &display_name).await? {
        tracing::info!(user.id = user.id, %display_name, "用户改显示名");
        let _ = repo::record_audit(
            state.db.pool(),
            Some(user.id),
            "user.rename_self",
            Some(&format!("user:{}", user.id)),
            Some(&display_name),
            now,
        )
        .await;
    }
    Ok(Redirect::to("/settings?ok=display"))
}

pub async fn update_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<PasswordForm>,
) -> AppResult<Redirect> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), sc2clud_core::auth::Permission::SetAvatar)?;
    session::check_csrf(&user, &form.csrf)?;

    let row = repo::find_user_by_handle(state.db.pool(), &user.handle)
        .await?
        .ok_or_else(|| AppError::not_found("账号不存在"))?;
    if !verify_password(&form.current, &row.password_hash) {
        return Ok(Redirect::to("/settings?err=current"));
    }
    if form.new_password != form.confirm {
        return Ok(Redirect::to("/settings?err=confirm"));
    }
    if validate_password(&form.new_password).is_err() {
        return Ok(Redirect::to("/settings?err=weak"));
    }
    let hash = hash_password(&form.new_password)?;
    repo::set_user_password(state.db.pool(), user.id, &hash).await?;
    let now = now_unix();
    let _ = repo::record_audit(
        state.db.pool(),
        Some(user.id),
        "user.change_password",
        Some(&format!("user:{}", user.id)),
        None,
        now,
    )
    .await;
    tracing::info!(user.id = user.id, "用户改密码");
    Ok(Redirect::to("/settings?ok=password"))
}
