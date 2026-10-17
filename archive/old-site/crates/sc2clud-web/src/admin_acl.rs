//! 分区发言权限：矩阵初值（JSON）与保存端点。
//!
//! 从 pages_admin.rs 拆出（那里超过体量门禁的 500 行；见 scripts/check-size.mjs）。

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use sc2clud_core::auth::Permission;
use sc2clud_core::now_unix;
use sc2clud_db::repo;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::pages_admin::SectionAclForm;
use crate::routes::require_user;
use crate::session;

/// 分区发言权限矩阵的初值（JSON）：分区角色门槛 + 档位 + 由用户组规则反推的生效组。
///
/// 组的规则形如 (分区 key, 允许发帖, 允许评论, 禁止发帖, 禁止评论)；这里只统计"允许发帖"，
/// 与后端白名单语义一致。
pub fn acl_json(
    sections: &[sc2clud_core::community::SectionRecord],
    groups: &[crate::templates::AdminGroupView],
) -> String {
    let rows: Vec<serde_json::Value> = sections
        .iter()
        .map(|section| {
            let group_ids: Vec<i64> = groups
                .iter()
                .filter(|group| {
                    group
                        .rules
                        .iter()
                        .any(|(key, can_post, ..)| key == &section.key && *can_post)
                })
                .map(|group| group.id)
                .collect();
            serde_json::json!({
                "value": section.key,
                "label": section.label,
                "post": section.post_min_role.as_str(),
                "reply": section.reply_min_role.as_str(),
                "mode": section.group_mode,
                "groupIds": group_ids,
            })
        })
        .collect();
    let group_list: Vec<serde_json::Value> = groups
        .iter()
        .filter(|group| !group.archived)
        .map(|group| serde_json::json!({ "id": group.id, "name": group.name }))
        .collect();
    serde_json::json!({
        "sections": rows,
        "groups": group_list,
        "roles": [
            { "value": "member", "label": "普通用户" },
            { "value": "developer", "label": "认证开发者" },
            { "value": "admin", "label": "管理员" },
            { "value": "super", "label": "超级管理员" },
        ],
    })
    .to_string()
}

/// 保存一个分区的发言权限：角色门槛 + 是否启用用户组检查 + 允许的组白名单。
/// 组白名单的语义是「允许发帖且允许评论」；不在名单里的组会被删掉规则（不留残余）。
pub async fn save_section_acl(
    State(state): State<AppState>,
    Path(section): Path<String>,
    headers: HeaderMap,
    axum::Json(form): axum::Json<SectionAclForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let current = repo::get_section(state.db.pool(), &section)
        .await?
        .ok_or_else(|| AppError::not_found("分区不存在"))?;
    let now = now_unix();
    // 角色门槛：复用 update_section（名称与说明原样传回，不改它们）
    repo::update_section(
        state.db.pool(),
        &current.key,
        &current.label,
        &current.description,
        &form.post_min_role,
        &form.reply_min_role,
        now,
    )
    .await?;
    // 档位：0 不启用 / 1 白名单 / 2 黑名单（前端目前是复选/下拉，值直接给数字）
    let group_mode = form
        .group_mode
        .as_deref()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0)
        .clamp(0, 2);
    repo::set_section_group_check(state.db.pool(), &section, group_mode, now).await?;
    let allowed: Vec<i64> = form
        .groups
        .split(',')
        .filter_map(|value| value.trim().parse::<i64>().ok())
        .collect();
    for group in repo::list_user_groups(state.db.pool(), true).await? {
        if allowed.contains(&group.id) {
            repo::set_group_section_rule_full(
                state.db.pool(),
                group.id,
                &section,
                true,
                true,
                false,
                false,
            )
            .await?;
        } else {
            repo::remove_group_section_rule(state.db.pool(), group.id, &section).await?;
        }
    }
    tracing::info!(
        section,
        post = form.post_min_role,
        reply = form.reply_min_role,
        groups = ?allowed,
        actor.id = actor.id,
        "保存分区发言权限"
    );
    Ok(axum::Json(serde_json::json!({ "ok": true })).into_response())
}
