//! 管理员面板：用户管理、激活、权限等级、显示名、注册策略。
//!
//! 权限分层：查看面板 / 激活·停用 / 切换注册策略 = 网站管理员；
//! 修改权限等级、改显示名 = 超级管理员。所有动作过 CSRF 并写审计日志。

use axum::Form;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use serde::Deserialize;

use sc2clud_core::auth::{Permission, Role};
use sc2clud_core::{Error as DomainError, now_unix};
use sc2clud_db::repo;
use sc2clud_storage::BlobReader;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::routes::{feed_view, require_user};
use crate::session;
use crate::templates::{
    AdminTemplate, AdminUserEditTemplate, AdminUserView, format_date, format_relative, human_bytes,
    render,
};

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

/// 这个请求是前端 fetch 发来的吗？
///
/// 是就回 JSON（页面就地更新，不刷新）；否则回跳转（无 JS 也能用）。
fn wants_json(headers: &HeaderMap) -> bool {
    let by_flag = headers
        .get("x-requested-with")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("fetch"));
    let by_accept = headers
        .get(axum::http::header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("application/json"));
    by_flag || by_accept
}

fn done(headers: &HeaderMap, message: &str, redirect: &str) -> Response {
    if wants_json(headers) {
        (
            axum::http::StatusCode::OK,
            axum::Json(serde_json::json!({ "ok": true, "message": message })),
        )
            .into_response()
    } else {
        Redirect::to(redirect).into_response()
    }
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::Domain(DomainError::InvalidInput(msg.into()))
}

/// `/admin` → 用户管理首页。
pub async fn index() -> Redirect {
    Redirect::to("/admin/users/overview")
}

fn forbidden(msg: &str) -> AppError {
    AppError::Domain(DomainError::Forbidden(msg.to_string()))
}

#[derive(Debug, Deserialize)]
pub struct AdminQuery {
    /// 预览用：默认头像池界面版式。
    av: Option<String>,
    /// 权限/用户组界面版式。
    aui: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
}

