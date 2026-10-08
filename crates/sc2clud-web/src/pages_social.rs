//! 点赞、收藏、通知、系统公告、数据备份。

use axum::Form;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use serde::Deserialize;

use sc2clud_core::auth::Permission;
use sc2clud_core::now_unix;
use sc2clud_db::repo;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::routes::require_user;
use crate::session;
use crate::templates::{
    AnnouncementView, AnnouncementsTemplate, BookmarkView, BookmarksTemplate, NotificationView,
    NotificationsTemplate, format_date, format_relative, render,
};

#[derive(Debug, Deserialize)]
pub struct CsrfOnly {
    pub csrf: String,
}

#[derive(Debug, Deserialize)]
pub struct AnnouncementForm {
    pub csrf: String,
    pub title: String,
    pub body: String,
}

fn json_ok(message: &str, extra: serde_json::Value) -> Response {
    let mut payload = serde_json::json!({ "ok": true, "message": message });
    if let (Some(map), Some(extra)) = (payload.as_object_mut(), extra.as_object()) {
        for (k, v) in extra {
            map.insert(k.clone(), v.clone());
        }
    }
    (axum::http::StatusCode::OK, axum::Json(payload)).into_response()
}

/// 点赞开关。给自己点赞不产生提醒。
pub async fn toggle_like(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<CsrfOnly>,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::Comment)?;
    session::check_csrf(&user, &form.csrf)?;
    let Some(post) =
        repo::get_post_for(state.db.pool(), id, Some(user.id), user.is_staff()).await?
    else {
        return Err(AppError::not_found("帖子不存在或不可见"));
    };
    let now = now_unix();
    let liked = repo::toggle_like(state.db.pool(), id, user.id, now).await?;
    if liked && post.author_id != user.id {
        let _ = repo::notify(
            state.db.pool(),
            post.author_id,
            "like",
            &format!("{} 赞了你的帖子", user.display_name),
            Some(&post.title),
            Some(&format!("/p/{id}")),
            now,
        )
        .await;
    }
    let count = repo::post_like_count(state.db.pool(), id).await?;
    Ok(json_ok(
        if liked {
            "已点赞"
        } else {
            "已取消点赞"
        },
        serde_json::json!({ "liked": liked, "count": count }),
    ))
}

/// 收藏开关。
pub async fn toggle_bookmark(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<CsrfOnly>,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::Comment)?;
    session::check_csrf(&user, &form.csrf)?;
    if repo::get_post_for(state.db.pool(), id, Some(user.id), user.is_staff())
        .await?
        .is_none()
    {
        return Err(AppError::not_found("帖子不存在或不可见"));
    }
    let marked = repo::toggle_bookmark(state.db.pool(), id, user.id, now_unix()).await?;
    Ok(json_ok(
        if marked {
            "已收藏"
        } else {
            "已取消收藏"
        },
        serde_json::json!({ "bookmarked": marked }),
    ))
}

/// 我的收藏。
pub async fn bookmarks(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match build_bookmarks(&state, &headers).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

async fn build_bookmarks<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
) -> AppResult<BookmarksTemplate<'a>> {
    let user = require_user(state, headers).await?;
    let now = now_unix();
    let items = repo::list_bookmarks(state.db.pool(), user.id, 200)
        .await?
        .into_iter()
        .map(|row| BookmarkView {
            id: row.post_id,
            title: row.title,
            section_label: sc2clud_core::resource::PostSection::parse(&row.section)
                .unwrap_or(sc2clud_core::resource::PostSection::default_section())
                .label()
                .to_string(),
            when: format_relative(row.saved_at, now),
        })
        .collect();
    Ok(BookmarksTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        is_staff: user.is_staff(),
        csrf: user.csrf_token.clone(),
        items,
    })
}

/// 通知中心（打开即标记已读）。
pub async fn notifications(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match build_notifications(&state, &headers).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

async fn build_notifications<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
) -> AppResult<NotificationsTemplate<'a>> {
    let user = require_user(state, headers).await?;
    let now = now_unix();
    let rows = repo::list_notifications(state.db.pool(), user.id, 100).await?;
    let items = rows
        .into_iter()
        .map(|row| NotificationView {
            kind: row.kind,
            title: row.title,
            body: row.body.unwrap_or_default(),
            link: row.link,
            when: format_relative(row.created_at, now),
            unread: row.read_at.is_none(),
        })
        .collect();
    let _ = repo::mark_notifications_read(state.db.pool(), user.id, now).await;
    Ok(NotificationsTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        is_staff: user.is_staff(),
        csrf: user.csrf_token.clone(),
        items,
    })
}

/// 未读通知数（顶栏红点用，前端定时问一次）。
pub async fn unread_badge(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let Some(user) = session::current_user(&state, &headers).await? else {
        return Ok(json_ok("", serde_json::json!({ "unread": 0 })));
    };
    let unread = repo::unread_notification_count(state.db.pool(), user.id).await?;
    Ok(json_ok("", serde_json::json!({ "unread": unread })))
}

/// 系统公告列表（所有人可见）。
pub async fn announcements(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match build_announcements(&state, &headers).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

async fn build_announcements<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
) -> AppResult<AnnouncementsTemplate<'a>> {
    let user = session::current_user(state, headers).await?;
    let items = repo::list_announcements(state.db.pool(), 50)
        .await?
        .into_iter()
        .map(|row| AnnouncementView {
            title: row.title,
            body: row.body,
            when: format_date(row.created_at),
        })
        .collect();
    Ok(AnnouncementsTemplate {
        site_name: &state.config.server.site_name,
        user_label: user.as_ref().map(|u| u.display_name.clone()),
        is_staff: user.as_ref().is_some_and(session::CurrentUser::is_staff),
        csrf: user.map(|u| u.csrf_token.clone()).unwrap_or_default(),
        items,
    })
}

