//! 管理页的「内容与站点设置」：横幅与定向、站点默认文案、默认头像池、分区排序与封面、域名白名单。
//!
//! 从 pages_admin.rs 拆出（那里超过体量门禁的 500 行；见 scripts/check-size.mjs）。
//! 本层只做「权限与 CSRF 校验 → 解析表单 → 调 repo / 内容寻址存储 → 回应」，不含业务规则。

use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::{Form, Json};
use sc2clud_core::auth::Permission;
use sc2clud_core::community::{normalize_domain, validate_bio};
use sc2clud_core::resource::PostSection;
use sc2clud_core::{BlobHash, Error as DomainError, now_unix};
use sc2clud_db::repo;
use sc2clud_storage::BlobReader;
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::pages_admin::{CsrfForm, done};
use crate::routes::require_user;
use crate::session;

// ---------------------------------------------------------------- 表单结构

#[derive(Debug, Deserialize)]
pub struct DomainForm {
    pub csrf: String,
    pub domain: String,
    pub note: Option<String>,
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

#[derive(Debug, Deserialize)]
pub struct BannerActiveForm {
    pub csrf: String,
    pub active: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SiteTextForm {
    pub csrf: String,
    pub default_bio: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DefaultAvatarQuery {
    note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct DefaultAvatarRemoveForm {
    pub csrf: String,
    pub id: i64,
}

#[derive(Debug, Deserialize)]
pub struct SectionMoveForm {
    pub csrf: String,
    /// "up" / "down"
    pub dir: String,
}

// ------------------------------------------------------------ 域名白名单

/// 统一域名管理：列出「哪些域名是我们的」。
pub async fn list_domains(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageDomains)?;
    let domains: Vec<serde_json::Value> = repo::list_site_domains(state.db.pool())
        .await?
        .into_iter()
        .map(|row| json!({ "domain": row.domain, "note": row.note }))
        .collect();
    // 站点根也算我们的域名（链接解析会带上它）
    Ok(Json(json!({
        "domains": domains,
        "base_url": state.config.server.base_url,
    }))
    .into_response())
}

/// 加一个域名（自动规范化：小写、去端口、去开头 www.）。
pub async fn add_domain(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<DomainForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageDomains)?;
    session::check_csrf(&actor, &form.csrf)?;
    let domain =
        normalize_domain(&form.domain).ok_or_else(|| invalid("域名不合法（示例：example.com）"))?;
    let added = repo::add_site_domain(
        state.db.pool(),
        &domain,
        form.note.as_deref().unwrap_or_default().trim(),
        now_unix(),
    )
    .await?;
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
    let domain = normalize_domain(&domain).unwrap_or(domain);
    repo::remove_site_domain(state.db.pool(), &domain).await?;
    Ok(done(&headers, "已移除域名", "/admin/users/overview"))
}

// ---------------------------------------------------------------- 横幅

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
        return Err(invalid("标题必填，且不超过 60 个字符"));
    }
    let now = now_unix();
    // 只认 warning / promo，别的一律当 info：横幅是展示位，为错值报错没意义
    let kind = match form.kind.as_deref().map(str::trim) {
        Some("warning") => "warning",
        Some("promo") => "promo",
        _ => "info",
    };
    let days: Option<i64> = form
        .days
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .and_then(|value| value.parse().ok());
    let id = repo::create_banner(
        state.db.pool(),
        repo::NewBanner {
            title,
            body: form.body.as_deref().unwrap_or_default().trim(),
            kind,
            url: form
                .url
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty()),
            starts_at: None,
            ends_at: days.map(|days| now + days.clamp(1, 365) * 86_400),
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
        .filter_map(|value| value.trim().parse::<i64>().ok())
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
    let active = is_on(form.active.as_deref());
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

// ------------------------------------------------------------ 站点默认文案

/// 改站点默认文案（当前只有默认个人简介）。只有超级管理员能动。
pub async fn site_texts_save(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<SiteTextForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageRoles)?;
    session::check_csrf(&actor, &form.csrf)?;
    let text = validate_bio(form.default_bio.as_deref().unwrap_or_default())?;
    if text.is_empty() {
        return Err(invalid("默认简介不能为空"));
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

// ---------------------------------------------------------- 默认头像池

/// 往默认头像池里加一张（原始文件字节，CSRF 走 header，与收款码上传同一套）。
pub async fn default_avatar_add(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<DefaultAvatarQuery>,
    body: axum::body::Body,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, header_csrf(&headers))?;
    let bytes = axum::body::to_bytes(body, 512 * 1024)
        .await
        .map_err(|_| invalid("图片太大"))?;
    let (hash, mime) = store_image(&state, bytes, "只支持 PNG/JPEG/WebP").await?;
    let added = repo::add_default_avatar(
        state.db.pool(),
        &hash,
        mime,
        query.note.as_deref().unwrap_or_default().trim(),
        Some(actor.id),
        now_unix(),
    )
    .await?;
    Ok(Json(json!({ "ok": true, "added": added })).into_response())
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
        && let Ok(blob) = BlobHash::parse(&hash)
    {
        let _ = state.storage.delete(&blob).await;
    }
    Ok(done(&headers, "已移出默认头像池", "/admin/users/overview"))
}

// ------------------------------------------------------------ 分区排序与封面

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
    // 面板里的 ↑↓ 用 fetch 调用：回 JSON 让页面就地重排，不刷新、不用出页面再看
    let is_fetch = headers
        .get("x-requested-with")
        .and_then(|value| value.to_str().ok())
        == Some("fetch");
    if is_fetch {
        return Ok(Json(json!({ "ok": true, "order": order })).into_response());
    }
    Ok(done(
        &headers,
        "分区顺序已更新",
        "/admin/users/overview#covers",
    ))
}

/// 分区封面：管理员及以上可以设置（直接上传图片，服务端只做魔数校验与体积上限）。
pub async fn set_section_cover(
    State(state): State<AppState>,
    Path(section): Path<String>,
    headers: HeaderMap,
    body: axum::body::Body,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, header_csrf(&headers))?;
    let section = PostSection::parse(&section)?;
    // 封面体积：读进内存即可（上限 2 MB），比走完整流式上传简单得多
    let bytes = axum::body::to_bytes(body, 2 * 1024 * 1024)
        .await
        .map_err(|error| invalid(format!("封面读取失败或超过 2 MB：{error}")))?;
    let (hash, mime) = store_image(&state, bytes, "封面只接受 PNG / JPEG / GIF / WebP").await?;
    let now = now_unix();
    repo::set_section_cover(
        state.db.pool(),
        section.as_str(),
        &hash,
        mime,
        actor.id,
        now,
    )
    .await?;
    tracing::info!(section = section.as_str(), %hash, actor.id = actor.id, "设置分区封面");
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        "section.set_cover",
        Some(section.as_str()),
        Some(hash.as_str()),
        now,
    )
    .await;
    Ok(done(&headers, "封面已更新", "/admin/users/overview"))
}