async fn build_panel<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
    query: &str,
    av: Option<&str>,
    aui: Option<&str>,
) -> AppResult<AdminTemplate<'a>> {
    let user = require_user(state, headers).await?;
    session::guard(Some(&user), Permission::ManageUsers)?;
    let now = now_unix();
    let rows = repo::admin_list_users(state.db.pool(), query, 200).await?;
    let total_users = repo::count_users(state.db.pool()).await?;
    let pending_rows = repo::list_pending_posts(state.db.pool(), 50).await?;
    // 磁盘预算总览：服务器还剩多少、已经承诺出去多少、其中还没被用掉多少
    let (allocated, used) = repo::quota_totals(state.db.pool()).await?;
    let free_bytes = state.storage.available_bytes().await.unwrap_or(0);
    let unused = (allocated - used).max(0);
    let quota_over_committed =
        allocated.max(0) as u64 > free_bytes.saturating_add(used.max(0) as u64);
    // 分区档位（0 不启用 / 1 白名单 / 2 黑名单）——矩阵里的下拉要回显当前值
    let section_modes: std::collections::HashMap<String, i64> =
        repo::list_sections(state.db.pool(), true)
            .await?
            .into_iter()
            .map(|section| (section.key, section.group_mode))
            .collect();
    // 每个用户所属的用户组（人数少，逐个查即可；将来量大再换成一条 JOIN）
    let mut member_groups: std::collections::HashMap<i64, Vec<i64>> =
        std::collections::HashMap::new();
    for group in repo::list_user_groups(state.db.pool(), true).await? {
        for member in repo::list_group_members(state.db.pool(), group.id).await? {
            member_groups.entry(member.0).or_default().push(group.id);
        }
    }
    let users = rows
        .into_iter()
        .map(|row| AdminUserView {
            id: row.id,
            ban_label: row
                .post_ban_until
                .filter(|until| *until > now)
                .map(|until| format!("禁言至 {}", crate::templates::format_date(until)))
                .unwrap_or_default(),
            groups: member_groups.get(&row.id).cloned().unwrap_or_default(),
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
                .map(|ts| now.saturating_sub(ts) < 300)
                .unwrap_or(false),
            avatar: row.avatar_hash.clone(),
            handle: row.handle,
            display_name: row.display_name,
            role_label: Role::parse(&row.role)
                .map(|r| r.label().to_string())
                .unwrap_or_else(|_| row.role.clone()),
            role: row.role,
            activated: row.activated_at.is_some(),
            created_at: format_date(row.created_at),
            created_from_now: format_relative(row.created_at, now),
            last_seen: row
                .last_seen_at
                .map(|ts| format_relative(ts, now))
                .unwrap_or_else(|| "从未登录".to_string()),
            email: row.email.clone().unwrap_or_default(),
            quota_human: human_bytes(row.quota_bytes.max(0) as u64),
            quota_gb: format!("{:.1}", row.quota_bytes.max(0) as f64 / 1_073_741_824.0),
            used_human: human_bytes(row.used_bytes.max(0) as u64),
            is_self: row.id == user.id,
        })
        .collect();
    // 版式编号从原始查询串里取（面板的 query 是用户搜索词，不能混用）
    // 已评审通过的是 v2（列表行 + 顶部上传）
    let pool_variant = if state.config.server.debug_pages {
        av.and_then(|v| v.parse::<u8>().ok())
            .filter(|v| (1..=3).contains(v))
            .unwrap_or(2)
    } else {
        2
    };
    // 用户组 + 人数 + 规则（人数少，直接逐个查，不值得为它写一条聚合 SQL）
    // 版式编号走 AdminQuery（从搜索词里找参数是错的 —— av= 那次就栽过）
    let acl_variant = if state.config.server.debug_pages {
        aui.and_then(|value| value.parse::<u8>().ok())
            .filter(|value| (1..=3).contains(value))
            .unwrap_or(1)
    } else {
        1
    };
    let all_rules = repo::list_all_group_rules(state.db.pool()).await?;
    let mut groups = Vec::new();
    for group in repo::list_user_groups(state.db.pool(), true).await? {
        let members = repo::list_group_members(state.db.pool(), group.id).await?;
        let rules = all_rules
            .iter()
            .filter(|rule| rule.group_id == group.id)
            .map(|rule| {
                (
                    rule.section.clone(),
                    rule.can_post != 0,
                    rule.can_reply != 0,
                    rule.deny_post != 0,
                    rule.deny_reply != 0,
                )
            })
            .collect();
        groups.push(crate::templates::AdminGroupView {
            id: group.id,
            key: group.key,
            name: group.name,
            description: group.description,
            member_count: members.len() as i64,
            archived: group.archived_at.is_some(),
            rules,
        });
    }
    let default_avatars = repo::list_default_avatars(state.db.pool())
        .await?
        .into_iter()
        .map(|row| crate::templates::DefaultAvatarView {
            id: row.id,
            hash: row.hash,
            note: row.note,
            date: crate::templates::format_date(row.created_at),
        })
        .collect();
    Ok(AdminTemplate {
        default_avatars,
        pool_variant,
        acl_variant,
        groups,
        block_reply_enforced: repo::site_text(state.db.pool(), "block_reply_enforced", "0").await?
            == "1",
        ban_options: BAN_HOUR_OPTIONS
            .iter()
            .map(|(hours, label)| (hours.to_string(), label.to_string()))
            .collect(),
        server_free_human: human_bytes(free_bytes),
        quota_allocated_human: human_bytes(allocated.max(0) as u64),
        quota_used_human: human_bytes(used.max(0) as u64),
        quota_unused_human: human_bytes(unused as u64),
        quota_over_committed,
        query: query.to_string(),
        total_users,
        now,
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
        sections: {
            let covers: std::collections::HashMap<String, String> =
                repo::list_section_covers(state.db.pool())
                    .await?
                    .into_iter()
                    .map(|(section, hash, _mime)| (section, hash))
                    .collect();
            sc2clud_core::resource::PostSection::ALL
                .iter()
                .map(|s| crate::templates::SectionOption {
                    value: s.as_str().to_string(),
                    label: s.label().to_string(),
                    checked: false,
                    cover: covers.get(s.as_str()).cloned(),
                    mode: section_modes.get(s.as_str()).copied().unwrap_or(0),
                })
                .collect()
        },
        pending: pending_rows
            .iter()
            .map(|row| feed_view(row, Some(user.id)))
            .collect(),
    })
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

async fn build_user_edit<'a>(
    state: &'a AppState,
    id: i64,
    headers: &HeaderMap,
) -> AppResult<AdminUserEditTemplate<'a>> {
    let actor = require_user(state, headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
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
        user: AdminUserView {
            groups: Vec::new(),
            ban_label: String::new(),
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
                .map(|ts| now.saturating_sub(ts) < 300)
                .unwrap_or(false),
            email: row.email.clone().unwrap_or_default(),
            quota_human: human_bytes(row.quota_bytes.max(0) as u64),
            quota_gb: format!("{:.1}", row.quota_bytes.max(0) as f64 / 1_073_741_824.0),
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

#[derive(Debug, Deserialize)]
pub struct DomainForm {
    pub csrf: String,
    pub domain: String,
    pub note: Option<String>,
}

/// 统一域名管理：列出「哪些域名是我们的」。
pub async fn list_domains(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageDomains)?;
    let rows = repo::list_site_domains(state.db.pool()).await?;
    let domains: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|row| serde_json::json!({ "domain": row.domain, "note": row.note }))
        .collect();
    // 站点根也一并给出：它天然算我们的域名（链接解析会带上）
    Ok(axum::Json(serde_json::json!({
        "domains": domains,
        "base_url": state.config.server.base_url,
    }))
    .into_response())
}

