//! 管理页的用户与角色域：用户编辑页 + 用户增改 / 角色 / 信任 / 激活 / 磁盘预算。
//!
//! 从 pages_admin.rs 拆出（该文件超出体量门禁的 500 行）。这一层只做
//! 「鉴权 → 解析表单 → 调 repo → 写审计 → 返回」；页面组装在 templates，权限层级在 core::auth。
//!
//! 权限：常规改动 = 网站管理员（ManageUsers）；开账号 / 任免等级 / 改显示名 = 超级管理员
//! （改等级另有 ManageRoles 一道）。

use axum::Form;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use sc2clud_core::auth::{
    Permission, Role, hash_password, validate_display_name, validate_handle, validate_password,
};
use sc2clud_core::{Error as DomainError, now_unix};
use sc2clud_db::repo;
use serde::Deserialize;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::pages_admin::{CsrfForm, done};
use crate::routes::{invalid, require_user};
use crate::session::{self, CurrentUser};
use crate::templates::{
    AdminUserEditTemplate, AdminUserView, format_date, format_relative, human_bytes, render,
};

#[derive(Debug, Deserialize)]
pub struct CreateUserForm {
    pub csrf: String,
    pub handle: String,
    pub display_name: String,
    pub password: String,
    pub role: Option<String>,
    pub activated: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EditUserForm {
    pub csrf: String,
    pub display_name: String,
    pub role: String,
    pub quota_gb: String,
    pub trusted: Option<String>,
    pub activated: Option<String>,
    pub new_password: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct TrustForm {
    pub csrf: String,
    pub trusted: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RoleForm {
    pub csrf: String,
    pub role: String,
}

#[derive(Debug, Deserialize)]
pub struct QuotaForm {
    pub csrf: String,
    pub quota_gb: String,
}

#[derive(Debug, Deserialize)]
pub struct RenameForm {
    pub csrf: String,
    pub display_name: String,
}

/// 编辑用户页（管理面板里点铅笔进来）：集中改显示名 / 等级 / 预算 / 信任 / 激活。
pub async fn user_edit(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    match build_user_edit(&state, id, &headers).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

pub async fn activate(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<CsrfForm>,
) -> AppResult<Response> {
    set_activation(state, id, headers, &form.csrf, true).await
}

pub async fn deactivate(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<CsrfForm>,
) -> AppResult<Response> {
    set_activation(state, id, headers, &form.csrf, false).await
}

/// 新建账号：只有超级管理员。
///
/// 密码用 argon2id 现算；邮箱自动给「<登录名>@local」（users.email 有唯一约束，一堆空串
/// 会撞在一起）。命中唯一约束时给一句人话，不暴露 SQL。
pub async fn create_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<CreateUserForm>,
) -> AppResult<Response> {
    let actor = guard(&state, &headers).await?;
    if actor.role != Role::Super {
        return Err(forbidden("只有超级管理员可以新建账号"));
    }
    session::check_csrf(&actor, &form.csrf)?;
    let handle = validate_handle(&form.handle)?;
    let display_name = validate_display_name(&form.display_name)?;
    validate_password(&form.password)?;
    let role = match form.role.as_deref() {
        Some(raw) if !raw.is_empty() => Role::parse(raw)?,
        _ => Role::Member,
    };
    let activated = flag(form.activated.as_deref());
    let now = now_unix();
    let user_id = match repo::register_user(
        state.db.pool(),
        repo::NewUser {
            handle: &handle,
            display_name: &display_name,
            email: &format!("{handle}@local"),
            password_hash: &hash_password(&form.password)?,
            activated,
            now,
        },
    )
    .await
    {
        Ok(id) => id,
        Err(e) if e.to_string().to_uppercase().contains("UNIQUE") => {
            return Err(invalid(format!("登录名「{handle}」已被占用")));
        }
        Err(_) => return Err(invalid("创建账号失败，请稍后再试")),
    };
    if role != Role::Member {
        repo::set_user_role(state.db.pool(), user_id, role.as_str()).await?;
    }
    audit(&state, actor.id, "user.create", user_id, role.as_str(), now).await;
    tracing::info!(user.id = user_id, %handle, role = role.as_str(), activated, actor.id = actor.id, "超级管理员新建账号");
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}

/// 管理面板「编辑用户」弹窗的保存：一次把资料改完（等级也就地切换）。
pub async fn update_user(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<EditUserForm>,
) -> AppResult<Response> {
    let actor = guard(&state, &headers).await?;
    session::check_csrf(&actor, &form.csrf)?;
    let Some(target) = repo::admin_get_user(state.db.pool(), id).await? else {
        return Err(AppError::not_found("没有这个用户"));
    };
    // 等级：空值 = 不改（前端在权限不足时压根不提交该字段）；改等级要 ManageRoles，且不能改自己
    let requested = form.role.trim();
    let role = if requested.is_empty() || requested == target.role {
        target.role.clone()
    } else {
        session::guard(Some(&actor), Permission::ManageRoles)?;
        if id == actor.id {
            return Err(forbidden("不能修改自己的权限等级"));
        }
        Role::parse(requested)?.as_str().to_string()
    };
    // 显示名没变就不算「改显示名」，否则管理员改不了别人的其它字段
    let display_name = if form.display_name.trim() == target.display_name {
        target.display_name.clone()
    } else {
        validate_display_name(form.display_name.trim())?
    };
    let quota_bytes = quota_bytes(&form.quota_gb, "预算要填数字")?;
    let trusted = flag(form.trusted.as_deref());
    let activated = id == actor.id || flag(form.activated.as_deref()); // 自己不能被停用
    let password_hash = match form.new_password.as_deref().map(str::trim) {
        Some(pw) if !pw.is_empty() => {
            validate_password(pw)?;
            Some(hash_password(pw)?)
        }
        _ => None,
    };
    let now = now_unix();
    repo::admin_update_user(
        state.db.pool(),
        repo::AdminUserUpdate {
            id,
            display_name: &display_name,
            role: &role,
            quota_bytes,
            trusted,
            activated,
            password_hash: password_hash.as_deref(),
        },
    )
    .await?;
    if password_hash.is_some() {
        // 改了密码就把该用户的会话全踢掉
        let _ = repo::delete_user_sessions(state.db.pool(), id).await;
    }
    tracing::info!(user.id = id, actor.id = actor.id, %role, "管理端更新用户");
    let detail = format!("role={role} trusted={trusted} activated={activated}");
    audit(&state, actor.id, "user.update", id, &detail, now).await;
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}

/// 设置「信任」：被信任的账号发帖只走自动审核。
pub async fn set_trusted(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<TrustForm>,
) -> AppResult<Response> {
    let actor = guard(&state, &headers).await?;
    session::check_csrf(&actor, &form.csrf)?;
    let trusted = flag(form.trusted.as_deref());
    if repo::set_user_trusted(state.db.pool(), id, trusted).await? {
        tracing::info!(user.id = id, trusted, actor.id = actor.id, "设置信任标记");
        let detail = if trusted { "1" } else { "0" };
        audit(&state, actor.id, "user.set_trusted", id, detail, now_unix()).await;
    }
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}

pub async fn set_role(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<RoleForm>,
) -> AppResult<Response> {
    let actor = guard(&state, &headers).await?;
    if actor.role != Role::Super {
        return Err(forbidden("只有超级管理员可以修改权限等级"));
    }
    session::check_csrf(&actor, &form.csrf)?;
    if id == actor.id {
        return Err(forbidden("不能修改自己的权限等级"));
    }
    let role = Role::parse(&form.role)?;
    if repo::set_user_role(state.db.pool(), id, role.as_str()).await? {
        tracing::info!(
            user.id = id,
            role = role.as_str(),
            actor.id = actor.id,
            "管理员变更角色"
        );
        audit(
            &state,
            actor.id,
            "user.set_role",
            id,
            role.as_str(),
            now_unix(),
        )
        .await;
    }
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}

/// 分配磁盘预算：管理员即可。0 = 不分配。
pub async fn set_quota(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<QuotaForm>,
) -> AppResult<Response> {
    let actor = guard(&state, &headers).await?;
    session::check_csrf(&actor, &form.csrf)?;
    let bytes = quota_bytes(&form.quota_gb, "预算要填数字（单位 GB）")?;
    let now = now_unix();
    if repo::set_user_quota(state.db.pool(), id, bytes).await? {
        tracing::info!(
            user.id = id,
            quota_bytes = bytes,
            actor.id = actor.id,
            "管理员分配磁盘预算"
        );
        let detail = format!("{:.1} GB", bytes as f64 / GIB);
        audit(&state, actor.id, "user.set_quota", id, &detail, now).await;
    }
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}

pub async fn rename(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<RenameForm>,
) -> AppResult<Response> {
    let actor = guard(&state, &headers).await?;
    if actor.role != Role::Super {
        return Err(forbidden("只有超级管理员可以修改用户显示名"));
    }
    session::check_csrf(&actor, &form.csrf)?;
    let display_name = validate_display_name(&form.display_name)?;
    if repo::set_display_name(state.db.pool(), id, &display_name).await? {
        tracing::info!(user.id = id, %display_name, actor.id = actor.id, "管理员改显示名");
        audit(
            &state,
            actor.id,
            "user.rename",
            id,
            &display_name,
            now_unix(),
        )
        .await;
    }
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}

pub async fn toggle_activation_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<CsrfForm>,
) -> AppResult<Response> {
    let actor = guard(&state, &headers).await?;
    session::check_csrf(&actor, &form.csrf)?;
    let next = !repo::registration_requires_activation(state.db.pool()).await?;
    let value = if next { "1" } else { "0" };
    repo::set_setting(
        state.db.pool(),
        repo::SETTING_REQUIRE_ACTIVATION,
        value,
        Some(actor.id),
        now_unix(),
    )
    .await?;
    // 审计的 target 是设置项而不是用户，所以不走 audit()
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        "settings.require_activation",
        Some(repo::SETTING_REQUIRE_ACTIVATION),
        Some(value),
        now_unix(),
    )
    .await;
    tracing::info!(
        actor.id = actor.id,
        require_activation = next,
        "切换注册策略"
    );
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}

async fn build_user_edit<'a>(
    state: &'a AppState,
    id: i64,
    headers: &HeaderMap,
) -> AppResult<AdminUserEditTemplate<'a>> {
    let actor = guard(state, headers).await?;
    let row = repo::admin_get_user(state.db.pool(), id)
        .await?
        .ok_or_else(|| AppError::not_found("没有这个用户"))?;
    let now = now_unix();
    Ok(AdminUserEditTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(actor.display_name.clone()),
        is_staff: true,
        csrf: actor.csrf_token.clone(),
        is_super: actor.role == Role::Super,
        roles: Role::ALL
            .iter()
            .map(|r| (r.as_str().to_string(), r.label().to_string()))
            .collect(),
        // 本页只有这一张用户卡，列表页的禁言/用户组/首字母等字段模板里没引用
        user: AdminUserView {
            ban_label: String::new(),
            sanctions: String::new(),
            groups: Vec::new(),
            id: row.id,
            trusted: row.trusted != 0,
            initial: row
                .display_name
                .chars()
                .next()
                .map(|c| c.to_uppercase().to_string())
                .unwrap_or_else(|| "?".to_string()),
            color_index: row.id % 6,
            online: row
                .last_seen_at
                .is_some_and(|ts| now.saturating_sub(ts) < 300),
            email: row.email.clone().unwrap_or_default(),
            quota_human: human_bytes(row.quota_bytes.max(0) as u64),
            quota_gb: format!("{:.1}", row.quota_bytes.max(0) as f64 / GIB),
            used_human: human_bytes(row.used_bytes.max(0) as u64),
            last_seen: row
                .last_seen_at
                .map(|ts| format_relative(ts, now))
                .unwrap_or_else(|| "从未登录".to_string()),
            created_from_now: format_relative(row.created_at, now),
            handle: row.handle,
            display_name: row.display_name,
            role_label: Role::parse(&row.role)
                .map(|r| r.label().to_string())
                .unwrap_or_else(|_| row.role.clone()),
            role: row.role,
            activated: row.activated_at.is_some(),
            created_at: format_date(row.created_at),
            is_self: row.id == actor.id,
            avatar: row.avatar_hash.clone(),
        },
    })
}

