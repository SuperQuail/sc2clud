//! 私信：收件箱、会话、发送；以及拉黑 / 解除拉黑。
//!
//! 规则：双方任一方拉黑即**双向禁止私信**；被拉黑的人也不能在对方的帖子下留言
//! （评论过滤在 `repo::list_comments` 的调用侧完成）。

use axum::Form;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use serde::Deserialize;

use sc2clud_core::auth::Permission;
use sc2clud_core::message::validate_message_body;
use sc2clud_core::{Error as DomainError, now_unix};
use sc2clud_db::repo;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::routes::require_user;
use crate::session;
use crate::templates::{
    ConversationView, InboxTemplate, MessageView, MessagesTemplate, ThreadTemplate, format_date,
    format_relative, render,
};

#[derive(Debug, Deserialize)]
pub struct SendForm {
    pub csrf: String,
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct CsrfOnlyForm {
    pub csrf: String,
}

async fn find_other(state: &AppState, handle: &str) -> AppResult<sc2clud_db::UserRow> {
    repo::find_user_by_handle(state.db.pool(), handle)
        .await?
        .ok_or_else(|| AppError::not_found("没有这个用户"))
}

pub async fn inbox(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match build_inbox(&state, &headers).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

async fn build_inbox<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
) -> AppResult<MessagesTemplate<'a>> {
    let user = require_user(state, headers).await?;
    let now = now_unix();
    let rows = repo::list_conversations(state.db.pool(), user.id).await?;
    let conversations = rows
        .into_iter()
        .map(|row| ConversationView {
            handle: row.other_handle,
            display_name: row.other_display_name,
            avatar: row.other_avatar,
            preview: row.last_body.chars().take(60).collect(),
            when: format_relative(row.last_at, now),
            from_me: row.last_from_me == 1,
            unread: row.unread,
        })
        .collect();
    Ok(MessagesTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        is_staff: user.is_staff(),
        csrf: user.csrf_token.clone(),
        conversations,
    })
}

pub async fn thread(
    State(state): State<AppState>,
    Path(handle): Path<String>,
    headers: HeaderMap,
) -> Response {
    match build_thread(&state, &handle, &headers).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

async fn build_thread<'a>(
    state: &'a AppState,
    handle: &str,
    headers: &HeaderMap,
) -> AppResult<ThreadTemplate<'a>> {
    let user = require_user(state, headers).await?;
    let other = find_other(state, handle).await?;
    let now = now_unix();
    // 打开会话就标记已读（失败不影响阅读）
    let _ = repo::mark_thread_read(state.db.pool(), user.id, other.id, now).await;
    let mut rows = repo::list_thread(state.db.pool(), user.id, other.id, 200).await?;
    rows.reverse();
    let messages = rows
        .into_iter()
        .map(|row| MessageView {
            mine: row.sender_id == user.id,
            body: row.body,
            when: format_date(row.created_at),
            read: row.read_at.is_some(),
        })
        .collect();
    let blocked = repo::blocked_between(state.db.pool(), user.id, other.id).await?;
    Ok(ThreadTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        is_staff: user.is_staff(),
        csrf: user.csrf_token.clone(),
        handle: other.handle.clone(),
        display_name: if other.display_name.trim().is_empty() {
            other.handle.clone()
        } else {
            other.display_name.clone()
        },
        avatar: other.avatar_hash.clone(),
        messages,
        blocked,
    })
}

pub async fn send(
    State(state): State<AppState>,
    Path(handle): Path<String>,
    headers: HeaderMap,
    Form(form): Form<SendForm>,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::Comment)?;
    session::check_csrf(&user, &form.csrf)?;
    let other = find_other(&state, &handle).await?;
    if other.id == user.id {
        return Err(AppError::Domain(DomainError::InvalidInput(
            "不能给自己发私信".to_string(),
        )));
    }
    if repo::blocked_between(state.db.pool(), user.id, other.id).await? {
        return Err(AppError::Domain(DomainError::Forbidden(
            "你们之间有拉黑关系，无法发送私信".to_string(),
        )));
    }
    let body = validate_message_body(&form.body)?;
    let now = now_unix();
    repo::send_message(state.db.pool(), user.id, other.id, &body, now).await?;
    let _ = repo::notify(
        state.db.pool(),
        other.id,
        "message",
        &format!("{} 给你发了私信", user.display_name),
        Some(body.chars().take(60).collect::<String>().as_str()),
        Some(&format!("/messages/{}", user.handle)),
        now,
    )
    .await;
    state.counters.bump("message:sent", 1);
    tracing::info!(from.id = user.id, to.id = other.id, "发送私信");
    Ok(Redirect::to(&format!("/messages/{}", other.handle)).into_response())
}