/// 加一个域名（会自动规范化：小写、去端口、去开头 www.）。
pub async fn add_domain(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<DomainForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageDomains)?;
    session::check_csrf(&actor, &form.csrf)?;
    let domain = sc2clud_core::community::normalize_domain(&form.domain).ok_or_else(|| {
        AppError::Domain(DomainError::InvalidInput(
            "域名不合法（示例：example.com）".to_string(),
        ))
    })?;
    let note = form.note.as_deref().unwrap_or_default().trim();
    let added = repo::add_site_domain(state.db.pool(), &domain, note, now_unix()).await?;
    Ok(done(
        &headers,
        if added {
            "已添加域名"
        } else {
            "域名已存在"
        },
        "/admin/users/overview",
    ))
}

pub async fn remove_domain(
    State(state): State<AppState>,
    Path(domain): Path<String>,
    headers: HeaderMap,
    Form(form): Form<CsrfForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageDomains)?;
    session::check_csrf(&actor, &form.csrf)?;
    let domain = sc2clud_core::community::normalize_domain(&domain).unwrap_or(domain);
    repo::remove_site_domain(state.db.pool(), &domain).await?;
    Ok(done(&headers, "已移除域名", "/admin/users/overview"))
}

#[derive(Debug, Deserialize)]
pub struct BannerForm {
    pub csrf: String,
    pub title: String,
    pub body: Option<String>,
    pub kind: Option<String>,
    pub url: Option<String>,
    /// 有效期天数（留空 = 不过期）。
    pub days: Option<String>,
    /// 定向用户组 id，逗号分隔；留空 = 所有人可见。
    pub groups: Option<String>,
}

/// 新建横幅：对登录用户展示，用户点「确认」后不再看到。
pub async fn create_banner(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<BannerForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::PublishBanner)?;
    session::check_csrf(&actor, &form.csrf)?;
    let title = form.title.trim();
    if title.is_empty() || title.chars().count() > 60 {
        return Err(AppError::Domain(DomainError::InvalidInput(
            "标题必填，且不超过 60 个字符".to_string(),
        )));
    }
    let now = now_unix();
    // 只认 info / warning / promo，别的一律当 info（横幅是展示位，不校验没意义）
    let kind = match form.kind.as_deref().map(str::trim) {
        Some("warning") => "warning",
        Some("promo") => "promo",
        _ => "info",
    };
    let days: Option<i64> = form
        .days
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .and_then(|v| v.parse().ok());
    let id = repo::create_banner(
        state.db.pool(),
        repo::NewBanner {
            title,
            body: form.body.as_deref().unwrap_or_default().trim(),
            kind,
            url: form.url.as_deref().map(str::trim).filter(|v| !v.is_empty()),
            starts_at: None,
            ends_at: days.map(|d| now + d.clamp(1, 365) * 86_400),
            created_by: Some(actor.id),
            now,
        },
    )
    .await?;
    // 定向：给了组就只对这些组可见（空 = 所有人）
    let group_ids: Vec<i64> = form
        .groups
        .as_deref()
        .unwrap_or_default()
        .split(',')
        .filter_map(|v| v.trim().parse::<i64>().ok())
        .collect();
    if !group_ids.is_empty() {
        repo::set_banner_groups(state.db.pool(), id, &group_ids).await?;
    }
    tracing::info!(banner.id = id, actor.id = actor.id, groups = ?group_ids, "新建横幅");
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        "banner.create",
        Some(&format!("banner:{id}")),
        Some(title),
        now,
    )
    .await;
    Ok(done(&headers, "横幅已发布", "/admin/users/overview"))
}

#[derive(Debug, Deserialize)]
pub struct BannerActiveForm {
    pub csrf: String,
    pub active: Option<String>,
}

/// 开 / 停某条横幅。
pub async fn set_banner_active(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<BannerActiveForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::PublishBanner)?;
    session::check_csrf(&actor, &form.csrf)?;
    let active = matches!(form.active.as_deref(), Some("1") | Some("on"));
    repo::set_banner_active(state.db.pool(), id, active).await?;
    Ok(done(
        &headers,
        if active {
            "横幅已启用"
        } else {
            "横幅已停用"
        },
        "/admin/users/overview",
    ))
}

