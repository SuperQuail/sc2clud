//! 帖子页面：详情、回复、发帖。
//!
//! 可见性一律走 `repo::get_post_for`（审核中只有作者与管理员可见），
//! 写操作一律「登录 + 已激活 + CSRF」三道门。

use axum::Form;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use serde::Deserialize;

use sc2clud_core::auth::{Permission, Role};
use sc2clud_core::review::{PostKind, ReviewState, review_for_author};
use sc2clud_core::{Error as DomainError, now_unix};
use sc2clud_db::repo;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::routes::{require_user, wants_html};
use crate::session::{self, CurrentUser};
use crate::templates::{
    CommentView, ImageView, KindOption, NewPostTemplate, PostDetailView, PostPageTemplate,
    format_date, render,
};

#[derive(Debug, Deserialize)]
pub struct ReplyForm {
    pub csrf: String,
    pub body: String,
}

#[derive(Debug, Deserialize)]
pub struct NewPostForm {
    pub csrf: String,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub kind: Option<String>,
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::Domain(DomainError::InvalidInput(msg.into()))
}

fn kind_options(selected: &str) -> Vec<KindOption> {
    PostKind::ALL
        .iter()
        .map(|kind| KindOption {
            value: kind.as_str().to_string(),
            label: kind.label().to_string(),
            hint: match kind {
                PostKind::Discussion => "日常交流".to_string(),
                PostKind::Resource => "原创/首发资源".to_string(),
                PostKind::Repost => "转来的资源".to_string(),
            },
            checked: kind.as_str() == selected,
        })
        .collect()
}

async fn build_post_page<'a>(
    state: &'a AppState,
    id: i64,
    headers: &HeaderMap,
) -> AppResult<PostPageTemplate<'a>> {
    let user = session::current_user(state, headers).await?;
    let viewer_id = user.as_ref().map(|u| u.id);
    let is_staff = user.as_ref().is_some_and(CurrentUser::is_staff);

    let row = repo::get_post_for(state.db.pool(), id, viewer_id, is_staff)
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在或不可见"))?;
    let author = repo::find_user_by_id_any(state.db.pool(), row.author_id).await?;
    // 对外展示一律用显示名；空值兜底为登录名（存量数据已在迁移里回填）。
    let author_handle = author
        .as_ref()
        .map(|u| {
            if u.display_name.trim().is_empty() {
                u.handle.clone()
            } else {
                u.display_name.clone()
            }
        })
        .unwrap_or_else(|| "未知用户".to_string());
    let author_role = author
        .as_ref()
        .and_then(|u| Role::parse(&u.role).ok())
        .unwrap_or(Role::Member);
    let images = repo::list_post_images(state.db.pool(), id)
        .await?
        .into_iter()
        .map(|img| ImageView {
            // 压缩图就绪就用它，否则先用原图（两者都在内容寻址存储里）。
            href: format!("/img/{}", img.display_hash.unwrap_or(img.original_hash)),
        })
        .collect();
    let comments = repo::list_comments(state.db.pool(), id, 200).await?;

    let state_ = ReviewState::parse(&row.review_state).unwrap_or(ReviewState::Pending);
    let kind = PostKind::parse(&row.kind).unwrap_or(PostKind::Discussion);

    Ok(PostPageTemplate {
        site_name: &state.config.server.site_name,
        user_label: user.as_ref().map(|u| u.display_name.clone()),
        csrf: user
            .as_ref()
            .map(|u| u.csrf_token.clone())
            .unwrap_or_default(),
        can_reply: user.as_ref().is_some_and(|u| u.activated),
        is_staff,
        images,
        post: PostDetailView {
            id: row.id,
            title: row.title.clone(),
            body: row.body.clone(),
            kind: kind.as_str().to_string(),
            kind_label: kind.label().to_string(),
            state: state_.as_str().to_string(),
            state_label: state_.label().to_string(),
            review_note: row.review_note.clone(),
            author: author_handle,
            author_role_label: author_role.label().to_string(),
            created_at: format_date(row.created_at),
            image_count: row.image_count,
            is_mine: viewer_id == Some(row.author_id),
        },
        comments: comments
            .into_iter()
            .map(|c| CommentView {
                author: c.author_display_name,
                body: c.body,
                created_at: format_date(c.created_at),
            })
            .collect(),
    })
}

