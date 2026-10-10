//! 帖子页面：详情、回复、发帖。
//!
//! 可见性一律走 `repo::get_post_for`（审核中只有作者与管理员可见），
//! 写操作一律「登录 + 已激活 + CSRF」三道门。

use axum::Form;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use bytes::Bytes;
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
    CommentView, EditImageView, EditPostTemplate, ImageView, KindOption, MirrorView,
    NewPostTemplate, PostDetailView, PostPageTemplate, ProviderOption, SectionOption, SourceSlot,
    SourceView, format_date, render,
};

/// 手工解析过的发帖/编辑表单。
///
/// 为什么不用 `Form<..>`：下载来源现在是**不限数量**的重复字段
/// （`provider` / `label` / `url` / `code` 各来一遍），serde 的单结构体接不住。
#[derive(Debug, Default)]
pub struct ParsedPostForm {
    pub csrf: String,
    pub title: String,
    pub body: String,
    pub kind: String,
    pub section: String,
    /// (provider, label, url, code)
    pub sources: Vec<(String, String, String, String)>,
}

pub fn parse_post_form(bytes: &[u8]) -> ParsedPostForm {
    let mut out = ParsedPostForm::default();
    let mut providers = Vec::new();
    let mut labels = Vec::new();
    let mut urls = Vec::new();
    let mut codes = Vec::new();
    for (key, value) in form_urlencoded::parse(bytes) {
        let value = value.into_owned();
        match key.as_ref() {
            "csrf" => out.csrf = value,
            "title" => out.title = value,
            "body" => out.body = value,
            "kind" => out.kind = value,
            "section" => out.section = value,
            "provider" => providers.push(value),
            "label" => labels.push(value),
            "url" => urls.push(value),
            "code" => codes.push(value),
            _ => {}
        }
    }
    let count = urls.len().max(providers.len());
    let take = |list: &Vec<String>, i: usize| list.get(i).cloned().unwrap_or_default();
    for i in 0..count {
        out.sources.push((
            take(&providers, i),
            take(&labels, i),
            take(&urls, i),
            take(&codes, i),
        ));
    }
    out
}

/// 表单里的可选整数：空串按 None 处理。
/// 浏览器提交空 input 会送 `parent_id=`，`Option<i64>` 自己解析不了空串，整条请求会被打回。
fn empty_as_none<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<String>::deserialize(deserializer)?;
    Ok(raw
        .filter(|value| !value.trim().is_empty())
        .and_then(|value| value.trim().parse().ok()))
}

#[derive(Debug, Deserialize)]
pub struct ReplyForm {
    pub csrf: String,
    pub body: String,
    /// 楼中楼：回复某条回复时带上它的楼层 id（顶部表单不带这个字段）。
    #[serde(default, deserialize_with = "empty_as_none")]
    pub parent_id: Option<i64>,
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
            cover: None,
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
            label: String::new(),
            provider: ResourceProvider::BaiduPan.as_str().to_string(),
        })
        .collect()
}

/// 一个校验过的下载来源：`(来源类型, 自定义名称, 地址, 提取码)`。
type ParsedSource = (ResourceProvider, Option<String>, String, Option<String>);