#[derive(Debug, Deserialize)]
pub struct SiteTextForm {
    pub csrf: String,
    pub default_bio: Option<String>,
}

/// 改站点默认文案（当前只有默认个人简介）。只有超级管理员能动。
pub async fn site_texts_save(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<SiteTextForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageRoles)?;
    session::check_csrf(&actor, &form.csrf)?;
    let text =
        sc2clud_core::community::validate_bio(form.default_bio.as_deref().unwrap_or_default())?;
    if text.is_empty() {
        return Err(AppError::from(sc2clud_core::Error::InvalidInput(
            "默认简介不能为空".to_string(),
        )));
    }
    repo::set_site_text(
        state.db.pool(),
        "default_bio",
        &text,
        Some(actor.id),
        now_unix(),
    )
    .await?;
    tracing::info!(actor.id = actor.id, "更新站点默认文案 default_bio");
    Ok(done(&headers, "默认简介已保存", "/admin/users/overview"))
}

#[derive(Debug, Deserialize)]
pub struct DefaultAvatarQuery {
    note: Option<String>,
}

/// 往默认头像池里加一张（原始文件字节，CSRF 走 header，与收款码上传同一套）。
pub async fn default_avatar_add(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<DefaultAvatarQuery>,
    body: axum::body::Body,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    let token = headers
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    session::check_csrf(&actor, token)?;
    let bytes = axum::body::to_bytes(body, 512 * 1024)
        .await
        .map_err(|_| AppError::Domain(DomainError::InvalidInput("图片太大".to_string())))?;
    let mime = crate::routes::sniff_image_mime(&bytes).ok_or_else(|| {
        AppError::Domain(DomainError::InvalidInput(
            "只支持 PNG/JPEG/WebP".to_string(),
        ))
    })?;
    // 与收款码上传同一套：固定缓冲流式落盘 + 内容寻址
    let size = bytes.len() as i64;
    let reader: sc2clud_storage::BlobReader = Box::pin(tokio_util::io::StreamReader::new(
        futures_util::stream::once(async move { Ok::<_, std::io::Error>(bytes) }),
    ));
    let outcome = state
        .storage
        .put_stream(reader, None)
        .await
        .map_err(AppError::from)?;
    let hash = outcome.stat.hash.to_string();
    let now = now_unix();
    repo::ensure_blob(state.db.pool(), &hash, size, now).await?;
    let note = query.note.as_deref().unwrap_or_default().trim();
    let added = repo::add_default_avatar(
        state.db.pool(),
        &hash,
        mime,
        note,
        Some(actor.id),
        now_unix(),
    )
    .await?;
    Ok(axum::Json(serde_json::json!({ "ok": true, "added": added })).into_response())
}

#[derive(Debug, Deserialize)]
pub struct DefaultAvatarRemoveForm {
    pub csrf: String,
    pub id: i64,
}

