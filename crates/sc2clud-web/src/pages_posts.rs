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
use sc2clud_core::resource::{
    PostSection, ResourceProvider, github_mirrors, validate_extract_code, validate_resource_url,
};
use sc2clud_core::review::{PostKind, ReviewState, review_for_author};
use sc2clud_core::{Error as DomainError, now_unix};
use sc2clud_db::repo;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::routes::{require_user, wants_html};
use crate::session::{self, CurrentUser};
use crate::templates::{
    CommentView, EditPostTemplate, ImageView, KindOption, MirrorView, NewPostTemplate,
    PostDetailView, PostPageTemplate, ProviderOption, SectionOption, SourceSlot, SourceView,
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
    #[serde(default)]
    pub section: Option<String>,
    // 三个下载来源槽位；url 为空即忽略该槽
    #[serde(default)]
    pub provider1: String,
    #[serde(default)]
    pub url1: String,
    #[serde(default)]
    pub code1: String,
    #[serde(default)]
    pub provider2: String,
    #[serde(default)]
    pub url2: String,
    #[serde(default)]
    pub code2: String,
    #[serde(default)]
    pub provider3: String,
    #[serde(default)]
    pub url3: String,
    #[serde(default)]
    pub code3: String,
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::Domain(DomainError::InvalidInput(msg.into()))
}

fn section_options(selected: &str, user: Option<&CurrentUser>) -> Vec<SectionOption> {
    PostSection::ALL
        .iter()
        .filter(|section| crate::session::allows_for(user, section.required_permission()))
        .map(|section| SectionOption {
            value: section.as_str().to_string(),
            label: section.label().to_string(),
            checked: section.as_str() == selected,
        })
        .collect()
}

fn provider_options() -> Vec<ProviderOption> {
    ResourceProvider::ALL
        .iter()
        .map(|provider| ProviderOption {
            value: provider.as_str().to_string(),
            label: provider.label().to_string(),
        })
        .collect()
}

fn empty_slots() -> Vec<SourceSlot> {
    (1..=3)
        .map(|index| SourceSlot {
            index,
            url: String::new(),
            code: String::new(),
            provider: ResourceProvider::BaiduPan.as_str().to_string(),
        })
        .collect()
}