/// 从表单里取下载来源：**数量不限**，地址为空的整行跳过；
/// 名称可以自定义（留空就用来源类型的默认名）。
fn form_sources(form: &ParsedPostForm) -> AppResult<Vec<ParsedSource>> {
    let mut out = Vec::new();
    for (provider_raw, label_raw, url_raw, code_raw) in &form.sources {
        if url_raw.trim().is_empty() {
            continue;
        }
        let provider =
            ResourceProvider::parse(provider_raw.trim()).unwrap_or(ResourceProvider::Direct);
        let url = validate_resource_url(url_raw)?;
        let code = validate_extract_code(code_raw)?;
        let label = label_raw.trim();
        let label = if label.is_empty() {
            None
        } else {
            Some(label.chars().take(24).collect::<String>())
        };
        out.push((provider, label, url, code));
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

// 预览开关逐个传参（cui/tbi/page 等）；下次重构时收拢成一个结构体
#[allow(clippy::too_many_arguments)]
async fn build_post_page<'a>(
    state: &'a AppState,
    id: i64,
    headers: &HeaderMap,
    ui: Option<&str>,
    dui: Option<&str>,
    nui: Option<&str>,
    cui: Option<&str>,
    query_page: i64,
) -> AppResult<PostPageTemplate<'a>> {
    // 预览开关：只有开发实例看这个参数（生产恒为样式 1，预览代码不影响线上）
    // 生产恒用已评审通过的样式：菜单=2（分组下拉）、赞助=1（左渠道右二维码）、提示=3（红圆图标卡）
    let pick = |raw: Option<&str>, fallback: u8| -> u8 {
        if state.config.server.debug_pages {
            raw.and_then(|value| value.parse::<u8>().ok())
                .filter(|value| (1..=3).contains(value))
                .unwrap_or(fallback)
        } else {
            fallback
        }
    };
    let ui_variant = pick(ui, 2);
    let donate_variant = pick(dui, 1);
    let notice_variant = pick(nui, 3);
    let comments_variant = pick(cui, 1);
    let page = query_page;
    let user = session::current_user(state, headers).await?;
    let viewer_id = user.as_ref().map(|u| u.id);
    let is_staff = user.as_ref().is_some_and(CurrentUser::is_staff);

    let row = repo::get_post_for(state.db.pool(), id, viewer_id, is_staff)
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在或不可见"))?;
    let can_add_feature = row.review_state == "approved"
        && row.archived_at.is_none()
        && repo::get_section(state.db.pool(), &row.section)
            .await?
            .is_some_and(|s| !s.archived);
    let can_feature = crate::pages_featured::can_feature_post(state, user.as_ref(), &row.section)
        .await?
        && (row.featured_at.is_some() || can_add_feature);
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

    // 打赏：只有作者开了展示、且确实有渠道时才给入口
    let showcase = repo::author_showcase(state.db.pool(), row.author_id).await?;
    let donation_notice = if showcase.donation_visible {
        repo::donation_notice_for(state.db.pool(), row.author_id, &showcase.channels).await?
    } else {
        None
    };
    let donation_channels: Vec<crate::templates::DonationChannelView> = showcase
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
        .collect();
    // 楼中楼 + 分页：先在语句里算完再进模板字面量
    // （askama 模板字面量按字段顺序求值：计算写在里面会先读到旧值，分页就等于没做）
    const COMMENT_PAGE_SIZE: i64 = 15;
    // 计数要在 move 之前取（下面把 comments 消费掉了）
    let comment_count = comments.len() as i64;
    let mut roots: Vec<CommentView> = Vec::new();
    let mut replies: Vec<(i64, CommentView)> = Vec::new();
    for c in comments {
        let view = CommentView {
            id: c.id,
            author_id: c.author_id,
            handle: c.author_handle,
            author: c.author_display_name,
            avatar: c.author_avatar,
            avatar_small: c.author_avatar_small,
            // 显示头衔而不是权限：有头衔才挂（没佩戴就是空）
            title: c.author_title.clone(),
            title_color: c
                .author_title_color
                .clone()
                .unwrap_or_else(|| "#2563eb".to_string()),
            body_html: sc2clud_core::community::render_body(&c.body),
            created_at: format_date(c.created_at),
            likes: c.likes,
            dislikes: c.dislikes,
            my_vote: c.my_vote,
            replies: Vec::new(),
        };
        match c.parent_id {
            None => roots.push(view),
            Some(parent) => replies.push((parent, view)),
        }
    }
    // 父楼层被拉黑过滤掉时，它的回复也一起不显示（不留孤儿）
    for (parent, reply) in replies {
        if let Some(root) = roots.iter_mut().find(|root| root.id == parent) {
            root.replies.push(reply);
        }
    }
    let comments_total = roots.len() as i64;
    let comments_pages = ((comments_total + COMMENT_PAGE_SIZE - 1) / COMMENT_PAGE_SIZE).max(1);
    let comments_page = page.min(comments_pages).max(1);
    let comments_prev = if comments_page > 1 {
        comments_page - 1
    } else {
        0
    };
    let comments_next = if comments_page < comments_pages {
        comments_page + 1
    } else {
        0
    };
    // 页码条：页数不多就全列，多了只列首末页与当前页附近
    let mut comments_page_links: Vec<crate::templates::PageLink> = Vec::new();
    // 闭包只造值不碰 vec，避免同时持有可变借用
    let link = |number: i64, gap: bool| crate::templates::PageLink { number, gap };
    if comments_pages <= 7 {
        for page_number in 1..=comments_pages {
            comments_page_links.push(link(page_number, false));
        }
    } else {
        comments_page_links.push(link(1, false));
        if comments_page > 3 {
            comments_page_links.push(link(0, true));
        }
        for page_number in (comments_page - 1).max(2)..=(comments_page + 1).min(comments_pages - 1)
        {
            comments_page_links.push(link(page_number, false));
        }
        if comments_page < comments_pages - 2 {
            comments_page_links.push(link(0, true));
        }
        comments_page_links.push(link(comments_pages, false));
    }
    let page_start = ((comments_page - 1) * COMMENT_PAGE_SIZE) as usize;
    let comments_view: Vec<CommentView> = roots
        .into_iter()
        .skip(page_start)
        .take(COMMENT_PAGE_SIZE as usize)
        .collect();
    Ok(PostPageTemplate {
        ui_variant,
        comments_total,
        comments_page,
        comments_pages,
        comments_prev,
        comments_next,
        comments_page_links,
        comments_variant,
        donate_variant,
        notice_variant,
        site_name: &state.config.server.site_name,
        donation_visible: showcase.donation_visible && !donation_channels.is_empty(),
        donation_channels,
        donation_notice,
        user_label: user.as_ref().map(|u| u.display_name.clone()),
        csrf: user
            .as_ref()
            .map(|u| u.csrf_token.clone())
            .unwrap_or_default(),
        can_reply: user.as_ref().is_some_and(|u| u.activated),
        is_staff,
        can_interact: viewer_id.is_some_and(|id| id != row.author_id)
            && user.as_ref().is_some_and(|u| u.activated),
        sections: {
            let covers: std::collections::HashMap<String, String> =
                repo::list_section_covers(state.db.pool())
                    .await?
                    .into_iter()
                    .map(|(section, hash, _mime)| (section, hash))
                    .collect();
            crate::routes::ordered_sections(state)
                .await
                .iter()
                .map(|s| SectionOption {
                    value: s.as_str().to_string(),
                    label: s.label().to_string(),
                    checked: s.as_str() == section.as_str(),
                    cover: covers.get(s.as_str()).cloned(),
                })
                .collect()
        },
        images,
        sources,
        show_sources,
        post: PostDetailView {
            is_featured: row.featured_at.is_some(),
            can_feature,
            can_add_feature,
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
            author_handle: author
                .as_ref()
                .map(|u| u.handle.clone())
                .unwrap_or_default(),
            author_role_label: author_role.label().to_string(),
            comment_count,
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
        comments: comments_view,
    })
}

#[derive(Debug, Deserialize)]
pub struct UiQuery {
    /// 预览用的界面样式编号（1/2/3）。
    ui: Option<String>,
    /// 赞助弹窗 / 提示的预览样式编号。
    dui: Option<String>,
    nui: Option<String>,
    /// 回复区样式编号（1 B 站原味 / 2 卡片流 / 3 紧凑列表）。
    cui: Option<String>,
    /// 回复区页码（每页 15 个主楼层）。
    page: Option<String>,
}

pub async fn post_page(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<UiQuery>,
) -> Response {
    match build_post_page(
        &state,
        id,
        &headers,
        query.ui.as_deref(),
        query.dui.as_deref(),
        query.nui.as_deref(),
        query.cui.as_deref(),
        query
            .page
            .as_deref()
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(1)
            .max(1),
    )
    .await
    {
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
        providers: provider_options(),
        images: {
            let rows = repo::list_post_images(state.db.pool(), id).await?;
            let total = rows.len();
            rows.into_iter()
                .enumerate()
                .map(|(index, img)| EditImageView {
                    id: img.id,
                    href: format!("/img/{}", img.display_hash.unwrap_or(img.original_hash)),
                    number: index + 1,
                    is_first: index == 0,
                    is_last: index + 1 == total,
                })
                .collect()
        },
        image_count: row.image_count,
        sources: repo::list_post_sources(state.db.pool(), id)
            .await?
            .into_iter()
            .enumerate()
            .map(|(i, row)| SourceSlot {
                index: i + 1,
                url: row.url,
                code: row.extract_code.unwrap_or_default(),
                provider: row.provider,
                label: row.label.unwrap_or_default(),
            })
            .collect(),
        title: row.title.clone(),
        body: row.body.clone(),
    })
}

