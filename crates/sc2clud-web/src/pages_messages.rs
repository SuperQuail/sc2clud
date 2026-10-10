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
    let (other, _) = deliver_message(&state, &user, &handle, &form.body).await?;
    // 老表单提交的兜底：直接落到消息中心并选中该会话（JS 可用时走 /api/v1 不跳页）
    Ok(Redirect::to(&format!("/inbox?tab=dm&with={}", other.handle)).into_response())
}

/// 投递一条私信（表单与 JSON 两条路共用）：返回 (对方, 新消息 id)。
async fn deliver_message(
    state: &AppState,
    user: &crate::session::CurrentUser,
    handle: &str,
    raw_body: &str,
) -> AppResult<(sc2clud_db::UserRow, i64)> {
    let other = find_other(state, handle).await?;
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
    let body = validate_message_body(raw_body)?;
    let now = now_unix();
    let id = repo::send_message(state.db.pool(), user.id, other.id, &body, now).await?;
    let _ = repo::notify(
        state.db.pool(),
        repo::NewNotification {
            user_id: other.id,
            actor_id: Some(user.id),
            kind: "message",
            title: &format!("{} 给你发了私信", user.display_name),
            body: Some(body.chars().take(60).collect::<String>().as_str()),
            link: Some(&format!("/inbox?tab=dm&with={}", user.handle)),
            now,
        },
    )
    .await;
    state.counters.bump("message:sent", 1);
    tracing::info!(from.id = user.id, to.id = other.id, "发送私信");
    Ok((other, id))
}

#[derive(Debug, serde::Deserialize)]
pub struct ThreadQuery {
    /// 只要 id 大于它的消息（前端轮询用）。
    after: Option<i64>,
}

/// 收信轮询：返回该会话里比 `after` 新的消息（前端每 5 秒拉一次）。
pub async fn thread_json(
    State(state): State<AppState>,
    Path(handle): Path<String>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<ThreadQuery>,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    let other = find_other(&state, &handle).await?;
    let after = query.after.unwrap_or(0);
    let rows = repo::list_thread(state.db.pool(), user.id, other.id, 100).await?;
    // 小站数据量下直接取全量再过滤，不值得为轮询单写一条 SQL
    let messages: Vec<serde_json::Value> = rows
        .into_iter()
        .filter(|row| row.id > after)
        .map(|row| {
            serde_json::json!({
                "id": row.id,
                "mine": row.sender_id == user.id,
                "body": row.body,
                "date": crate::templates::format_date(row.created_at),
            })
        })
        .collect();
    Ok(axum::Json(serde_json::json!({ "messages": messages })).into_response())
}
#[derive(Debug, serde::Deserialize)]
pub struct JsonSendForm {
    body: String,
}

/// 消息中心底部输入框用：JSON 发信，不跳页（成功返回新消息，前端就地追加气泡）。
pub async fn send_json(
    State(state): State<AppState>,
    Path(handle): Path<String>,
    headers: HeaderMap,
    axum::Json(form): axum::Json<JsonSendForm>,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::Comment)?;
    let token = headers
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    session::check_csrf(&user, token)?;
    let (_, id) = deliver_message(&state, &user, &handle, &form.body).await?;
    Ok(axum::Json(serde_json::json!({
        "ok": true,
        "id": id,
        "body": form.body.trim(),
    }))
    .into_response())
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
    /// 分类：dm（我的消息）/ likes（收到的赞）/ system（系统通知）。
    tab: Option<String>,
    /// 预览用：删除确认版式。
    dv: Option<String>,
    /// 选中的会话对方 handle。
    with: Option<String>,
    /// 选中的通知 id。
    nid: Option<String>,
}