/// 从表单里取下载来源；url 为空的槽直接跳过。
fn form_sources(form: &NewPostForm) -> AppResult<Vec<(ResourceProvider, String, Option<String>)>> {
    let slots = [
        (&form.provider1, &form.url1, &form.code1),
        (&form.provider2, &form.url2, &form.code2),
        (&form.provider3, &form.url3, &form.code3),
    ];
    let mut out = Vec::new();
    for (provider_raw, url_raw, code_raw) in slots {
        if url_raw.trim().is_empty() {
            continue;
        }
        let provider =
            ResourceProvider::parse(provider_raw.trim()).unwrap_or(ResourceProvider::Direct);
        let url = validate_resource_url(url_raw)?;
        let code = validate_extract_code(code_raw)?;
        out.push((provider, url, code));
    }
    Ok(out)
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
    // 下载来源：资源帖的核心信息；GitHub 来源附带镜像候选。
    let sources = repo::list_post_sources(state.db.pool(), id)
        .await?
        .into_iter()
        .map(|row| {
            let provider =
                ResourceProvider::parse(&row.provider).unwrap_or(ResourceProvider::Direct);
            let mirrors = if provider.is_github() {
                github_mirrors(&row.url, &state.config.resources.github_mirrors)
                    .into_iter()
                    .map(|m| MirrorView {
                        label: m.label,
                        url: m.url,
                        is_original: m.is_original,
                    })
                    .collect()
            } else {
                Vec::new()
            };
            SourceView {
                provider: provider.as_str().to_string(),
                provider_label: provider.label().to_string(),
                label: row.label,
                url: row.url,
                extract_code: row.extract_code,
                mirrors,
            }
        })
        .collect::<Vec<_>>();
    let show_sources = !sources.is_empty();
    // 点赞/收藏：未登录时状态为 false，只显示计数
    let (flags, like_count, bookmark_count) = match viewer_id {
        Some(uid) => {
            let flags = repo::my_post_flags(state.db.pool(), id, uid).await?;
            let likes = repo::post_like_count(state.db.pool(), id).await? as u64;
            (flags, likes, 0u64)
        }
        None => (
            (false, false),
            repo::post_like_count(state.db.pool(), id).await? as u64,
            0,
        ),
    };
    let _ = bookmark_count;
    // 过滤掉查看者拉黑的人（登录才谈得上黑名单）
    let comments = repo::list_comments_for(state.db.pool(), id, viewer_id, 200).await?;

    let state_ = ReviewState::parse(&row.review_state).unwrap_or(ReviewState::Pending);
    let kind = PostKind::parse(&row.kind).unwrap_or(PostKind::Discussion);
    let section = PostSection::parse(&row.section).unwrap_or(PostSection::default_section());

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
        sources,
        show_sources,
        post: PostDetailView {
            id: row.id,
            avatar: author.as_ref().and_then(|u| u.avatar_hash.clone()),
            title: row.title.clone(),
            section: section.as_str().to_string(),
            section_label: section.label().to_string(),
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
            archived: row.archived_at.is_some(),
            can_edit: viewer_id == Some(row.author_id) || is_staff,
            liked: flags.0,
            bookmarked: flags.1,
            like_count: like_count as i64,
            bookmark_count: bookmark_count as i64,
        },
        comments: comments
            .into_iter()
            .map(|c| CommentView {
                author: c.author_display_name,
                avatar: c.author_avatar,
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

// ------------------------------------------------------------ 作者编辑

/// 编辑帖子：**作者本人或管理员及以上**。
pub async fn edit_form(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    match build_edit(&state, id, &headers).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

async fn build_edit<'a>(
    state: &'a AppState,
    id: i64,
    headers: &HeaderMap,
) -> AppResult<EditPostTemplate<'a>> {
    let user = require_user(state, headers).await?;
    let row = repo::get_post_for(state.db.pool(), id, Some(user.id), user.is_staff())
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在或不可见"))?;
    if row.author_id != user.id && !user.is_staff() {
        return Err(AppError::Domain(DomainError::Forbidden(
            "只能编辑自己的帖子".to_string(),
        )));
    }
    let kind = PostKind::parse(&row.kind).unwrap_or(PostKind::Discussion);
    let section = PostSection::parse(&row.section).unwrap_or(PostSection::default_section());
    let state_ = ReviewState::parse(&row.review_state).unwrap_or(ReviewState::Pending);
    Ok(EditPostTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        is_staff: user.is_staff(),
        csrf: user.csrf_token.clone(),
        id,
        error: None,
        state_label: state_.label().to_string(),
        review_note: row.review_note.clone(),
        kinds: kind_options(kind.as_str()),
        sections: section_options(section.as_str(), Some(&user)),
        title: row.title.clone(),
        body: row.body.clone(),
    })
}

/// 保存编辑：改完**重新过一遍审核机**（内容变了，结论自然要重算）。
pub async fn edit_submit(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<NewPostForm>,
) -> Response {
    let user = match session::current_user(&state, &headers).await {
        Ok(Some(user)) => user,
        Ok(None) => return Redirect::to("/login").into_response(),
        Err(e) => return e.into_response(),
    };
    if let Err(e) = save_edit(&state, id, &user, &form).await {
        return e.into_page_response(true);
    }
    Redirect::to(&format!("/p/{id}")).into_response()
}

async fn save_edit(
    state: &AppState,
    id: i64,
    user: &CurrentUser,
    form: &NewPostForm,
) -> AppResult<()> {
    let row = repo::get_post_for(state.db.pool(), id, Some(user.id), user.is_staff())
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在或不可见"))?;
    if row.author_id != user.id && !user.is_staff() {
        return Err(AppError::Domain(DomainError::Forbidden(
            "只能编辑自己的帖子".to_string(),
        )));
    }
    session::check_csrf(user, &form.csrf)?;
    let kind = PostKind::parse(form.kind.as_deref().unwrap_or("discussion"))
        .unwrap_or(PostKind::Discussion);
    let section = form
        .section
        .as_deref()
        .and_then(|raw| PostSection::parse(raw).ok())
        .unwrap_or(PostSection::default_section());
    let title = form.title.trim().to_string();
    let body = form.body.trim().to_string();
    let outcome = review_for_author(
        Some(user.role),
        kind,
        &title,
        &body,
        row.image_count.max(0) as usize,
    );
    let now = now_unix();
    if !repo::update_post(
        state.db.pool(),
        id,
        &title,
        &body,
        kind.as_str(),
        section.as_str(),
        outcome.state.as_str(),
        outcome.note.as_deref(),
        now,
    )
    .await?
    {
        return Err(AppError::not_found("帖子不存在"));
    }
    tracing::info!(
        post.id = id,
        state = outcome.state.as_str(),
        editor.id = user.id,
        "编辑帖子"
    );
    let _ = repo::record_audit(
        state.db.pool(),
        Some(user.id),
        "post.edit",
        Some(&format!("post:{id}")),
        Some(outcome.state.as_str()),
        now,
    )
    .await;
    Ok(())
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
        user_label: Some(user.display_name.clone()),
        is_staff: user.is_staff(),
        csrf: user.csrf_token.clone(),
        error,
        kinds: kind_options("discussion"),
        sections: section_options(PostSection::default_section().as_str(), Some(&user)),
        providers: provider_options(),
        source_slots: empty_slots(),
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
    let section = form
        .section
        .as_deref()
        .and_then(|raw| PostSection::parse(raw).ok())
        .unwrap_or(PostSection::default_section());
    let title = form.title.trim().to_string();
    let body = form.body.trim().to_string();

    // 分区权限优先：公告只有管理员能发
    let checked = session::guard(Some(&user), section.required_permission())
        .and_then(|()| session::check_csrf(&user, &form.csrf))
        .and_then(|()| form_sources(&form).map(|_| ()));
    let outcome = match checked {
        Ok(()) => review_for_author(Some(user.role), kind, &title, &body, 0),
        Err(e) => {
            return render(NewPostTemplate {
                site_name: &state.config.server.site_name,
                user_label: Some(user.display_name.clone()),
                is_staff: user.is_staff(),
                csrf: user.csrf_token.clone(),
                error: Some(e.parts().2),
                kinds: kind_options(kind.as_str()),
                sections: section_options(section.as_str(), Some(&user)),
                providers: provider_options(),
                source_slots: empty_slots(),
                title: &title,
                body: &body,
            });
        }
    };
    if !outcome.state.visible_to(true, true) {
        return render(NewPostTemplate {
            site_name: &state.config.server.site_name,
            user_label: Some(user.display_name.clone()),
            is_staff: user.is_staff(),
            csrf: user.csrf_token.clone(),
            error: Some(format!(
                "审核未通过：{}",
                outcome.note.as_deref().unwrap_or("内容不符合规范")
            )),
            kinds: kind_options(kind.as_str()),
            sections: section_options(section.as_str(), Some(&user)),
            providers: provider_options(),
            source_slots: empty_slots(),
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
            section: section.as_str(),
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
    // 下载来源（资源帖的核心信息）
    let sources = form_sources(&form).unwrap_or_default();
    for (position, (provider, url, code)) in sources.iter().enumerate() {
        if let Err(e) = repo::add_post_source(
            state.db.pool(),
            repo::NewPostSource {
                post_id: id,
                position: position as i64,
                provider: provider.as_str(),
                label: None,
                url,
                extract_code: code.as_deref(),
                now,
            },
        )
        .await
        {
            // 帖子已经建好了：来源写失败只记日志，不要把用户挡在门外。
            tracing::error!(post.id = id, error = %e, "写下载来源失败");
            break;
        }
    }
    state.counters.bump("post:created", 1);
    tracing::info!(
        post.id = id,
        kind = kind.as_str(),
        section = section.as_str(),
        sources = sources.len(),
        state = outcome.state.as_str(),
        "发帖"
    );
    Redirect::to(&format!("/p/{id}")).into_response()
}