/// 保存编辑：改完**重新过一遍审核机**（内容变了，结论自然要重算）。
pub async fn edit_submit(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let user = match session::current_user(&state, &headers).await {
        Ok(Some(user)) => user,
        Ok(None) => return Redirect::to("/login").into_response(),
        Err(e) => return e.into_response(),
    };
    let form = parse_post_form(&body);
    match save_edit(&state, id, &user, &form).await {
        // 暂存（等待审核）与直接生效，去的地方不同：编辑页会显示「修改内容审核中」
        Ok(true) => Redirect::to(&format!("/p/{id}/edit?staged=1")).into_response(),
        Ok(false) => Redirect::to(&format!("/p/{id}")).into_response(),
        Err(e) => e.into_page_response(true),
    }
}

async fn save_edit(
    state: &AppState,
    id: i64,
    user: &CurrentUser,
    form: &ParsedPostForm,
) -> AppResult<bool> {
    let row = repo::get_post_for(state.db.pool(), id, Some(user.id), user.is_staff())
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在或不可见"))?;
    if row.author_id != user.id && !user.is_staff() {
        return Err(AppError::Domain(DomainError::Forbidden(
            "只能编辑自己的帖子".to_string(),
        )));
    }
    session::check_csrf(user, &form.csrf)?;
    let kind = PostKind::parse(if form.kind.is_empty() {
        "discussion"
    } else {
        form.kind.as_str()
    })
    .unwrap_or(PostKind::Discussion);
    let section = PostSection::parse(&form.section).unwrap_or(PostSection::default_section());
    let title = form.title.trim().to_string();
    let body = form.body.trim().to_string();
    let outcome = review_for_author(
        Some(user.role),
        user.trusted,
        kind,
        &title,
        &body,
        row.image_count.max(0) as usize,
    );
    let now = now_unix();
    // 审核机放行 → 直接生效；否则只写「待审修改」：
    // 通过前对外仍是原帖，作者侧看到「修改内容审核中」。
    let staged = match repo::submit_post_edit(
        state.db.pool(),
        repo::PostEdit {
            id,
            title: &title,
            body: &body,
            kind: kind.as_str(),
            section: section.as_str(),
            review_state: outcome.state.as_str(),
            review_note: outcome.note.as_deref(),
            submitted_by: Some(user.id),
            now,
        },
        outcome.state.as_str(),
    )
    .await?
    {
        repo::EditOutcome::Applied => false,
        repo::EditOutcome::Staged => true,
    };
    if staged {
        tracing::info!(post.id = id, editor.id = user.id, "编辑已暂存，等待审核");
        return Ok(true);
    }
    // 下载来源整体重写：编辑页允许增删，逐个 diff 反而更容易出错
    let sources = form_sources(form).unwrap_or_default();
    if let Err(e) = repo::delete_post_sources(state.db.pool(), id).await {
        tracing::error!(post.id = id, error = %e, "清空下载来源失败");
    }
    for (position, (provider, label, url, code)) in sources.iter().enumerate() {
        if let Err(e) = repo::add_post_source(
            state.db.pool(),
            repo::NewPostSource {
                post_id: id,
                position: position as i64,
                provider: provider.as_str(),
                label: label.as_deref(),
                url,
                extract_code: code.as_deref(),
                now,
            },
        )
        .await
        {
            tracing::error!(post.id = id, error = %e, "写下载来源失败");
        }
    }
    tracing::info!(
        post.id = id,
        state = outcome.state.as_str(),
        editor.id = user.id,
        sources = sources.len(),
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
    Ok(false)
}

#[derive(Debug, Deserialize)]
pub struct CsrfOnlyForm {
    pub csrf: String,
}

#[derive(Debug, Deserialize)]
pub struct MoveImageForm {
    pub csrf: String,
    /// `forward` = 往前挪一格，其它值往后。
    pub dir: String,
}

/// 分区级发言判定：**库里的分区记录** + 用户组白名单。
///
/// 硬编码枚举只作为初始种子；真正说了算的是 `sections` 表，
/// 所以管理员改门槛 / 归档分区后，这里立刻生效。
async fn ensure_section_action(
    state: &AppState,
    user: &CurrentUser,
    section: &str,
    want_post: bool,
) -> AppResult<()> {
    let Some(record) = repo::get_section(state.db.pool(), section).await? else {
        return Err(AppError::Domain(DomainError::InvalidInput(
            "这个分区不存在".to_string(),
        )));
    };
    let role = Some(user.role);
    let allowed_by_role = if want_post {
        record.can_post(role)
    } else {
        record.can_reply(role)
    };
    if allowed_by_role {
        return Ok(());
    }
    // 用户组白名单：任一组给了允许就算允许（组是加成，不是限制）
    let rules = repo::group_rules_for_user_section(state.db.pool(), user.id, section).await?;
    let allowed_by_group = rules.iter().any(|rule| {
        if want_post {
            rule.can_post == 1
        } else {
            rule.can_reply == 1
        }
    });
    if allowed_by_group {
        return Ok(());
    }
    let what = if want_post { "发帖" } else { "回帖" };
    Err(AppError::Domain(DomainError::Forbidden(format!(
        "你在「{}」没有{what}权限",
        record.label
    ))))
}

/// 取出帖子并确认当前用户有权编辑它（作者本人或管理员及以上）。
async fn require_post_editor(
    state: &AppState,
    headers: &HeaderMap,
    post_id: i64,
) -> AppResult<CurrentUser> {
    let user = require_user(state, headers).await?;
    let row = repo::get_post_for(state.db.pool(), post_id, Some(user.id), user.is_staff())
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在或不可见"))?;
    if row.author_id != user.id && !user.is_staff() {
        return Err(AppError::Domain(DomainError::Forbidden(
            "只能修改自己的帖子".to_string(),
        )));
    }
    Ok(user)
}

/// 删除一张配图：软删行 + 扣减引用计数（归零的 blob 顺手回收）。
pub async fn post_image_delete(
    State(state): State<AppState>,
    Path((id, image_id)): Path<(i64, i64)>,
    headers: HeaderMap,
    Form(form): Form<CsrfOnlyForm>,
) -> Response {
    let user = match require_post_editor(&state, &headers, id).await {
        Ok(user) => user,
        Err(e) => return e.into_page_response(true),
    };
    if let Err(e) = session::check_csrf(&user, &form.csrf) {
        return e.into_page_response(true);
    }
    match repo::delete_post_image(state.db.pool(), id, image_id).await {
        Ok(Some(reclaim)) => {
            for hash in &reclaim {
                if let Ok(parsed) = sc2clud_core::BlobHash::parse(hash) {
                    if let Err(e) = state.storage.delete(&parsed).await {
                        tracing::warn!(blob = %hash, error = %e, "回收配图内容失败（先记着）");
                    }
                }
            }
            tracing::info!(
                post.id = id,
                image.id = image_id,
                actor.id = user.id,
                "删除配图"
            );
        }
        Ok(None) => tracing::debug!(post.id = id, image.id = image_id, "配图不存在，忽略"),
        Err(e) => return AppError::from(e).into_response(),
    }
    Redirect::to(&format!("/p/{id}/edit")).into_response()
}

/// 调整配图顺序：往前或往后挪一格。
pub async fn post_image_move(
    State(state): State<AppState>,
    Path((id, image_id)): Path<(i64, i64)>,
    headers: HeaderMap,
    Form(form): Form<MoveImageForm>,
) -> Response {
    let user = match require_post_editor(&state, &headers, id).await {
        Ok(user) => user,
        Err(e) => return e.into_page_response(true),
    };
    if let Err(e) = session::check_csrf(&user, &form.csrf) {
        return e.into_page_response(true);
    }
    let forward = form.dir == "forward";
    if let Err(e) = repo::move_post_image(state.db.pool(), id, image_id, forward).await {
        return AppError::from(e).into_response();
    }
    tracing::info!(
        post.id = id,
        image.id = image_id,
        forward,
        actor.id = user.id,
        "调整配图顺序"
    );
    Redirect::to(&format!("/p/{id}/edit")).into_response()
}

/// 这条链接是不是本站的：站点根（配置）+ `site_domains` 表（统一域名管理）。
async fn is_our_link(state: &AppState, url: &str) -> AppResult<bool> {
    let mut allowed: Vec<String> = repo::list_site_domains(state.db.pool())
        .await?
        .into_iter()
        .map(|row| row.domain)
        .collect();
    allowed.push(state.config.server.base_url.clone());
    Ok(sc2clud_core::community::is_site_link(url, &allowed))
}

#[derive(Debug, Deserialize)]
pub struct ResolveQuery {
    pub url: String,
}

/// 把站内帖子链接解析成帖子标题。
///
/// 域名必须是**我们自己的**：配置里的站点根 + `site_domains` 表（统一域名管理）；
/// 路径前缀不看（`core::community::parse_post_link`），所以现在/以后加域名都不用改这里。
/// 只返回「已通过、未删除、未归档」的帖子，避免拿它探测草稿。
pub async fn resolve_post_link(
    State(state): State<AppState>,
    axum::extract::Query(query): axum::extract::Query<ResolveQuery>,
) -> AppResult<Response> {
    if !is_our_link(&state, &query.url).await? {
        return Err(AppError::not_found("这不是本站的链接"));
    }
    let Some(id) = sc2clud_core::community::parse_post_link(&query.url) else {
        return Err(AppError::not_found("链接里没有帖子号"));
    };
    let Some(title) = repo::resolved_post_title(state.db.pool(), id).await? else {
        return Err(AppError::not_found("帖子不存在或不可见"));
    };
    Ok(axum::Json(serde_json::json!({ "id": id, "title": title })).into_response())
}

#[derive(Debug, Deserialize)]
pub struct ResourceStatusForm {
    pub csrf: String,
    pub status: String,
}

/// 作者（或管理员）标记资源帖状态：持续更新 / 接受 bug 修复 / 停止维护。
pub async fn set_resource_status(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<ResourceStatusForm>,
) -> Response {
    let user = match require_post_editor(&state, &headers, id).await {
        Ok(user) => user,
        Err(e) => return e.into_page_response(true),
    };
    if let Err(e) = session::check_csrf(&user, &form.csrf) {
        return e.into_page_response(true);
    }
    let status = match sc2clud_core::community::ResourceStatus::parse(&form.status) {
        Ok(status) => status,
        Err(e) => return AppError::from(e).into_page_response(true),
    };
    match repo::set_post_resource_status(state.db.pool(), id, status.as_str(), now_unix()).await {
        Ok(true) => tracing::info!(
            post.id = id,
            status = status.as_str(),
            actor.id = user.id,
            "资源状态变更"
        ),
        Ok(false) => return AppError::not_found("帖子不存在").into_page_response(true),
        Err(e) => return AppError::from(e).into_response(),
    }
    Redirect::to(&format!("/p/{id}")).into_response()
}

#[derive(Debug, Deserialize)]
pub struct CsrfQuery {
    pub csrf: String,
}

/// 资源帖状态的只读接口（前台徽标用）。
pub async fn resource_status_json(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> AppResult<Response> {
    let raw = repo::post_resource_status(state.db.pool(), id)
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在"))?;
    let label = sc2clud_core::community::ResourceStatus::parse(&raw)
        .map(|s| s.label())
        .unwrap_or("持续更新");
    Ok(axum::Json(serde_json::json!({ "status": raw, "label": label })).into_response())
}

#[derive(Debug, Deserialize)]
pub struct IssueForm {
    pub csrf: String,
    pub kind: String,
    pub title: String,
    pub body: Option<String>,
}

/// 提 issue（bug / 功能建议）。门槛与回帖一致：登录 + 已激活 + 分区允许回帖。
pub async fn issue_create(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<IssueForm>,
) -> Response {
    match add_issue(&state, id, &headers, &form).await {
        Ok(issue_id) => Redirect::to(&format!("/p/{id}?issue={issue_id}")).into_response(),
        Err(e) => e.into_page_response(true),
    }
}

async fn add_issue(
    state: &AppState,
    post_id: i64,
    headers: &HeaderMap,
    form: &IssueForm,
) -> AppResult<i64> {
    let user = require_user(state, headers).await?;
    session::guard(Some(&user), Permission::Comment)?;
    session::check_csrf(&user, &form.csrf)?;
    let post = repo::get_post_for(state.db.pool(), post_id, Some(user.id), user.is_staff())
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在或不可见"))?;
    ensure_section_action(state, &user, &post.section, false).await?;
    let kind = sc2clud_core::community::IssueKind::parse(&form.kind)?;
    let title = form.title.trim();
    if title.chars().count() < 2 || title.chars().count() > 80 {
        return Err(AppError::Domain(DomainError::InvalidInput(
            "标题要 2~80 个字".to_string(),
        )));
    }
    let body = form.body.as_deref().unwrap_or_default().trim();
    if body.chars().count() > 5000 {
        return Err(AppError::Domain(DomainError::InvalidInput(
            "正文最多 5000 字".to_string(),
        )));
    }
    let issue_id = repo::create_issue(
        state.db.pool(),
        repo::NewIssue {
            post_id,
            author_id: user.id,
            kind: kind.as_str(),
            title,
            body,
            now: now_unix(),
        },
    )
    .await?;
    tracing::info!(
        post.id = post_id,
        issue.id = issue_id,
        kind = kind.as_str(),
        "新 issue"
    );
    Ok(issue_id)
}

#[derive(Debug, Deserialize)]
pub struct IssueStateForm {
    pub csrf: String,
    pub state: String,
}

/// 关 / 重开 issue：提 issue 的人、帖作者、管理员及以上都可以。
pub async fn issue_set_state(
    State(state): State<AppState>,
    Path((id, issue_id)): Path<(i64, i64)>,
    headers: HeaderMap,
    Form(form): Form<IssueStateForm>,
) -> Response {
    let user = match require_user(&state, &headers).await {
        Ok(user) => user,
        Err(e) => return e.into_page_response(true),
    };
    let Some(issue) = (match repo::get_issue(state.db.pool(), issue_id).await {
        Ok(issue) => issue,
        Err(e) => return AppError::from(e).into_response(),
    }) else {
        return AppError::not_found("issue 不存在").into_page_response(true);
    };
    let post = match repo::get_post_for(state.db.pool(), id, Some(user.id), user.is_staff()).await {
        Ok(Some(post)) => post,
        Ok(None) => return AppError::not_found("帖子不存在").into_page_response(true),
        Err(e) => return AppError::from(e).into_response(),
    };
    let allowed = issue.post_id == id
        && (issue.author_id == user.id || post.author_id == user.id || user.is_staff());
    if !allowed {
        return AppError::Domain(DomainError::Forbidden(
            "只有提 issue 的人、帖作者或管理员能关闭".to_string(),
        ))
        .into_page_response(true);
    }
    if let Err(e) = session::check_csrf(&user, &form.csrf) {
        return e.into_page_response(true);
    }
    let target = match sc2clud_core::community::IssueState::parse(&form.state) {
        Ok(state) => state,
        Err(e) => return AppError::from(e).into_page_response(true),
    };
    if let Err(e) = repo::set_issue_state(
        state.db.pool(),
        issue_id,
        target.as_str(),
        Some(user.id),
        now_unix(),
    )
    .await
    {
        return AppError::from(e).into_response();
    }
    Redirect::to(&format!("/p/{id}?issue={issue_id}")).into_response()
}

#[derive(Debug, Deserialize)]
pub struct IssueCommentForm {
    pub csrf: String,
    pub body: String,
}

/// 在 issue 下回复。
pub async fn issue_comment(
    State(state): State<AppState>,
    Path((id, issue_id)): Path<(i64, i64)>,
    headers: HeaderMap,
    Form(form): Form<IssueCommentForm>,
) -> Response {
    let user = match require_user(&state, &headers).await {
        Ok(user) => user,
        Err(e) => return e.into_page_response(true),
    };
    if let Err(e) = session::guard(Some(&user), Permission::Comment)
        .and_then(|()| session::check_csrf(&user, &form.csrf))
    {
        return e.into_page_response(true);
    }
    let body = form.body.trim();
    if body.chars().count() < 2 || body.chars().count() > 5000 {
        return AppError::Domain(DomainError::InvalidInput("回复要 2~5000 字".to_string()))
            .into_page_response(true);
    }
    match repo::get_issue(state.db.pool(), issue_id).await {
        Ok(Some(issue)) if issue.post_id == id => {}
        Ok(_) => return AppError::not_found("issue 不存在").into_page_response(true),
        Err(e) => return AppError::from(e).into_response(),
    }
    if let Err(e) =
        repo::add_issue_comment(state.db.pool(), issue_id, user.id, body, now_unix()).await
    {
        return AppError::from(e).into_response();
    }
    Redirect::to(&format!("/p/{id}?issue={issue_id}")).into_response()
}

#[derive(Debug, Deserialize)]
pub struct IssueQuery {
    pub all: Option<String>,
}

/// 某帖的 issue 列表（JSON，前端 issue 面板用）。
pub async fn issues_json(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    axum::extract::Query(query): axum::extract::Query<IssueQuery>,
) -> AppResult<Response> {
    if repo::resolved_post_title(state.db.pool(), id)
        .await?
        .is_none()
    {
        return Err(AppError::not_found("帖子不存在或不可见"));
    }
    let include_closed = matches!(query.all.as_deref(), Some("1") | Some("true"));
    let rows = repo::list_issues(state.db.pool(), id, include_closed, 50, 0).await?;
    let issues: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|row| {
            serde_json::json!({
                "id": row.id,
                "kind": row.kind,
                "kind_label": sc2clud_core::community::IssueKind::parse(&row.kind)
                    .map(|k| k.label())
                    .unwrap_or("其它"),
                "title": row.title,
                "body": row.body,
                "state": row.state,
                "state_label": sc2clud_core::community::IssueState::parse(&row.state)
                    .map(|s| s.label())
                    .unwrap_or("待处理"),
                "author": row.author_display_name,
                "author_handle": row.author_handle,
                "comments": row.comment_count,
                "created_at": row.created_at,
            })
        })
        .collect();
    Ok(axum::Json(serde_json::json!({ "issues": issues })).into_response())
}

/// 单个 issue + 回复（JSON）。
pub async fn issue_json(
    State(state): State<AppState>,
    Path((_id, issue_id)): Path<(i64, i64)>,
) -> AppResult<Response> {
    let issue = repo::get_issue(state.db.pool(), issue_id)
        .await?
        .ok_or_else(|| AppError::not_found("issue 不存在"))?;
    let comments = repo::list_issue_comments(state.db.pool(), issue_id).await?;
    let comments: Vec<serde_json::Value> = comments
        .into_iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "body": c.body,
                "author": c.author_display_name,
                "author_handle": c.author_handle,
                "created_at": c.created_at,
            })
        })
        .collect();
    Ok(axum::Json(serde_json::json!({
        "id": issue.id,
        "title": issue.title,
        "body": issue.body,
        "kind": issue.kind,
        "state": issue.state,
        "comments": comments,
    }))
    .into_response())
}