/// 消息中心（照 B 站私信页做：左分类 / 中列表 / 右内容 + 底部输入）。
/// 只做我们真有的东西：私信、收到的赞、系统通知；B 站的「回复我的 / @我的」我们没有，不放。
pub async fn center(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(params): axum::extract::Query<InboxParams>,
) -> AppResult<Response> {
    let user = crate::routes::require_user(&state, &headers).await?;
    let tab = params.tab.unwrap_or_else(|| "dm".to_string());
    let selected = params.with.clone().unwrap_or_default();
    // 已评审通过的是 v2（居中弹窗确认）
    let delete_variant = if state.config.server.debug_pages {
        params
            .dv
            .as_deref()
            .and_then(|v| v.parse::<u8>().ok())
            .filter(|v| (1..=3).contains(v))
            .unwrap_or(2)
    } else {
        2
    };
    // 没头像的用户随机分一个默认头像（分过就固定）
    let _ = repo::ensure_default_avatar(state.db.pool(), user.id).await;

    // 左栏「我的消息」：会话列表（最近消息在前）
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

    // 通知按 kind 分到「收到的赞」和「系统通知」两栏
    let selected_nid: Option<i64> = params.nid.as_deref().and_then(|v| v.parse().ok());
    let mut likes = Vec::new();
    let mut system = Vec::new();
    let mut selected_notice = None;
    let mut like_unread = 0i64;
    let mut system_unread = 0i64;
    for row in repo::list_notifications(state.db.pool(), user.id, 100).await? {
        let actor = row.actor_display_name.clone().unwrap_or_default();
        let kind = row.kind.clone();
        let view = crate::templates::InboxNoticeView {
            id: row.id,
            kind: kind.clone(),
            avatar: row.actor_avatar.clone(),
            actor_names: if actor.is_empty() {
                Vec::new()
            } else {
                vec![actor]
            },
            count: 1,
            more: false,
            title: row.title,
            body: row.body.unwrap_or_default(),
            link: row.link.unwrap_or_default(),
            date: crate::templates::format_date(row.created_at),
            unread: row.read_at.is_none(),
            active: selected_nid == Some(row.id),
        };
        if selected_nid == Some(view.id) {
            selected_notice = Some(view.clone());
        }
        let unread = view.unread;
        if row.kind == "like" {
            if unread {
                like_unread += 1;
            }
            likes.push(view);
        } else {
            if unread {
                system_unread += 1;
            }
            system.push(view);
        }
    }

    // 右栏：私信线程（选中会话时）；顺带标记已读
    // 自己的头像：没有就用手气里分到的默认头像（气泡旁边也要有头像）
    let my_avatar = match user.avatar_hash.clone() {
        Some(hash) => Some(hash),
        None => repo::ensure_default_avatar(state.db.pool(), user.id)
            .await
            .ok()
            .flatten(),
    };
    let mut other_display = String::new();
    let mut other_avatar = None;
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
        other_avatar = other.avatar_hash.clone();
        let rows = repo::list_thread(state.db.pool(), user.id, other.id, 100).await?;
        let mut last_day = String::new();
        for row in rows {
            let day = crate::templates::format_date(row.created_at);
            let show_date = day != last_day;
            last_day = day.clone();
            thread.push(crate::templates::InboxMessageView {
                id: row.id,
                mine: row.sender_id == user.id,
                body: row.body,
                date: day,
                show_date,
            });
        }
        let _ =
            repo::mark_thread_read(state.db.pool(), user.id, other.id, sc2clud_core::now_unix())
                .await;
    }

    // 收到的赞按「同一条内容」聚合（B 站那种「A、B 等总计 N 人赞了…」）
    let mut grouped: Vec<crate::templates::InboxNoticeView> = Vec::new();
    for view in likes {
        let key = view.link.clone();
        match grouped.iter_mut().find(|g| g.link == key) {
            Some(first) => {
                first.count += 1;
                first.more = first.count as usize > first.actor_names.len();
                for name in view.actor_names {
                    if first.actor_names.len() < 3 && !first.actor_names.contains(&name) {
                        first.actor_names.push(name);
                    }
                }
            }
            None => grouped.push(view),
        }
    }
    let likes = grouped;

    // 中栏展示哪一类列表
    let notices = if tab == "likes" {
        likes
    } else if tab == "system" {
        system
    } else {
        Vec::new()
    };

    Ok(crate::templates::render(InboxTemplate {
        delete_variant,
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        is_staff: user.is_staff(),
        csrf: user.csrf_token.clone(),
        tab,
        conversations,
        selected,
        other_display,
        other_avatar,
        my_avatar,
        thread,
        like_unread,
        system_unread,
        dm_unread: 0,
        notices,
        selected_notice,
    }))
}

#[derive(Debug, Deserialize)]
pub struct NoticeActionForm {
    pub csrf: String,
    /// 操作完回到哪个分类。
    pub tab: Option<String>,
    pub kind: Option<String>,
    pub link: Option<String>,
}

/// 删除一条通知（只对自己隐藏）。
pub async fn notification_delete(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<NoticeActionForm>,
) -> AppResult<Redirect> {
    let user = crate::routes::require_user(&state, &headers).await?;
    session::check_csrf(&user, &form.csrf)?;
    let _ = repo::delete_notification(state.db.pool(), user.id, id, now_unix()).await?;
    let tab = form.tab.unwrap_or_else(|| "system".to_string());
    Ok(Redirect::to(&format!("/inbox?tab={tab}")))
}

/// 不再通知：对这条内容（link）静音；link 为空表示整个类别。
pub async fn notification_mute(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<NoticeActionForm>,
) -> AppResult<Redirect> {
    let user = crate::routes::require_user(&state, &headers).await?;
    session::check_csrf(&user, &form.csrf)?;
    let kind = form.kind.unwrap_or_default();
    let link = form.link.unwrap_or_default();
    repo::mute_notification(state.db.pool(), user.id, &kind, &link, now_unix()).await?;
    let tab = form.tab.unwrap_or_else(|| "system".to_string());
    Ok(Redirect::to(&format!("/inbox?tab={tab}")))
}

/// 老私信列表页 → 消息中心（我的消息）。
pub async fn messages_landing() -> Response {
    Redirect::to("/inbox?tab=dm").into_response()
}

/// 老私信对话页 → 消息中心并选中该会话（发信不受影响，仍走 POST）。
pub async fn thread_landing(Path(handle): Path<String>) -> Response {
    Redirect::to(&format!("/inbox?tab=dm&with={handle}")).into_response()
}

/// 老通知页 → 消息中心（系统通知）。
pub async fn notifications_landing() -> Response {
    Redirect::to("/inbox?tab=system").into_response()
}
