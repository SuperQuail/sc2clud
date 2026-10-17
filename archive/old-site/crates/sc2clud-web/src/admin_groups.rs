//! 管理页的用户组：新建、改名、归档/恢复，以及「某用户属于哪些组」的设置。
//!
//! 从 pages_admin.rs 拆出（该文件超出体量门禁的 500 行）。这一层只做
//! 「解析表单 → 校验 → 调 repo → 回跳转或 JSON」；组列表的读取与规则判定不在
//! 这里：面板视图在 pages_admin，组 × 分区规则在 admin_acl。

use axum::Form;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use sc2clud_core::Error as DomainError;
use sc2clud_core::auth::Permission;
use sc2clud_core::now_unix;
use sc2clud_db::repo;
use serde::Deserialize;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::pages_admin::done;
use crate::routes::require_user;
use crate::session;

#[derive(Debug, Deserialize)]
pub struct GroupCreateForm {
    pub csrf: String,
    /// 英文标识：规则与代码引用它，建成后不可改。
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Deserialize)]
pub struct GroupUpdateForm {
    pub csrf: String,
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Deserialize)]
pub struct GroupArchiveForm {
    pub csrf: String,
    pub id: i64,
    /// "1" 归档 / "0" 恢复。
    pub archived: String,
}

#[derive(Debug, Deserialize)]
pub struct UserGroupsForm {
    pub csrf: String,
    /// 勾选的用户组 id（可多个；重复字段由 serde 收成 Vec）。
    #[serde(default)]
    pub groups: Vec<i64>,
}

/// 新建用户组。
///
/// 仓储用 INSERT OR IGNORE 并在冲突时回查 id：这里拿不到「是否新建」，所以标识
/// 重复时按「已保存」提示并复用已有组 —— 文案必须跟着这条语义走。
pub async fn create_group(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<GroupCreateForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let key = form.key.trim().to_lowercase();
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(AppError::Domain(DomainError::InvalidInput(
            "标识只能用英文字母、数字与下划线".to_string(),
        )));
    }
    let name = required_name(&form.name)?;
    repo::create_user_group(
        state.db.pool(),
        &key,
        name,
        form.description.trim(),
        now_unix(),
    )
    .await?;
    tracing::info!(group.key = %key, actor.id = actor.id, "新建用户组");
    Ok(done(
        &headers,
        "用户组已保存（标识重复时会复用已有组）",
        "/admin/users/overview#groups",
    ))
}

/// 改用户组的名称与说明（key 是规则与代码引用的锚，不在这里改）。
pub async fn update_group(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<GroupUpdateForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let name = required_name(&form.name)?;
    let updated =
        repo::update_user_group(state.db.pool(), form.id, name, form.description.trim()).await?;
    tracing::info!(group.id = form.id, actor.id = actor.id, "编辑用户组");
    Ok(done(
        &headers,
        if updated {
            "用户组已更新"
        } else {
            "用户组不存在"
        },
        "/admin/users/overview#groups",
    ))
}

/// 归档 / 恢复用户组。归档而不是物理删除：成员与规则都留着，误删可恢复。
pub async fn archive_group(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<GroupArchiveForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let archived = form.archived == "1";
    let changed =
        repo::set_user_group_archived(state.db.pool(), form.id, archived, now_unix()).await?;
    tracing::info!(
        group.id = form.id,
        archived,
        actor.id = actor.id,
        "归档/恢复用户组"
    );
    Ok(done(
        &headers,
        if !changed {
            "用户组不存在"
        } else if archived {
            "用户组已归档"
        } else {
            "用户组已恢复"
        },
        "/admin/users/overview#groups",
    ))
}

/// 设置某个用户所属的用户组（先算差集，再增删，不动其它组）。
pub async fn set_user_groups(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<UserGroupsForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let pool = state.db.pool();
    let current: Vec<i64> = repo::list_user_groups_for(pool, id)
        .await?
        .into_iter()
        .map(|group| group.id)
        .collect();
    let now = now_unix();
    for group_id in form
        .groups
        .iter()
        .filter(|picked| !current.contains(picked))
    {
        repo::add_group_member(pool, *group_id, id, now).await?;
    }
    for group_id in current.iter().filter(|held| !form.groups.contains(held)) {
        repo::remove_group_member(pool, *group_id, id).await?;
    }
    tracing::info!(user.id = id, actor.id = actor.id, groups = ?form.groups, "设置用户组");
    Ok(done(
        &headers,
        "用户组已更新",
        "/admin/users/overview#users",
    ))
}

/// 组名必填：去空白后为空就报错（新建与改名共用这条校验）。
///
/// 复用 pages_admin 的私有 invalid() 需要把它改成 pub(crate)；本轮不动别的文件，
/// 所以这里按原码写法直接构造错误。
fn required_name(raw: &str) -> AppResult<&str> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(AppError::Domain(DomainError::InvalidInput(
            "组名不能为空".to_string(),
        )));
    }
    Ok(name)
}