/// 把一张默认头像移出池子（引用归零的图片会回收）。
pub async fn default_avatar_remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<DefaultAvatarRemoveForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    if let Some(hash) = repo::remove_default_avatar(state.db.pool(), form.id).await?
        && let Ok(blob) = sc2clud_core::BlobHash::parse(&hash)
    {
        let _ = state.storage.delete(&blob).await;
    }
    Ok(done(&headers, "已移出默认头像池", "/admin/users/overview"))
}
pub async fn panel(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<AdminQuery>,
) -> Response {
    let q = query.q.unwrap_or_default();
    match build_panel(
        &state,
        &headers,
        &q,
        query.av.as_deref(),
        query.aui.as_deref(),
    )
    .await
    {
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
    change_activation(state, id, headers, form, true).await
}

pub async fn deactivate(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<CsrfForm>,
) -> AppResult<Response> {
    change_activation(state, id, headers, form, false).await
}

async fn change_activation(
    state: AppState,
    id: i64,
    headers: HeaderMap,
    form: CsrfForm,
    activate: bool,
) -> AppResult<Response> {
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
    Ok(done(&headers, "已保存", "/admin/users/overview"))
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
/// 密码用 argon2id 现算；邮箱自动给 `<登录名>@local`（users.email 有唯一约束，
/// 不能一堆空串撞在一起）。命中唯一约束时给一句人话，不暴露 SQL。
pub async fn create_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<CreateUserForm>,
) -> AppResult<Response> {
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
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}
#[derive(Debug, Deserialize)]
pub struct EditUserForm {
    pub csrf: String,
    /// 禁言时长（小时）：空或 "0" = 解禁，其余 = 从现在起禁这么多小时。
    #[serde(default)]
    pub ban_hours: Option<String>,
    pub display_name: String,
    pub role: String,
    pub quota_gb: String,
    pub trusted: Option<String>,
    pub activated: Option<String>,
    pub new_password: Option<String>,
}

/// 禁言时长选项（后台下拉用）：(值, 显示名)。0 = 解禁。
pub const BAN_HOUR_OPTIONS: [(i64, &str); 6] = [
    (0, "不禁言"),
    (1, "1 小时"),
    (24, "1 天"),
    (72, "3 天"),
    (168, "7 天"),
    (720, "30 天"),
];

/// 管理面板「编辑用户」弹窗的保存：一次把资料改完（等级也就地切换）。
pub async fn update_user(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<EditUserForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let Some(target) = repo::admin_get_user(state.db.pool(), id).await? else {
        return Err(AppError::not_found("没有这个用户"));
    };

    // 等级：只有超级管理员能动，且不能改自己（避免把自己锁在门外）
    let mut role = target.role.clone();
    // 权限不足时前端可能压根不提交 role（字段被禁用），空值表示「不改等级」
    if !form.role.trim().is_empty() && form.role != target.role {
        session::guard(Some(&actor), Permission::ManageRoles)?;
        if id == actor.id {
            return Err(AppError::Domain(DomainError::Forbidden(
                "不能修改自己的权限等级".to_string(),
            )));
        }
        role = Role::parse(form.role.trim())?.as_str().to_string();
    }

    // 显示名：管理员及以上可改（与旧行为一致）
    let display_name = if form.display_name.trim() == target.display_name {
        target.display_name.clone()
    } else {
        session::guard(Some(&actor), Permission::ManageUsers)?;
        sc2clud_core::auth::validate_display_name(form.display_name.trim())?
    };

    let gb: f64 = form
        .quota_gb
        .trim()
        .parse()
        .map_err(|_| AppError::Domain(DomainError::InvalidInput("预算要填数字".to_string())))?;
    if !(0.0..=10240.0).contains(&gb) {
        return Err(AppError::Domain(DomainError::InvalidInput(
            "预算范围是 0 ~ 10240 GB".to_string(),
        )));
    }
    let quota_bytes = (gb * 1_073_741_824.0).round() as i64;

    let trusted = form
        .trusted
        .as_deref()
        .is_some_and(|v| v == "1" || v == "on");
    // 自己不能被停用
    let activated = if id == actor.id {
        true
    } else {
        form.activated
            .as_deref()
            .is_some_and(|v| v == "1" || v == "on")
    };

    let password_hash = match form.new_password.as_deref().map(str::trim) {
        Some(pw) if !pw.is_empty() => {
            sc2clud_core::auth::validate_password(pw)?;
            Some(sc2clud_core::auth::hash_password(pw)?)
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
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        "user.update",
        Some(&format!("user:{id}")),
        Some(&format!(
            "role={role} trusted={trusted} activated={activated}"
        )),
        now,
    )
    .await;
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}

#[derive(Debug, Deserialize)]
pub struct TrustForm {
    pub csrf: String,
    pub trusted: Option<String>,
}

/// 设置「信任」：被信任的账号发帖只走自动审核。
pub async fn set_trusted(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<TrustForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let trusted = matches!(form.trusted.as_deref(), Some("1") | Some("on"));
    let now = now_unix();
    if repo::set_user_trusted(state.db.pool(), id, trusted).await? {
        tracing::info!(user.id = id, trusted, actor.id = actor.id, "设置信任标记");
        let _ = repo::record_audit(
            state.db.pool(),
            Some(actor.id),
            "user.set_trusted",
            Some(&format!("user:{id}")),
            Some(if trusted { "1" } else { "0" }),
            now,
        )
        .await;
    }
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}

/// 分区封面：管理员及以上可以设置（直接上传图片，服务端只做魔数校验与体积上限）。
#[derive(Debug, Deserialize)]
pub struct SectionMoveForm {
    pub csrf: String,
    /// "up" / "down"
    pub dir: String,
}

/// 分区调序（↑↓ 一次换一格）：读当前顺序 → 与相邻项交换 → 整体写回。
/// 仓储只排给出的 key，其余按原顺序接在后面，不会互相撞 position。
pub async fn move_section(
    State(state): State<AppState>,
    Path(section): Path<String>,
    headers: HeaderMap,
    Form(form): Form<SectionMoveForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let mut keys: Vec<String> = repo::list_sections(state.db.pool(), true)
        .await?
        .into_iter()
        .map(|row| row.key)
        .collect();
    let Some(index) = keys.iter().position(|key| *key == section) else {
        return Err(AppError::not_found("分区不存在"));
    };
    let target = if form.dir == "up" {
        index.checked_sub(1)
    } else if index + 1 < keys.len() {
        Some(index + 1)
    } else {
        None
    };
    if let Some(target) = target {
        keys.swap(index, target);
        repo::reorder_sections(state.db.pool(), &keys, now_unix()).await?;
        tracing::info!(section, dir = form.dir, "分区调序");
    }
    let order: Vec<String> = repo::list_sections(state.db.pool(), true)
        .await?
        .into_iter()
        .map(|row| row.key)
        .collect();
    // 面板里的 ↑↓ 用 fetch 调用：回 JSON 让页面就地重排，不刷新、不用出门再看
    if headers
        .get("x-requested-with")
        .and_then(|v| v.to_str().ok())
        == Some("fetch")
    {
        return Ok(axum::Json(serde_json::json!({ "ok": true, "order": order })).into_response());
    }
    Ok(done(
        &headers,
        "分区顺序已更新",
        "/admin/users/overview#covers",
    ))
}

#[derive(Debug, Deserialize)]
pub struct GroupCreateForm {
    pub csrf: String,
    /// 英文标识：规则与代码引用它，建成后不可改。
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

/// 新建用户组。
#[derive(Debug, Deserialize)]
pub struct SectionAclForm {
    pub csrf: String,
    pub post_min_role: String,
    pub reply_min_role: String,
    #[serde(default)]
    pub group_mode: Option<String>,
    /// 允许的用户组 id，逗号分隔（绿标签集合）。
    #[serde(default)]
    pub groups: String,
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

#[derive(Debug, Deserialize)]
pub struct BanForm {
    pub csrf: String,
    /// 时长小时数：0 或空 = 解禁。
    #[serde(default)]
    pub hours: Option<String>,
}

/// 限期禁言 / 解禁：hours = 0 解禁，其余为小时数。管理员及以上不能被禁（避免管理员互相锁死）。
pub async fn ban_user(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<BanForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let target = repo::find_user_by_id(state.db.pool(), id)
        .await?
        .ok_or_else(|| AppError::not_found("用户不存在"))?;
    if sc2clud_core::auth::Role::parse(&target.role)
        .is_ok_and(|role| role >= sc2clud_core::auth::Role::Admin)
    {
        return Err(AppError::Domain(DomainError::InvalidInput(
            "管理员及以上不接受禁言".to_string(),
        )));
    }
    let hours: i64 = form
        .hours
        .as_deref()
        .unwrap_or("0")
        .trim()
        .parse()
        .unwrap_or(0)
        .clamp(0, 24 * 365);
    let until = if hours > 0 {
        Some(now_unix() + hours * 3600)
    } else {
        None
    };
    repo::set_post_ban(state.db.pool(), id, until).await?;
    tracing::info!(user.id = id, hours, actor.id = actor.id, "限期禁言");
    let message = if hours > 0 {
        "已设置禁言"
    } else {
        "已解除禁言"
    };
    Ok(done(&headers, message, "/admin/users/overview"))
}

#[derive(Debug, Deserialize)]
pub struct BlockReplyForm {
    pub csrf: String,
    /// "1" 开启 / "0" 关闭。
    pub enabled: String,
}

/// 全站开关：被拉黑后能否在对方帖子下回复。
pub async fn set_block_reply(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<BlockReplyForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let value = if form.enabled == "1" { "1" } else { "0" };
    repo::set_site_text(
        state.db.pool(),
        "block_reply_enforced",
        value,
        Some(actor.id),
        now_unix(),
    )
    .await?;
    tracing::info!(
        enabled = value,
        actor.id = actor.id,
        "设置「被拉黑不能回复」开关"
    );
    Ok(done(
        &headers,
        "设置已保存",
        "/admin/users/overview#settings",
    ))
}

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
    let name = form.name.trim();
    if name.is_empty() {
        return Err(AppError::Domain(DomainError::InvalidInput(
            "组名不能为空".to_string(),
        )));
    }
    // 仓储用 INSERT OR IGNORE 并在冲突时回查 id：拿不到「是否新建」，就统一按「已保存」提示
    let _group_id = repo::create_user_group(
        state.db.pool(),
        &key,
        name,
        form.description.trim(),
        now_unix(),
    )
    .await?;
    tracing::info!(group.key = %key, actor.id = actor.id, "新建用户组");
    let message = "用户组已保存（标识重复时会复用已有组）";
    Ok(done(&headers, message, "/admin/users/overview#groups"))
}

#[derive(Debug, Deserialize)]
pub struct GroupUpdateForm {
    pub csrf: String,
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub description: String,
}

/// 改用户组的名称与说明。
pub async fn update_group(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<GroupUpdateForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let name = form.name.trim();
    if name.is_empty() {
        return Err(AppError::Domain(DomainError::InvalidInput(
            "组名不能为空".to_string(),
        )));
    }
    let updated =
        repo::update_user_group(state.db.pool(), form.id, name, form.description.trim()).await?;
    tracing::info!(group.id = form.id, actor.id = actor.id, "编辑用户组");
    let message = if updated {
        "用户组已更新"
    } else {
        "用户组不存在"
    };
    Ok(done(&headers, message, "/admin/users/overview#groups"))
}

#[derive(Debug, Deserialize)]
pub struct GroupArchiveForm {
    pub csrf: String,
    pub id: i64,
    /// "1" 归档 / "0" 恢复。
    pub archived: String,
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
    let message = if changed {
        if archived {
            "用户组已归档"
        } else {
            "用户组已恢复"
        }
    } else {
        "用户组不存在"
    };
    Ok(done(&headers, message, "/admin/users/overview#groups"))
}

#[derive(Debug, Deserialize)]
pub struct UserGroupsForm {
    pub csrf: String,
    /// 勾选的用户组 id（可多个；重复字段由 serde 收成 Vec）。
    #[serde(default)]
    pub groups: Vec<i64>,
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
    let current: Vec<i64> = repo::list_user_groups_for(state.db.pool(), id)
        .await?
        .into_iter()
        .map(|group| group.id)
        .collect();
    let now = now_unix();
    for group_id in &form.groups {
        if !current.contains(group_id) {
            repo::add_group_member(state.db.pool(), *group_id, id, now).await?;
        }
    }
    for group_id in &current {
        if !form.groups.contains(group_id) {
            repo::remove_group_member(state.db.pool(), *group_id, id).await?;
        }
    }
    tracing::info!(user.id = id, actor.id = actor.id, groups = ?form.groups, "设置用户组");
    Ok(done(
        &headers,
        "用户组已更新",
        "/admin/users/overview#users",
    ))
}

pub async fn set_section_cover(
    State(state): State<AppState>,
    Path(section): Path<String>,
    headers: HeaderMap,
    body: axum::body::Body,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    let token = headers
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    session::check_csrf(&actor, token)?;
    let parsed = sc2clud_core::resource::PostSection::parse(&section)?;

    // 封面体积：读进内存即可（上限 2 MB），比走完整流式上传简单得多
    let bytes = axum::body::to_bytes(body, 2 * 1024 * 1024)
        .await
        .map_err(|e| {
            AppError::Domain(DomainError::InvalidInput(format!(
                "封面读取失败或超过 2 MB：{e}"
            )))
        })?;
    let mime = crate::routes::sniff_image_mime(&bytes).ok_or_else(|| {
        AppError::Domain(DomainError::InvalidInput(
            "封面只接受 PNG / JPEG / GIF / WebP".to_string(),
        ))
    })?;
    let size = bytes.len() as i64;
    // 走统一的流式写入：把内存里的封面包成一次性的流
    let reader: BlobReader = Box::pin(tokio_util::io::StreamReader::new(
        futures_util::stream::once(async move { Ok::<_, std::io::Error>(bytes) }),
    ));
    let outcome = state
        .storage
        .put_stream(reader, None)
        .await
        .map_err(AppError::from)?;
    let hash = outcome.stat.hash.to_string();
    let now = now_unix();
    repo::ensure_blob(state.db.pool(), &hash, size, now).await?;
    repo::set_section_cover(state.db.pool(), parsed.as_str(), &hash, mime, actor.id, now).await?;
    tracing::info!(section = parsed.as_str(), %hash, actor.id = actor.id, "设置分区封面");
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        "section.set_cover",
        Some(parsed.as_str()),
        Some(&hash),
        now,
    )
    .await;
    Ok(done(&headers, "封面已更新", "/admin/users/overview"))
}

#[derive(Debug, Deserialize)]
pub struct QuotaForm {
    pub csrf: String,
    pub quota_gb: String,
}

/// 分配磁盘预算：管理员即可。0 = 不分配。
pub async fn set_quota(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<QuotaForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;

    let gb: f64 = form
        .quota_gb
        .trim()
        .parse()
        .map_err(|_| invalid("预算要填数字（单位 GB）"))?;
    if !(0.0..=10_240.0).contains(&gb) {
        return Err(invalid("预算范围 0–10240 GB"));
    }
    let bytes = (gb * 1_073_741_824.0).round() as i64;
    let now = now_unix();
    if repo::set_user_quota(state.db.pool(), id, bytes).await? {
        tracing::info!(
            user.id = id,
            quota_bytes = bytes,
            actor.id = actor.id,
            "管理员分配磁盘预算"
        );
        let _ = repo::record_audit(
            state.db.pool(),
            Some(actor.id),
            "user.set_quota",
            Some(&format!("user:{id}")),
            Some(&format!("{gb:.1} GB")),
            now,
        )
        .await;
    }
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}

#[derive(Debug, Deserialize)]
pub struct ReviewForm {
    pub csrf: String,
    #[serde(default)]
    pub note: Option<String>,
}

pub async fn approve(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<ReviewForm>,
) -> AppResult<Response> {
    review(&state, id, &headers, &form, true).await
}

pub async fn reject(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<ReviewForm>,
) -> AppResult<Response> {
    review(&state, id, &headers, &form, false).await
}

/// 人工过审 / 拒绝。**管理员及以上**（`Permission::ReviewPost`，产品要求从开发者上调）。
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
    let typed = form
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let fallback = if allow {
        "管理员人工通过"
    } else {
        "管理员人工拒绝"
    };
    let note = typed.unwrap_or(fallback);
    let state_str = if allow { "approved" } else { "rejected" };
    let now = now_unix();
    // 待审修改：通过就落地（替换原帖），拒绝就丢弃（原帖不受影响）
    if allow {
        let _ = repo::apply_pending_revision(state.db.pool(), id, now).await;
    } else {
        let _ = repo::drop_pending_revision(state.db.pool(), id).await;
    }
    if !repo::set_post_review_state(state.db.pool(), id, state_str, Some(note), actor.id, now)
        .await?
    {
        return Err(AppError::not_found("帖子不存在"));
    }
    tracing::info!(
        post.id = id,
        review_state = state_str,
        actor.id = actor.id,
        "人工改判审核状态"
    );
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        if allow { "post.approve" } else { "post.reject" },
        Some(&format!("post:{id}")),
        Some(note),
        now,
    )
    .await;
    Ok(done(
        headers,
        if allow { "已通过" } else { "已拒绝" },
        "/admin/users/overview",
    ))
}
#[derive(Debug, Deserialize)]
pub struct ArchiveForm {
    pub csrf: String,
}

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