#[derive(Debug, serde::Deserialize)]
pub struct VoteForm {
    value: i64,
}

/// 回复投票（JSON）：value = 1 赞 / -1 踩 / 0 取消。
/// 前端目前只接点赞；点踩走同一个接口，先不接界面。
pub async fn comment_vote(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    axum::Json(form): axum::Json<VoteForm>,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::Comment)?;
    let token = headers
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    session::check_csrf(&user, token)?;
    if !matches!(form.value, -1..=1) {
        return Err(invalid("投票只能是赞、踩或取消"));
    }
    // 只能投自己看得到的帖子下的回复
    let post_id = repo::comment_post_id(state.db.pool(), id)
        .await?
        .ok_or_else(|| AppError::not_found("回复不存在"))?;
    repo::get_post_for(state.db.pool(), post_id, Some(user.id), user.is_staff())
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在或不可见"))?;
    let (likes, dislikes, mine) =
        repo::vote_comment(state.db.pool(), id, user.id, form.value, now_unix()).await?;
    Ok(axum::Json(
        serde_json::json!({ "ok": true, "likes": likes, "dislikes": dislikes, "mine": mine }),
    )
    .into_response())
}

#[derive(Debug, serde::Deserialize)]
pub struct CommentJsonForm {
    body: String,
    #[serde(default)]
    parent_id: Option<i64>,
}

