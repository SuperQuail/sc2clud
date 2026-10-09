//! 用户主页与头像读取。

use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Redirect, Response};

use sc2clud_core::auth::Role;
use sc2clud_db::repo;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::routes::feed_view;
use crate::session;
use crate::templates::{ProfileTemplate, format_date, render};

// ------------------------------------------------------------ 收款码

/// 收款码图片上限：二维码本身很小，512 KB 足够。
const MAX_QR_BYTES: usize = 512 * 1024;

#[derive(Debug, serde::Deserialize)]
pub struct ChannelQuery {
    /// 渠道名：alipay / wechat / 任意自定义（不写死枚举）。
    pub channel: String,
    pub label: Option<String>,
}

/// 上传自己的收款码：**认证开发者及以上**（沿用「能发资源帖」这条既有权限，不新加枚举）。
pub async fn payment_channel_add(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<ChannelQuery>,
    body: axum::body::Body,
) -> AppResult<Response> {
    let user = crate::routes::require_user(&state, &headers).await?;
    // 收款码是财产相关动作：认证开发者及以上（与「发资源帖」的开放口径分开）
    session::guard(
        Some(&user),
        sc2clud_core::auth::Permission::SetPaymentChannel,
    )?;
    let token = headers
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    session::check_csrf(&user, token)?;

    let channel = query.channel.trim();
    if channel.is_empty() || channel.chars().count() > 24 {
        return Err(AppError::Domain(sc2clud_core::Error::InvalidInput(
            "渠道名必填，且不超过 24 个字符".to_string(),
        )));
    }
    let label = query.label.unwrap_or_default();
    let label: String = label.trim().chars().take(24).collect();

    let bytes = axum::body::to_bytes(body, MAX_QR_BYTES)
        .await
        .map_err(|e| {
            AppError::Domain(sc2clud_core::Error::InvalidInput(format!(
                "收款码读取失败或超过 512 KB：{e}"
            )))
        })?;
    let mime = crate::routes::sniff_image_mime(&bytes).ok_or_else(|| {
        AppError::Domain(sc2clud_core::Error::InvalidInput(
            "收款码只接受 PNG / JPEG / GIF / WebP".to_string(),
        ))
    })?;
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
    let now = sc2clud_core::now_unix();
    repo::ensure_blob(state.db.pool(), &hash, size, now).await?;
    let id = repo::add_payment_channel(state.db.pool(), user.id, channel, &label, &hash, mime, now)
        .await?;
    tracing::info!(user.id = user.id, channel, image.id = id, "新增收款码");
    Ok(axum::Json(
        serde_json::json!({ "id": id, "channel": channel, "label": label, "url": format!("/img/{hash}") }),
    )
    .into_response())
}

/// 删除自己的收款码（引用归零时顺带回收文件）。
pub async fn payment_channel_delete(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let user = crate::routes::require_user(&state, &headers).await?;
    let token = headers
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    session::check_csrf(&user, token)?;
    let Some(hash) = repo::delete_payment_channel(state.db.pool(), user.id, id).await? else {
        return Err(AppError::not_found("没有这个收款码"));
    };
    if let Ok(parsed) = sc2clud_core::BlobHash::parse(&hash)
        && let Err(e) = state.storage.delete(&parsed).await
    {
        tracing::warn!(blob = %hash, error = %e, "回收收款码内容失败（先记着）");
    }
    Ok(axum::Json(serde_json::json!({ "ok": true })).into_response())
}

/// 公开读取某人的收款渠道（主页展示用）。
pub async fn payment_channels_json(
    State(state): State<AppState>,
    Path(handle): Path<String>,
) -> AppResult<Response> {
    let Some(owner) = repo::find_user_by_handle(state.db.pool(), &handle).await? else {
        return Err(AppError::not_found("没有这个用户"));
    };
    let rows = repo::list_payment_channels(state.db.pool(), owner.id).await?;
    let channels: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.id,
                "channel": row.channel,
                "label": row.label,
                "url": format!("/img/{}", row.image_hash),
            })
        })
        .collect();
    Ok(axum::Json(serde_json::json!({ "channels": channels })).into_response())
}