/// 归档 = 不删除、不再展示（列表里消失，直链仍可打开）。
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
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        if archived {
            "post.archive"
        } else {
            "post.unarchive"
        },
        Some(&format!("post:{id}")),
        None,
        now,
    )
    .await;
    Ok(done(
        &headers,
        if archived {
            "已归档"
        } else {
            "已取消归档"
        },
        "/admin/users/overview",
    ))
}

/// 打回：让作者改完再提交（状态置为 `revision`，并通知作者）。
pub async fn request_revision(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<ReviewForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ReviewPost)?;
    session::check_csrf(&actor, &form.csrf)?;
    let typed = form
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let note = typed.unwrap_or("请按审核意见修改后重新提交");
    let now = now_unix();
    let Some(post) = repo::get_post_for(state.db.pool(), id, Some(actor.id), true).await? else {
        return Err(AppError::not_found("帖子不存在"));
    };
    // 打回时把待审修改丢掉：作者改完再提交（避免旧修改一直挂着）
    let _ = repo::drop_pending_revision(state.db.pool(), id).await;
    if !repo::set_post_review_state(state.db.pool(), id, "revision", Some(note), actor.id, now)
        .await?
    {
        return Err(AppError::not_found("帖子不存在"));
    }
    let _ = repo::notify(
        state.db.pool(),
        repo::NewNotification {
            user_id: post.author_id,
            actor_id: Some(actor.id),
            kind: "review",
            title: &format!("你的帖子「{}」需要修改", post.title),
            body: Some(note),
            link: Some(&format!("/p/{id}/edit")),
            now,
        },
    )
    .await;
    tracing::info!(post.id = id, actor.id = actor.id, "打回修改");
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        "post.request_revision",
        Some(&format!("post:{id}")),
        Some(note),
        now,
    )
    .await;
    Ok(done(&headers, "已打回", "/admin/users/overview"))
}

pub async fn set_role(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<RoleForm>,
) -> AppResult<Response> {
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
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}

pub async fn rename(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<RenameForm>,
) -> AppResult<Response> {
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
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}

pub async fn toggle_activation_policy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<CsrfForm>,
) -> AppResult<Response> {
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
    Ok(done(&headers, "已保存", "/admin/users/overview"))
}
