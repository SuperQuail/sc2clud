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

pub async fn profile(
    State(state): State<AppState>,
    Path(handle): Path<String>,
    headers: HeaderMap,
) -> Response {
    match build_profile(&state, &handle, &headers).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

async fn build_profile<'a>(
    state: &'a AppState,
    handle: &str,
    headers: &HeaderMap,
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
    Ok(ProfileTemplate {
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
