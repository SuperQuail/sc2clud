//! 管理员面板：用户管理、激活、权限等级、显示名、注册策略。
//!
//! 权限分层：查看面板 / 激活·停用 / 切换注册策略 = 网站管理员；
//! 修改权限等级、改显示名 = 超级管理员。所有动作过 CSRF 并写审计日志。

use axum::Form;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{Redirect, Response};
use serde::Deserialize;

use sc2clud_core::auth::{Permission, Role};
use sc2clud_core::{Error as DomainError, now_unix};
use sc2clud_db::repo;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::routes::require_user;
use crate::session;
use crate::templates::{AdminTemplate, AdminUserView, format_date, render};

#[derive(Debug, Deserialize)]
pub struct CsrfForm {
    pub csrf: String,
}

#[derive(Debug, Deserialize)]
pub struct RoleForm {
    pub csrf: String,
    pub role: String,
}

#[derive(Debug, Deserialize)]
pub struct RenameForm {
    pub csrf: String,
    pub display_name: String,
}

fn forbidden(msg: &str) -> AppError {
    AppError::Domain(DomainError::Forbidden(msg.to_string()))
}

async fn build_panel<'a>(state: &'a AppState, headers: &HeaderMap) -> AppResult<AdminTemplate<'a>> {
    let user = require_user(state, headers).await?;
    session::guard(Some(&user), Permission::ManageUsers)?;
    let rows = repo::list_users(state.db.pool(), 200, 0).await?;
    let users = rows
        .into_iter()
        .map(|row| AdminUserView {
            id: row.id,
            avatar: row.avatar_hash.clone(),
            handle: row.handle,
            display_name: row.display_name,
            role_label: Role::parse(&row.role)
                .map(|r| r.label().to_string())
                .unwrap_or_else(|_| row.role.clone()),
            role: row.role,
            activated: row.activated_at.is_some(),
            created_at: format_date(row.created_at),
            is_self: row.id == user.id,
        })
        .collect();
    Ok(AdminTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        is_staff: true,
        csrf: user.csrf_token.clone(),
        is_super: user.role == Role::Super,
        require_activation: repo::registration_requires_activation(state.db.pool()).await?,
        roles: Role::ALL
            .iter()
            .map(|r| (r.as_str().to_string(), r.label().to_string()))
            .collect(),
        users,
    })
}

pub async fn panel(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match build_panel(&state, &headers).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

pub async fn activate(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<CsrfForm>,
) -> AppResult<Redirect> {
    change_activation(state, id, headers, form, true).await
}

pub async fn deactivate(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<CsrfForm>,
) -> AppResult<Redirect> {
    change_activation(state, id, headers, form, false).await
}

async fn change_activation(
    state: AppState,
    id: i64,
    headers: HeaderMap,
    form: CsrfForm,
    activate: bool,
) -> AppResult<Redirect> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    if id == actor.id {
        return Err(forbidden("不能改动自己的激活状态"));
    }
    let now = now_unix();
    if repo::set_user_activated(state.db.pool(), id, activate, actor.id, now).await? {
        tracing::info!(
            user.id = id,
            activate,
            actor.id = actor.id,
            "管理员变更激活状态"
        );
        let _ = repo::record_audit(
            state.db.pool(),
            Some(actor.id),
            if activate {
                "user.activate"
            } else {
                "user.deactivate"
            },
            Some(&format!("user:{id}")),
            None,
            now,
        )
        .await;
    }
    Ok(Redirect::to("/admin"))
}

#[derive(Debug, Deserialize)]
pub struct CreateUserForm {
    pub csrf: String,
    pub handle: String,
    pub display_name: String,
    pub password: String,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub activated: Option<String>,
}

