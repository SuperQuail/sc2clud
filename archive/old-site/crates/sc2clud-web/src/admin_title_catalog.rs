//! 头衔目录管理：新建 / 改名·配色·描述 / 归档（与「给用户发头衔」分开成两块）。
//!
//! 从 admin_titles.rs 拆出：那边是「谁持有什么」，这边是「目录本身有什么」，
//! 两者共用 title_json / 标题目录序列化，风格与其它管理域一致（ManageUsers + CSRF + 审计）。

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
use crate::admin_titles::title_json;
use crate::admin_users::guard;
use crate::error::{AppError, AppResult};
use crate::routes::invalid;
use crate::session;

/// 管理面板的头衔目录 JSON（含持有者数）：模板只留挂载点，数据在 Rust 侧一次序列化。
pub(crate) fn titles_catalog_json(
    titles: &[TitleRow],
    counts: &std::collections::HashMap<i64, i64>,
) -> String {
    let rows = titles
        .iter()
        .map(|t| {
            let mut row = title_json(t);
            row["holders"] = serde_json::json!(counts.get(&t.id).copied().unwrap_or(0));
            row
        })
        .collect::<Vec<_>>();
    serde_json::json!({ "titles": rows }).to_string()
}

/// 目录 CRUD 的返回体：整表（含持有者数）交给控件就地重绘。
async fn titles_state(state: &AppState) -> AppResult<serde_json::Value> {
    let titles = repo::list_titles(state.db.pool(), true).await?;
    let counts = repo::title_holder_counts(state.db.pool()).await?;
    Ok(serde_json::from_str(&titles_catalog_json(&titles, &counts)).unwrap_or_default())
}

#[derive(Debug, Deserialize)]
pub struct TitleForm {
    pub csrf: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Deserialize)]
pub struct TitleCreateForm {
    pub csrf: String,
    /// 英文标识：规则与代码引用它，建成后不可改。
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Deserialize)]
pub struct TitleArchiveForm {
    pub csrf: String,
    pub archived: Option<String>,
}

/// 头衔目录（含归档与持有者数）：面板挂载时取一次。
pub async fn list_title_catalog(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let actor = guard(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    Ok(Json(titles_state(&state).await?).into_response())
}

/// 新建头衔。key 是代码引用（建成不可改）；key 重复时按「复用已有那条」处理。
pub async fn create_title(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<TitleCreateForm>,
) -> AppResult<Response> {
    let actor = guard(&state, &headers).await?;
    session::check_csrf(&actor, &form.csrf)?;
    let key = normalized_key(&form.key)?;
    let (name, color, description) = checked_fields(&form.name, &form.color, &form.description)?;
    let now = now_unix();
    let existing = repo::list_titles(state.db.pool(), true)
        .await?
        .into_iter()
        .find(|t| t.key == key);
    let (id, message) = match existing {
        Some(row) => {
            // key 已存在：当改这条（早先的实现只 INSERT OR IGNORE，等于静默丢失输入）
            repo::update_title(state.db.pool(), row.id, &name, &color, &description).await?;
            (row.id, "标识已存在：已更新同名头衔")
        }
        None => {
            let id =
                repo::create_title(state.db.pool(), &key, &name, &color, &description, now).await?;
            (id, "已新建头衔")
        }
    };
    tracing::info!(title.id = id, title.key = %key, actor.id = actor.id, "管理端新建头衔");
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        "title.create",
        Some(&format!("title:{id}")),
        Some(&name),
        now,
    )
    .await;
    Ok(Json(finish(titles_state(&state).await?, message)).into_response())
}

/// 改名 / 改配色 / 改描述（key 不动）。
pub async fn update_title(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<TitleForm>,
) -> AppResult<Response> {
    let actor = guard(&state, &headers).await?;
    session::check_csrf(&actor, &form.csrf)?;
    let (name, color, description) = checked_fields(&form.name, &form.color, &form.description)?;
    if !repo::update_title(state.db.pool(), id, &name, &color, &description).await? {
        return Err(AppError::not_found("头衔不存在"));
    }
    tracing::info!(title.id = id, actor.id = actor.id, "管理端修改头衔");
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        "title.update",
        Some(&format!("title:{id}")),
        Some(&name),
        now_unix(),
    )
    .await;
    Ok(Json(finish(titles_state(&state).await?, "已保存头衔")).into_response())
}

/// 归档 / 取消归档。归档只影响「新发放」，已持有的仍可收回。
pub async fn archive_title(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<TitleArchiveForm>,
) -> AppResult<Response> {
    let actor = guard(&state, &headers).await?;
    session::check_csrf(&actor, &form.csrf)?;
    let archived = flag(form.archived.as_deref());
    if !repo::set_title_archived(state.db.pool(), id, archived, now_unix()).await? {
        return Err(AppError::not_found("头衔不存在，或状态已经是这样了"));
    }
    tracing::info!(
        title.id = id,
        archived,
        actor.id = actor.id,
        "管理端归档头衔"
    );
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        if archived {
            "title.archive"
        } else {
            "title.unarchive"
        },
        Some(&format!("title:{id}")),
        None,
        now_unix(),
    )
    .await;
    let message = if archived {
        "已归档"
    } else {
        "已取消归档"
    };
    Ok(Json(finish(titles_state(&state).await?, message)).into_response())
}

/// 校验 key：小写字母/数字/下划线，3..=32（与用户组标识同一套规则）。
fn normalized_key(raw: &str) -> AppResult<String> {
    let key = raw.trim().to_lowercase();
    if key.len() < 3
        || key.len() > 32
        || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(invalid("标识要 3–32 位小写字母、数字或下划线"));
    }
    Ok(key)
}

/// 名称/配色/描述的统一校验（新建与修改共用）。
fn checked_fields(
    name: &str,
    color: &str,
    description: &str,
) -> AppResult<(String, String, String)> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 20 {
        return Err(invalid("名称必填，且不超过 20 个字"));
    }
    let color = color.trim();
    // 颜色会进 style，只放行十六进制 / 颜色名 / 简单函数式颜色，挡掉注入
    let safe_color = !color.is_empty()
        && color.len() <= 32
        && color.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || c == '#'
                || c == '('
                || c == ')'
                || c == ','
                || c == '.'
                || c == '%'
                || c == ' '
        });
    if !color.is_empty() && !safe_color {
        return Err(invalid("配色只支持十六进制或颜色名，例如 #f97316"));
    }
    let description = description.trim();
    if description.chars().count() > 60 {
        return Err(invalid("描述不超过 60 个字"));
    }
    Ok((
        name.to_string(),
        color.to_lowercase(),
        description.to_string(),
    ))
}

fn finish(mut body: serde_json::Value, message: &str) -> serde_json::Value {
    body["message"] = serde_json::json!(message);
    body
}

fn flag(value: Option<&str>) -> bool {
    matches!(value, Some("1") | Some("on"))
}