/// 当前登录者的头像摘要；不暴露其他账号资料或会话信息。
pub async fn avatar_info(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let user = crate::routes::require_user(&state, &headers).await?;
    Ok(avatar_metadata(&user))
}

fn avatar_metadata(user: &session::CurrentUser) -> Response {
    (
        [
            (header::CACHE_CONTROL, "private, no-store"),
            (header::VARY, "Cookie"),
        ],
        axum::Json(serde_json::json!({"avatar_hash": user.avatar_hash})),
    )
        .into_response()
}

/// `/me` → 自己的主页（不认识 handle 也能直达）。
pub async fn me(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match session::current_user(&state, &headers).await {
        Ok(Some(user)) => Redirect::to(&format!("/u/{}", user.handle)).into_response(),
        Ok(None) => Redirect::to("/login").into_response(),
        Err(e) => e.into_response(),
    }
}

#[derive(Debug, serde::Deserialize)]
pub struct ProfileQuery {
    /// 预览用的头部样式编号（1/2/3）。
    pui: Option<String>,
    /// 预览用的头衔样式编号（1 胶囊 / 2 徽章 / 3 下划线）。
    tui: Option<String>,
}

pub async fn profile(
    State(state): State<AppState>,
    Path(handle): Path<String>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<ProfileQuery>,
) -> Response {
    match build_profile(
        &state,
        &handle,
        &headers,
        query.pui.as_deref(),
        query.tui.as_deref(),
    )
    .await
    {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

async fn build_profile<'a>(
    state: &'a AppState,
    handle: &str,
    headers: &HeaderMap,
    pui: Option<&str>,
    tui: Option<&str>,
) -> AppResult<ProfileTemplate<'a>> {
    let viewer = session::current_user(state, headers).await?;
    let owner = repo::find_user_by_handle(state.db.pool(), handle)
        .await?
        .ok_or_else(|| AppError::not_found("没有这个用户"))?;
    let is_self = viewer.as_ref().is_some_and(|v| v.id == owner.id);
    let is_staff = viewer.as_ref().is_some_and(session::CurrentUser::is_staff);
    // 未通过的帖子只有本人与管理员看得到（与首页同一套规则）
    let posts =
        repo::list_posts_by_author(state.db.pool(), owner.id, is_self || is_staff, 50).await?;
    let accepted = posts
        .iter()
        .filter(|p| p.review_state == "approved")
        .count() as i64;
    let role = Role::parse(&owner.role).unwrap_or(Role::Member);
    let showcase = repo::author_showcase(state.db.pool(), owner.id).await?;
    let donation_notice = if showcase.donation_visible {
        repo::donation_notice_for(state.db.pool(), owner.id, &showcase.channels).await?
    } else {
        None
    };
    let (bio_text, bio_state, _) = repo::user_bio(state.db.pool(), owner.id).await?;
    // 未通过的简介不给访客看（本人与管理员照常可见）
    let bio_visible = bio_state == "approved" || is_self || is_staff;
    let header_variant = if state.config.server.debug_pages {
        pui.and_then(|v| v.parse::<u8>().ok())
            .filter(|v| (1..=3).contains(v))
            .unwrap_or(2)
    } else {
        2
    };
    // 没写（或未过审而访客看不到）时显示默认文案 —— 文案本身超管可在后台改
    let default_bio = repo::site_text(
        state.db.pool(),
        "default_bio",
        sc2clud_core::community::DEFAULT_BIO,
    )
    .await?;
    let shown_bio = if bio_visible && !bio_text.trim().is_empty() {
        bio_text
    } else if bio_visible {
        default_bio
    } else {
        String::new()
    };
    let title = repo::equipped_title_for(state.db.pool(), owner.id)
        .await?
        .map(|t| crate::templates::TitleBadgeView {
            name: t.name,
            color: t.color,
        });
    let title_variant = if state.config.server.debug_pages {
        tui.and_then(|v| v.parse::<u8>().ok())
            .filter(|v| (1..=3).contains(v))
            .unwrap_or(1)
    } else {
        1
    };
    Ok(ProfileTemplate {
        title,
        title_variant,
        can_edit_bio: is_self || is_staff,
        bio: (!shown_bio.trim().is_empty()).then_some(shown_bio),
        bio_state,
        header_variant,
        // 与帖子页定版一致：赞助样式 1（左渠道右二维码）+ 提示样式 3（红圆图标卡）
        donate_variant: 1,
        notice_variant: 3,
        donation_visible: showcase.donation_visible && !showcase.channels.is_empty(),
        donation_channels: showcase
            .channels
            .iter()
            .map(|c| crate::templates::DonationChannelView {
                id: c.id,
                channel: c.channel.clone(),
                label: if c.label.trim().is_empty() {
                    c.channel.clone()
                } else {
                    c.label.clone()
                },
                image_hash: c.image_hash.clone(),
            })
            .collect(),
        donation_notice,
        site_name: &state.config.server.site_name,
        user_label: viewer.as_ref().map(|v| v.display_name.clone()),
        is_staff,
        csrf: viewer
            .as_ref()
            .map(|v| v.csrf_token.clone())
            .unwrap_or_default(),
        handle: owner.handle.clone(),
        display_name: if owner.display_name.trim().is_empty() {
            owner.handle.clone()
        } else {
            owner.display_name.clone()
        },
        role_label: role.label().to_string(),
        avatar: owner.avatar_hash.clone(),
        joined_at: format_date(owner.created_at),
        is_self,
        blocked: match viewer.as_ref() {
            Some(v) if v.id != owner.id => {
                repo::blocked_between(state.db.pool(), v.id, owner.id).await?
            }
            _ => false,
        },
        can_interact: viewer
            .as_ref()
            .is_some_and(|v| v.id != owner.id && v.activated),
        can_edit_avatar: is_self || is_staff,
        accepted,
        posts: posts
            .iter()
            .map(|row| feed_view(row, viewer.as_ref().map(|v| v.id)))
            .collect(),
    })
}