/// 发回复（JSON）：页面上的表单与楼中楼输入框都走这里，成功后前端只重取评论区。
pub async fn comment_json(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    axum::Json(form): axum::Json<CommentJsonForm>,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::Comment)?;
    let token = headers
        .get("x-csrf-token")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    session::check_csrf(&user, token)?;
    // 保留已校验的 token，共用普通表单的内容与楼中楼校验。
    let reply = ReplyForm {
        csrf: token.to_owned(),
        body: form.body,
        parent_id: form.parent_id,
    };
    add_comment(&state, id, &headers, &reply).await?;
    Ok(axum::Json(serde_json::json!({ "ok": true })).into_response())
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
    // 回帖同样受分区门槛约束（与发帖分开判定）
    if let Ok(Some(post_row)) =
        repo::get_post_for(state.db.pool(), post_id, Some(user.id), user.is_staff()).await
    {
        ensure_section_action(state, &user, &post_row.section, false).await?;
    }
    session::check_csrf(&user, &form.csrf)?;

    let body = form.body.trim();
    if body.chars().count() < 2 {
        return Err(invalid("回复至少 2 个字"));
    }
    if body.chars().count() > 5_000 {
        return Err(invalid("回复最长 5000 字"));
    }
    // 只能在**自己看得到**的帖子下回复。
    let post_row = repo::get_post_for(state.db.pool(), post_id, Some(user.id), user.is_staff())
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在或不可见"))?;

    // 楼中楼只一层：父楼层本身是回复时挂到根楼层下（B 站规则）
    let root = match form.parent_id {
        Some(parent) => repo::comment_root_of(state.db.pool(), post_id, parent).await?,
        None => None,
    };
    let now = now_unix();
    let comment_id =
        repo::create_comment(state.db.pool(), post_id, user.id, body, root, now).await?;
    state.counters.bump("comment:created", 1);
    tracing::info!(post.id = post_id, user.id = user.id, "新增回复");

    // 通知：先被回复的人，再被 @ 的人（跳过自己、去重）
    let mut targets: Vec<i64> = Vec::new();
    if let Some(parent) = root
        && let Some(author) = repo::comment_author(state.db.pool(), parent).await?
        && author != user.id
    {
        targets.push(author);
    }
    for id in sc2clud_core::community::mentions(body) {
        if id != user.id && !targets.contains(&id) {
            targets.push(id);
        }
    }
    let preview: String = body.chars().take(60).collect();
    for target in targets {
        let _ = repo::notify(
            state.db.pool(),
            repo::NewNotification {
                user_id: target,
                actor_id: Some(user.id),
                kind: "reply",
                title: &format!("{} 在《{}》里回复了你", user.display_name, post_row.title),
                body: Some(&preview),
                link: Some(&format!("/p/{post_id}#c{comment_id}")),
                now,
            },
        )
        .await;
    }
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
    body: Bytes,
) -> Response {
    let user = match session::current_user(&state, &headers).await {
        Ok(Some(user)) => user,
        Ok(None) => return Redirect::to("/login").into_response(),
        Err(e) => return e.into_response(),
    };
    let form = parse_post_form(&body);

    let kind_raw = if form.kind.is_empty() {
        "discussion"
    } else {
        form.kind.as_str()
    };
    let kind = PostKind::parse(kind_raw).unwrap_or(PostKind::Discussion);
    let section = PostSection::parse(&form.section).unwrap_or(PostSection::default_section());
    let title = form.title.trim().to_string();
    let body = form.body.trim().to_string();

    // 分区权限优先：公告只有管理员能发
    let checked = session::guard(Some(&user), section.required_permission())
        .and_then(|()| session::check_csrf(&user, &form.csrf))
        .and_then(|()| form_sources(&form).map(|_| ()));
    // 分区级判定要走库（管理员可能归档了分区或抬高了门槛），是异步的，
    // 所以放在同步守卫之后单独 await。
    let checked = match checked {
        Ok(()) => ensure_section_action(&state, &user, section.as_str(), true).await,
        Err(e) => Err(e),
    };
    let outcome = match checked {
        Ok(()) => review_for_author(Some(user.role), user.trusted, kind, &title, &body, 0),
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
    for (position, (provider, label, url, code)) in sources.iter().enumerate() {
        if let Err(e) = repo::add_post_source(
            state.db.pool(),
            repo::NewPostSource {
                post_id: id,
                position: position as i64,
                provider: provider.as_str(),
                label: label.as_deref(),
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
