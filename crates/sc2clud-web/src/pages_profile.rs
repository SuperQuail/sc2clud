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