pub async fn post_page(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    match build_post_page(&state, id, &headers).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(wants_html(&headers)),
    }
}

pub async fn comment_submit(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<ReplyForm>,
) -> Response {
    match add_comment(&state, id, &headers, &form).await {
        Ok(()) => Redirect::to(&format!("/p/{id}")).into_response(),
        Err(e) => e.into_page_response(true),
    }
}

async fn add_comment(
    state: &AppState,
    post_id: i64,
    headers: &HeaderMap,
    form: &ReplyForm,
) -> AppResult<()> {
    let user = require_user(state, headers).await?;
    session::guard(Some(&user), Permission::Comment)?;
    session::check_csrf(&user, &form.csrf)?;

    let body = form.body.trim();
    if body.chars().count() < 2 {
        return Err(invalid("回复至少 2 个字"));
    }
    if body.chars().count() > 5_000 {
        return Err(invalid("回复最长 5000 字"));
    }
    // 只能在**自己看得到**的帖子下回复。
    repo::get_post_for(state.db.pool(), post_id, Some(user.id), user.is_staff())
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在或不可见"))?;

    repo::create_comment(state.db.pool(), post_id, user.id, body, now_unix()).await?;
    state.counters.bump("comment:created", 1);
    tracing::info!(post.id = post_id, user.id = user.id, "新增回复");
    Ok(())
}

pub async fn new_post_form(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let user = match session::current_user(&state, &headers).await {
        Ok(Some(user)) => user,
        Ok(None) => return Redirect::to("/login").into_response(),
        Err(e) => return e.into_response(),
    };
    let error = if user.activated {
        None
    } else {
        Some("账号尚未激活，暂时不能发帖".to_string())
    };
    render(NewPostTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(user.handle.clone()),
        csrf: user.csrf_token.clone(),
        error,
        kinds: kind_options("discussion"),
        title: "",
        body: "",
    })
}

pub async fn new_post_submit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<NewPostForm>,
) -> Response {
    let user = match session::current_user(&state, &headers).await {
        Ok(Some(user)) => user,
        Ok(None) => return Redirect::to("/login").into_response(),
        Err(e) => return e.into_response(),
    };

    let kind_raw = form.kind.as_deref().unwrap_or("discussion");
    let kind = PostKind::parse(kind_raw).unwrap_or(PostKind::Discussion);
    let title = form.title.trim().to_string();
    let body = form.body.trim().to_string();

    let checked = session::guard(Some(&user), kind.required_permission())
        .and_then(|()| session::check_csrf(&user, &form.csrf));
    let outcome = match checked {
        Ok(()) => review_for_author(Some(user.role), kind, &title, &body, 0),
        Err(e) => {
            return render(NewPostTemplate {
                site_name: &state.config.server.site_name,
                user_label: Some(user.display_name.clone()),
                csrf: user.csrf_token.clone(),
                error: Some(e.parts().2),
                kinds: kind_options(kind.as_str()),
                title: &title,
                body: &body,
            });
        }
    };
    if !outcome.state.visible_to(true, true) {
        return render(NewPostTemplate {
            site_name: &state.config.server.site_name,
            user_label: Some(user.display_name.clone()),
            csrf: user.csrf_token.clone(),
            error: Some(format!(
                "审核未通过：{}",
                outcome.note.as_deref().unwrap_or("内容不符合规范")
            )),
            kinds: kind_options(kind.as_str()),
            title: &title,
            body: &body,
        });
    }

    let now = now_unix();
    let id = match repo::create_post_reviewed(
        state.db.pool(),
        repo::NewPost {
            author_id: user.id,
            kind: kind.as_str(),
            title: &title,
            body: &body,
            image_count: 0,
            review_state: outcome.state.as_str(),
            review_note: outcome.note.as_deref(),
            now,
        },
    )
    .await
    {
        Ok(id) => id,
        Err(e) => return AppError::from(e).into_response(),
    };
    state.counters.bump("post:created", 1);
    tracing::info!(
        post.id = id,
        kind = kind.as_str(),
        state = outcome.state.as_str(),
        "发帖"
    );
    Redirect::to(&format!("/p/{id}")).into_response()
}