/// 1 GiB：预算以 GB 填、以字节存；上限与提示文案里的 10240 是同一个数。
const GIB: f64 = 1_073_741_824.0;
const MAX_QUOTA_GB: f64 = 10_240.0;

/// 当前管理员；ManageUsers 是本域所有端点的共同门槛。
async fn guard(state: &AppState, headers: &HeaderMap) -> AppResult<CurrentUser> {
    let actor = require_user(state, headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    Ok(actor)
}

/// 激活 / 停用。改自己会把管理员自己锁在门外，直接拒绝。
async fn set_activation(
    state: AppState,
    id: i64,
    headers: HeaderMap,
    csrf: &str,
    activate: bool,
) -> AppResult<Response> {
    let actor = guard(&state, &headers).await?;
    session::check_csrf(&actor, csrf)?;
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
        let action = if activate {
            "user.activate"
        } else {
            "user.deactivate"
        };
        let _ = repo::record_audit(
            state.db.pool(),
            Some(actor.id),
            action,
            Some(&format!("user:{id}")),
            None,
            now,
        )
        .await;
    }
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}

/// 用户域的审计（target 统一 user:{id}）；审计失败不挡业务。
async fn audit(state: &AppState, actor_id: i64, action: &str, id: i64, detail: &str, now: i64) {
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor_id),
        action,
        Some(&format!("user:{id}")),
        Some(detail),
        now,
    )
    .await;
}

/// 表单里的复选框：勾了是 "1"（也兼容 "on"），没勾则没有这个字段。
fn flag(value: Option<&str>) -> bool {
    matches!(value, Some("1") | Some("on"))
}

/// GB 文本 → 字节；数字提示语由调用方给（两个端点的文案本来就不同）。
fn quota_bytes(raw: &str, bad_number: &str) -> AppResult<i64> {
    let gb: f64 = raw.trim().parse().map_err(|_| invalid(bad_number))?;
    if !(0.0..=MAX_QUOTA_GB).contains(&gb) {
        return Err(invalid("预算范围是 0 ~ 10240 GB"));
    }
    Ok((gb * GIB).round() as i64)
}

fn forbidden(msg: &str) -> AppError {
    AppError::Domain(DomainError::Forbidden(msg.to_string()))
}
