//! 管理页的头衔域：用户列表 JSON（含每个用户持有的头衔）+ 弹窗里的发放 / 收回端点。
//!
//! 列表 JSON 放这里而不是 pages_admin.rs，是因为它要带每个用户的 `titleIds`：
//! 用 `held_title_ids_for` 一次批量取，不给 200 个用户各查一次，也不各带一份目录。
//!
//! 从 admin_users.rs 拆出：那边要守 500 行的体量门禁，而头衔是独立的一块
//! （目录来自 titles 表、持有关系来自 user_titles，与用户资料的增改无关）。

use axum::Form;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use sc2clud_core::auth::Permission;
use sc2clud_core::now_unix;
use sc2clud_db::models::TitleRow;
use sc2clud_db::repo;
use serde::Deserialize;

use crate::AppState;
use crate::admin_users::guard;
use crate::error::{AppError, AppResult};
use crate::routes::invalid;
use crate::session;
use crate::templates::{AdminGroupView, AdminUserView, SectionOption};

/// 弹窗里的「头衔」区：目录 + 该用户已持有的 id。
/// 归档头衔也带上（已持有的仍要能收回），但标记 `archived` 让界面禁用「发放」。
pub async fn user_titles(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let actor = guard(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    Ok(Json(titles_view(&state, id).await?).into_response())
}

/// 发放 / 收回头衔。返回最新持有集合，界面就地更新（不整页刷新）。
pub async fn set_user_title(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<UserTitleForm>,
) -> AppResult<Response> {
    let actor = guard(&state, &headers).await?;
    session::check_csrf(&actor, &form.csrf)?;
    if repo::find_user_by_id(state.db.pool(), id).await?.is_none() {
        return Err(AppError::not_found("用户不存在"));
    }
    let title = repo::list_titles(state.db.pool(), true)
        .await?
        .into_iter()
        .find(|t| t.id == form.title_id)
        .ok_or_else(|| invalid("头衔不存在"))?;
    let revoke = form.action == "revoke";
    let message = if revoke {
        repo::revoke_title(state.db.pool(), id, title.id).await?;
        "已收回头衔"
    } else if title.archived_at.is_some() {
        return Err(invalid("这个头衔已归档，不能再发放"));
    } else if repo::grant_title(state.db.pool(), id, title.id, Some(actor.id), now_unix()).await? {
        "已发放头衔"
    } else {
        "该用户已持有这个头衔"
    };
    tracing::info!(
        user.id = id,
        title.id = title.id,
        title.name = %title.name,
        revoke,
        actor.id = actor.id,
        "管理端改头衔"
    );
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        if revoke {
            "user.title_revoke"
        } else {
            "user.title_grant"
        },
        Some(&format!("user:{id}")),
        Some(&title.name),
        now_unix(),
    )
    .await;
    let mut body = titles_view(&state, id).await?;
    body["message"] = serde_json::json!(message);
    Ok(Json(body).into_response())
}

async fn titles_view(state: &AppState, id: i64) -> AppResult<serde_json::Value> {
    let titles = repo::list_titles(state.db.pool(), true).await?;
    let held: Vec<i64> = repo::list_user_titles(state.db.pool(), id)
        .await?
        .into_iter()
        .map(|t| t.title_id)
        .collect();
    Ok(serde_json::json!({ "titles": titles_json(&titles), "held": held }))
}

/// 一行头衔 → JSON（面板要 key，弹窗不需要）。
pub(crate) fn title_json(t: &TitleRow) -> serde_json::Value {
    serde_json::json!({
        "id": t.id,
        "key": t.key,
        "name": t.name,
        "color": t.color,
        "description": t.description,
        "archived": t.archived_at.is_some(),
    })
}

/// 弹窗里的头衔列表：不带 key（界面用不到）。
fn titles_json(titles: &[TitleRow]) -> Vec<serde_json::Value> {
    titles
        .iter()
        .map(|t| {
            serde_json::json!({
                "id": t.id,
                "name": t.name,
                "color": t.color,
                "description": t.description,
                "archived": t.archived_at.is_some(),
            })
        })
        .collect()
}

#[derive(Debug, Deserialize)]
pub struct UserTitleForm {
    pub csrf: String,
    pub title_id: i64,
    /// grant | revoke
    #[serde(default)]
    pub action: String,
}

/// 管理面板的用户列表 JSON（模板只留挂载点，行数据在 Rust 侧一次序列化）。
/// `held_titles` 是「用户 id → 持有的头衔 id」，列表要就地显示已持有徽章。
pub(crate) fn users_json(
    users: &[AdminUserView],
    roles: &[(String, String)],
    groups: &[AdminGroupView],
    sections: &[SectionOption],
    ban_options: &[(String, String)],
    held_titles: &[(i64, Vec<i64>)],
    titles: &[TitleRow],
) -> String {
    let pairs = |rows: &[(String, String)]| {
        rows.iter()
            .map(|(value, label)| serde_json::json!({ "value": value, "label": label }))
            .collect::<Vec<_>>()
    };
    let title_ids = |id: i64| {
        held_titles
            .iter()
            .find(|(uid, _)| *uid == id)
            .map(|(_, ids)| ids.clone())
            .unwrap_or_default()
    };
    serde_json::json!({
        "users": users
            .iter()
            .map(|u| serde_json::json!({
                "id": u.id,
                "handle": u.handle,
                "displayName": u.display_name,
                "initial": u.initial,
                "colorIndex": u.color_index,
                "avatar": u.avatar,
                "activated": u.activated,
                "online": u.online,
                "trusted": u.trusted,
                "banLabel": u.ban_label,
                "isSelf": u.is_self,
                "role": u.role,
                "roleLabel": u.role_label,
                "email": u.email,
                "quotaGb": u.quota_gb,
                "lastSeen": u.last_seen,
                "createdAt": u.created_at,
                "sanctions": u.sanctions,
                "groups": u.groups,
                "titleIds": title_ids(u.id),
            }))
            .collect::<Vec<_>>(),
        "roles": pairs(roles),
        "groups": groups
            .iter()
            .map(|g| serde_json::json!({ "id": g.id, "name": g.name }))
            .collect::<Vec<_>>(),
        "sections": sections
            .iter()
            .map(|s| serde_json::json!({ "value": s.value, "label": s.label }))
            .collect::<Vec<_>>(),
        "banOptions": pairs(ban_options),
        "titles": titles_json(titles),
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn title(id: i64, name: &str, color: &str, archived: bool) -> TitleRow {
        TitleRow {
            id,
            key: name.to_lowercase(),
            name: name.to_string(),
            color: color.to_string(),
            description: format!("{name} 的说明"),
            archived_at: archived.then_some(1),
        }
    }

    /// 归档头衔必须带 archived=true：界面据此禁掉「发放」，但仍要能收回。
    #[test]
    fn titles_json_marks_archived() {
        let rows = [
            title(1, "老兵", "#f97316", false),
            title(2, "元老", "#2563eb", true),
        ];
        let json = titles_json(&rows);
        assert_eq!(json.len(), 2);
        assert_eq!(json[0]["name"], "老兵");
        assert_eq!(json[0]["color"], "#f97316");
        assert_eq!(json[0]["archived"], false);
        assert_eq!(json[1]["archived"], true);
    }
}
