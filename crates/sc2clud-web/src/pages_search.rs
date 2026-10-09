//! B 站式搜索页：搜索框 + 分类标签（带计数）+ 排序行 + 结果；支持搜用户。

use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use serde::Deserialize;

use sc2clud_core::auth::Role;
use sc2clud_db::repo;

use crate::AppState;
use crate::error::AppResult;
use crate::session;
use crate::templates::{PostHitView, SearchPageTemplate, UserHitView, render};

#[derive(Debug, Deserialize)]
pub struct SearchParams {
    #[serde(default)]
    q: String,
    tab: Option<String>,
    /// 预览用的版式编号（只有开发实例看它）。
    sv: Option<String>,
}

pub async fn search_page(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<SearchParams>,
) -> AppResult<Response> {
    let user = session::current_user(&state, &headers).await?;
    let q = params.q.trim().to_string();
    let tab = params.tab.unwrap_or_else(|| "all".to_string());
    let search_variant = if state.config.server.debug_pages {
        params
            .sv
            .as_deref()
            .and_then(|v| v.parse::<u8>().ok())
            .filter(|v| (1..=3).contains(v))
            .unwrap_or(1)
    } else {
        1
    };

    // 计数：小站数据量下取一次长度就够，不值得再写两条 COUNT
    let all_posts = if q.is_empty() {
        Vec::new()
    } else {
        repo::search_posts(state.db.pool(), &q, None, 500, 0).await?
    };
    let post_count = all_posts.len() as i64;
    let user_rows = if q.is_empty() {
        Vec::new()
    } else {
        repo::search_users(state.db.pool(), &q, 50).await?
    };
    let user_count = user_rows.len() as i64;

    let default_bio = repo::site_text(
        state.db.pool(),
        "default_bio",
        sc2clud_core::community::DEFAULT_BIO,
    )
    .await?;
    let users: Vec<UserHitView> = if tab == "posts" {
        Vec::new()
    } else {
        user_rows
            .into_iter()
            .map(|row| UserHitView {
                handle: row.handle,
                display_name: row.display_name,
                avatar: row.avatar_hash,
                role_label: Role::parse(&row.role)
                    .map(|r| r.label().to_string())
                    .unwrap_or_else(|_| row.role.clone()),
                bio: if row.bio.trim().is_empty() {
                    default_bio.clone()
                } else {
                    row.bio
                },
                post_count: row.post_count,
            })
            .collect()
    };
    let posts: Vec<PostHitView> = if tab == "users" {
        Vec::new()
    } else {
        all_posts
            .iter()
            .take(30)
            .map(|row| PostHitView {
                id: row.id,
                title: row.title.clone(),
                cover_hash: row.cover_hash.clone(),
                section_label: sc2clud_core::resource::PostSection::parse(&row.section)
                    .map(|s| s.label().to_string())
                    .unwrap_or_else(|_| row.section.clone()),
                author: row.author_display_name.clone(),
                date: crate::templates::format_date(row.created_at),
                comment_count: row.comment_count,
            })
            .collect()
    };

    Ok(render(SearchPageTemplate {
        site_name: &state.config.server.site_name,
        user_label: user.as_ref().map(|u| u.display_name.clone()),
        is_staff: user.as_ref().is_some_and(|u| u.is_staff()),
        csrf: user
            .as_ref()
            .map(|u| u.csrf_token.clone())
            .unwrap_or_default(),
        q,
        tab,
        search_variant,
        posts,
        users,
        post_count,
        user_count,
    }))
}