// ---------------------------------------------------------------- 内部辅助

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::Domain(DomainError::InvalidInput(msg.into()))
}

/// 复选框 → 是否勾选（表单给 "1" 或 "on"）。
fn is_on(value: Option<&str>) -> bool {
    matches!(value, Some("1") | Some("on"))
}

/// 上传接口的 CSRF 走 header（页面用 fetch 传原始字节，没有表单字段）。
fn header_csrf(headers: &HeaderMap) -> &str {
    headers
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
}

/// 图片字节 → 内容寻址落盘，返回 (hash, mime)；两处上传共用同一套魔数校验与流式写入。
async fn store_image(
    state: &AppState,
    bytes: axum::body::Bytes,
    reject: &str,
) -> AppResult<(String, &'static str)> {
    let mime = crate::pages_media::sniff_image_mime(&bytes).ok_or_else(|| invalid(reject))?;
    let size = bytes.len() as i64;
    let reader: BlobReader = Box::pin(tokio_util::io::StreamReader::new(
        futures_util::stream::once(async move { Ok::<_, std::io::Error>(bytes) }),
    ));
    let outcome = state
        .storage
        .put_stream(reader, None)
        .await
        .map_err(AppError::from)?;
    let hash = outcome.stat.hash.to_string();
    repo::ensure_blob(state.db.pool(), &hash, size, now_unix()).await?;
    Ok((hash, mime))
}