/// 头像读取：只服务**被某个账号登记过**的内容，内容寻址所以可长缓存。
pub async fn serve_avatar(
    State(state): State<AppState>,
    Path(raw_hash): Path<String>,
) -> AppResult<Response> {
    let hash = sc2clud_core::BlobHash::parse(&raw_hash)?;
    if !repo::avatar_is_used(state.db.pool(), hash.as_str()).await? {
        return Err(AppError::not_found("头像不存在"));
    }
    if state.storage.stat(&hash).await?.is_none() {
        return Err(AppError::not_found("头像不存在"));
    }
    let mime = repo::avatar_mime(state.db.pool(), hash.as_str())
        .await?
        .unwrap_or_else(|| "image/webp".to_string());

    if !state.config.server.serve_blobs_locally {
        let kind = match mime.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpeg",
            "image/gif" => "gif",
            _ => "webp",
        };
        let location = format!(
            "{}/{}/{}",
            state.config.download.image_prefix.trim_end_matches('/'),
            kind,
            hash.relative_path()
        );
        return Ok((
            StatusCode::OK,
            [(
                header::HeaderName::from_static("x-accel-redirect"),
                location.as_str(),
            )],
        )
            .into_response());
    }

    let reader = state.storage.get_stream(&hash).await?;
    let stream = tokio_util::io::ReaderStream::new(reader);
    let mut response = Response::new(axum::body::Body::from_stream(stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(&mime)
            .unwrap_or_else(|_| header::HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("public, max-age=86400"),
    );
    Ok(response)
}

#[cfg(test)]
mod avatar_menu_tests {
    use super::*;

    #[tokio::test]
    async fn avatar_metadata_is_private_and_contains_only_the_current_avatar() {
        let user = session::CurrentUser {
            id: 42,
            handle: "menu_test".into(),
            display_name: "测试用户".into(),
            avatar_hash: Some("a".repeat(64)),
            trusted: false,
            role: Role::Member,
            activated: true,
            csrf_token: "不应泄露".into(),
        };
        let response = avatar_metadata(&user);
        assert_eq!(
            response.headers()[header::CACHE_CONTROL],
            "private, no-store"
        );
        assert_eq!(response.headers()[header::VARY], "Cookie");
        let bytes = axum::body::to_bytes(response.into_body(), 2048)
            .await
            .unwrap();
        let data: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(data, serde_json::json!({"avatar_hash": "a".repeat(64)}));
    }
}