pub async fn block(
    State(state): State<AppState>,
    Path(handle): Path<String>,
    headers: HeaderMap,
    Form(form): Form<CsrfOnlyForm>,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::Comment)?;
    session::check_csrf(&user, &form.csrf)?;
    let other = find_other(&state, &handle).await?;
    if other.id == user.id {
        return Err(AppError::Domain(DomainError::InvalidInput(
            "不能拉黑自己".to_string(),
        )));
    }
    let now = now_unix();
    if repo::block_user(state.db.pool(), user.id, other.id, now).await? {
        tracing::info!(user.id = user.id, blocked.id = other.id, "加入黑名单");
        let _ = repo::record_audit(
            state.db.pool(),
            Some(user.id),
            "user.block",
            Some(&format!("user:{}", other.id)),
            None,
            now,
        )
        .await;
    }
    Ok(Redirect::to(&format!("/u/{}", other.handle)).into_response())
}

pub async fn unblock(
    State(state): State<AppState>,
    Path(handle): Path<String>,
    headers: HeaderMap,
    Form(form): Form<CsrfOnlyForm>,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::Comment)?;
    session::check_csrf(&user, &form.csrf)?;
    let other = find_other(&state, &handle).await?;
    let now = now_unix();
    if repo::unblock_user(state.db.pool(), user.id, other.id).await? {
        tracing::info!(user.id = user.id, unblocked.id = other.id, "移出黑名单");
        let _ = repo::record_audit(
            state.db.pool(),
            Some(user.id),
            "user.unblock",
            Some(&format!("user:{}", other.id)),
            None,
            now,
        )
        .await;
    }
    Ok(Redirect::to("/settings#blocklist").into_response())
}

#[derive(Debug, serde::Deserialize)]
pub struct InboxParams {
    tab: Option<String>,
    with: Option<String>,
    /// 预览用版式编号。
    iv: Option<String>,
}

/// 消息中心：左分类 + 中列表 + 右消息流（参考 B 站私信页）。
pub async fn center(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(params): axum::extract::Query<InboxParams>,
) -> AppResult<Response> {
    let user = crate::routes::require_user(&state, &headers).await?;
    let tab = params.tab.unwrap_or_else(|| "dm".to_string());
    let inbox_variant = if state.config.server.debug_pages {
        params
            .iv
            .as_deref()
            .and_then(|v| v.parse::<u8>().ok())
            .filter(|v| (1..=3).contains(v))
            .unwrap_or(1)
    } else {
        1
    };
    let selected = params.with.clone().unwrap_or_default();

    let conversations: Vec<crate::templates::InboxConversationView> =
        repo::list_conversations(state.db.pool(), user.id)
            .await?
            .into_iter()
            .map(|row| crate::templates::InboxConversationView {
                active: row.other_handle == selected,
                date: crate::templates::format_date(row.last_at),
                handle: row.other_handle,
                display_name: row.other_display_name,
                avatar: row.other_avatar,
                last_body: row.last_body,
            })
            .collect();
    let notifications: Vec<crate::templates::InboxNotificationView> =
        repo::list_notifications(state.db.pool(), user.id, 50)
            .await?
            .into_iter()
            .map(|row| crate::templates::InboxNotificationView {
                date: crate::templates::format_date(row.created_at),
                unread: row.read_at.is_none(),
                link: row.link.unwrap_or_default(),
                body: row.body.unwrap_or_default(),
                title: row.title,
            })
            .collect();

    // 选中会话的消息流：只读展示；发送仍走既有 /messages/{handle}
    let mut other_display = String::new();
    let mut thread = Vec::new();
    if tab == "dm"
        && !selected.is_empty()
        && let Ok(Some(other)) = repo::find_user_by_handle(state.db.pool(), &selected).await
    {
        other_display = if other.display_name.trim().is_empty() {
            other.handle.clone()
        } else {
            other.display_name.clone()
        };
        thread = repo::list_thread(state.db.pool(), user.id, other.id, 100)
            .await?
            .into_iter()
            .map(|row| crate::templates::InboxMessageView {
                mine: row.sender_id == user.id,
                date: crate::templates::format_date(row.created_at),
                body: row.body,
            })
            .collect();
        let _ =
            repo::mark_thread_read(state.db.pool(), user.id, other.id, sc2clud_core::now_unix())
                .await;
    }

    Ok(crate::templates::render(InboxTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        is_staff: user.is_staff(),
        csrf: user.csrf_token.clone(),
        inbox_variant,
        tab,
        conversations,
        notifications,
        selected,
        other_display,
        thread,
    }))
}