/// 发布系统公告（管理员及以上），并给所有人发一条通知。
pub async fn create_announcement(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<AnnouncementForm>,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::ManageUsers)?;
    session::check_csrf(&user, &form.csrf)?;
    let title = form.title.trim();
    let body = form.body.trim();
    if title.is_empty() || body.is_empty() {
        return Err(AppError::Domain(sc2clud_core::Error::InvalidInput(
            "公告标题与正文都要填".to_string(),
        )));
    }
    let now = now_unix();
    let id = repo::create_announcement(state.db.pool(), title, body, user.id, now).await?;
    let sent = repo::notify_all(
        state.db.pool(),
        "announcement",
        &format!("系统公告：{title}"),
        Some(body),
        Some("/announcements"),
        now,
    )
    .await?;
    tracing::info!(
        announcement.id = id,
        notified = sent,
        actor.id = user.id,
        "发布系统公告"
    );
    let _ = repo::record_audit(
        state.db.pool(),
        Some(user.id),
        "announcement.create",
        Some(&format!("announcement:{id}")),
        Some(title),
        now,
    )
    .await;
    Ok(Redirect::to("/announcements").into_response())
}

// ------------------------------------------------------------ 备份与导出

/// 备份目录：跟随数据目录，便于一起搬走。
fn backup_dir(state: &AppState) -> std::path::PathBuf {
    state.config.paths.data_dir.join("backups")
}

fn safe_name(name: &str) -> bool {
    !name.is_empty() && name.len() < 128 && !name.contains(['/', '\\']) && !name.contains("..")
}

/// 备份页（仅超级管理员）。
pub async fn backup_page(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match build_backup(&state, &headers).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

async fn build_backup<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
) -> AppResult<crate::templates::BackupTemplate<'a>> {
    let user = require_user(state, headers).await?;
    session::guard(Some(&user), Permission::ManageRoles)?;
    let dir = backup_dir(state);
    let mut files: Vec<crate::templates::BackupFileView> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let meta = match entry.metadata() {
                Ok(meta) if meta.is_file() => meta,
                _ => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| format_date(d.as_secs() as i64))
                .unwrap_or_default();
            files.push(crate::templates::BackupFileView {
                name,
                size: crate::templates::human_bytes(meta.len()),
                modified,
            });
        }
    }
    files.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(crate::templates::BackupTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        is_staff: true,
        csrf: user.csrf_token.clone(),
        files,
        dir: dir.display().to_string(),
    })
}

/// 立即创建一份备份：整库快照（VACUUM INTO）+ 用户数据 JSON 导出。
pub async fn create_backup(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<CsrfOnly>,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::ManageRoles)?;
    session::check_csrf(&user, &form.csrf)?;

    let dir = backup_dir(&state);
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal(format!("建备份目录失败：{e}")))?;
    let now = now_unix();
    let stamp = now.to_string();
    // VACUUM INTO 要求目标文件不存在
    let snapshot = dir.join(format!("{stamp}-sc2clud.sqlite3"));
    repo::backup_to(state.db.pool(), &snapshot.display().to_string()).await?;

    // 用户数据导出（给「备份当前网站用户数据」用；不含口令哈希）
    let rows = repo::admin_list_users(state.db.pool(), "", 10_000).await?;
    let export: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.id,
                "handle": row.handle,
                "display_name": row.display_name,
                "email": row.email,
                "role": row.role,
                "activated": row.activated_at.is_some(),
                "created_at": row.created_at,
                "quota_bytes": row.quota_bytes,
                "used_bytes": row.used_bytes,
            })
        })
        .collect();
    let export_path = dir.join(format!("{stamp}-users.json"));
    let text = serde_json::to_string_pretty(&export)
        .map_err(|e| AppError::internal(format!("导出用户数据失败：{e}")))?;
    std::fs::write(&export_path, text)
        .map_err(|e| AppError::internal(format!("写导出文件失败：{e}")))?;

    tracing::info!(actor.id = user.id, %stamp, "创建数据备份");
    let _ = repo::record_audit(
        state.db.pool(),
        Some(user.id),
        "data.backup",
        Some(&stamp),
        None,
        now,
    )
    .await;
    Ok(json_ok(
        "备份完成",
        serde_json::json!({ "snapshot": snapshot.display().to_string(), "export": export_path.display().to_string() }),
    ))
}

/// 下载备份文件（仅超级管理员，文件名白名单校验）。
pub async fn download_backup(
    State(state): State<AppState>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::ManageRoles)?;
    if !safe_name(&name) {
        return Err(AppError::not_found("备份不存在"));
    }
    let path = backup_dir(&state).join(&name);
    if !path.is_file() {
        return Err(AppError::not_found("备份不存在"));
    }
    tracing::warn!(actor.id = user.id, %name, "下载数据备份");
    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|e| AppError::internal(format!("打开备份失败：{e}")))?;
    let stream = tokio_util::io::ReaderStream::new(file);
    let mut response = Response::new(axum::body::Body::from_stream(stream));
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        axum::http::HeaderValue::from_static("application/octet-stream"),
    );
    response.headers_mut().insert(
        axum::http::header::CONTENT_DISPOSITION,
        axum::http::HeaderValue::from_str(&format!("attachment; filename=\"{name}\""))
            .unwrap_or_else(|_| axum::http::HeaderValue::from_static("attachment")),
    );
    Ok(response)
}