/// 新建账号：只有超级管理员。
///
/// 口令用 argon2id 现算；邮箱自动给 `<登录名>@local`（users.email 有唯一约束，
/// 不能一堆空串撞在一起）。命中唯一约束时给一句人话，不暴露 SQL。
pub async fn create_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<CreateUserForm>,
) -> AppResult<Redirect> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    if actor.role != Role::Super {
        return Err(forbidden("只有超级管理员可以新建账号"));
    }
    session::check_csrf(&actor, &form.csrf)?;

    let handle = sc2clud_core::auth::validate_handle(&form.handle)?;
    let display_name = sc2clud_core::auth::validate_display_name(&form.display_name)?;
    let password = form.password.clone();
    sc2clud_core::auth::validate_password(&password)?;
    let role = match form.role.as_deref() {
        Some(raw) if !raw.is_empty() => Role::parse(raw)?,
        _ => Role::Member,
    };
    let activated = matches!(form.activated.as_deref(), Some("1") | Some("on"));
    let email = format!("{handle}@local");
    let hash = sc2clud_core::auth::hash_password(&password)?;
    let now = now_unix();

    let user_id = match repo::register_user(
        state.db.pool(),
        repo::NewUser {
            handle: &handle,
            display_name: &display_name,
            email: &email,
            password_hash: &hash,
            activated,
            now,
        },
    )
    .await
    {
        Ok(id) => id,
        Err(e) => {
            let text = e.to_string().to_uppercase();
            return Err(AppError::Domain(DomainError::InvalidInput(
                if text.contains("UNIQUE") {
                    format!("登录名「{handle}」已被占用")
                } else {
                    "创建账号失败，请稍后再试".to_string()
                },
            )));
        }
    };
    if role != Role::Member {
        repo::set_user_role(state.db.pool(), user_id, role.as_str()).await?;
    }
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        "user.create",
        Some(&format!("user:{user_id}")),
        Some(role.as_str()),
        now,
    )
    .await;
    tracing::info!(
        user.id = user_id,
        %handle,
        role = role.as_str(),
        activated,
        actor.id = actor.id,
        "超级管理员新建账号"
    );
    Ok(Redirect::to("/admin"))
}
pub async fn set_role(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<RoleForm>,
) -> AppResult<Redirect> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    if actor.role != Role::Super {
        return Err(forbidden("只有超级管理员可以修改权限等级"));
    }
    session::check_csrf(&actor, &form.csrf)?;
    if id == actor.id {
        return Err(forbidden("不能修改自己的权限等级"));
    }
    let role = Role::parse(&form.role)?;
    let now = now_unix();
    if repo::set_user_role(state.db.pool(), id, role.as_str()).await? {
        tracing::info!(
            user.id = id,
            role = role.as_str(),
            actor.id = actor.id,
            "管理员变更角色"
        );
        let _ = repo::record_audit(
            state.db.pool(),
            Some(actor.id),
            "user.set_role",
            Some(&format!("user:{id}")),
            Some(role.as_str()),
            now,
        )
        .await;
    }
    Ok(Redirect::to("/admin"))
}

pub async fn rename(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<RenameForm>,
) -> AppResult<Redirect> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    if actor.role != Role::Super {
        return Err(forbidden("只有超级管理员可以修改用户显示名"));
    }
    session::check_csrf(&actor, &form.csrf)?;
    let display_name = sc2clud_core::auth::validate_display_name(&form.display_name)?;
    let now = now_unix();
    if repo::set_display_name(state.db.pool(), id, &display_name).await? {
        tracing::info!(user.id = id, %display_name, actor.id = actor.id, "管理员改显示名");
        let _ = repo::record_audit(
            state.db.pool(),
            Some(actor.id),
            "user.rename",
            Some(&format!("user:{id}")),
            Some(&display_name),
            now,
        )
        .await;
    }
    Ok(Redirect::to("/admin"))
}

pub async fn toggle_activation_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<CsrfForm>,
) -> AppResult<Redirect> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let next = !repo::registration_requires_activation(state.db.pool()).await?;
    let now = now_unix();
    repo::set_setting(
        state.db.pool(),
        repo::SETTING_REQUIRE_ACTIVATION,
        if next { "1" } else { "0" },
        Some(actor.id),
        now,
    )
    .await?;
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        "settings.require_activation",
        Some(repo::SETTING_REQUIRE_ACTIVATION),
        Some(if next { "1" } else { "0" }),
        now,
    )
    .await;
    tracing::info!(
        actor.id = actor.id,
        require_activation = next,
        "切换注册策略"
    );
    Ok(Redirect::to("/admin"))
}
