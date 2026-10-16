//! 管理员面板：用户管理、激活、权限等级、显示名、注册策略。
//!
//! 权限分层：查看面板 / 激活·停用 / 切换注册策略 = 网站管理员；
//! 修改权限等级、改显示名 = 超级管理员。所有动作过 CSRF 并写审计日志。

use axum::Form;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use serde::Deserialize;

use sc2clud_core::auth::{Permission, Role};
use sc2clud_core::now_unix;
use sc2clud_db::repo;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::routes::{feed_view, require_user};
use crate::session;
use crate::templates::{
    AdminTemplate, AdminUserView, FeedView, format_date, format_relative, human_bytes, render,
};

// 分区发言权限（矩阵初值 + 保存端点）已拆到 admin_acl.rs；这里 re-export，路由表不变
pub use crate::admin_acl::{acl_json, save_section_acl};

use crate::admin_sanctions::BAN_HOUR_OPTIONS;

use crate::admin_posts::ReviewForm;
#[derive(Debug, Deserialize)]

pub struct CsrfForm {
    pub csrf: String,
}

/// 这个请求是前端 fetch 发来的吗？
///
/// 是就回 JSON（页面就地更新，不刷新）；否则回跳转（无 JS 也能用）。
pub(crate) fn wants_json(headers: &HeaderMap) -> bool {
    let by_flag = headers
        .get("x-requested-with")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("fetch"));
    let by_accept = headers
        .get(axum::http::header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.contains("application/json"));
    by_flag || by_accept
}

pub(crate) fn done(headers: &HeaderMap, message: &str, redirect: &str) -> Response {
    if wants_json(headers) {
        (
            axum::http::StatusCode::OK,
            axum::Json(serde_json::json!({ "ok": true, "message": message })),
        )
            .into_response()
    } else {
        Redirect::to(redirect).into_response()
    }
}

/// `/admin` → 用户管理首页。
pub async fn index() -> Redirect {
    Redirect::to("/admin/users/overview")
}

#[derive(Debug, Deserialize)]
pub struct AdminQuery {
    /// 预览用：默认头像池界面版式。
    av: Option<String>,
    /// 权限/用户组界面版式。
    aui: Option<String>,
    #[serde(default)]
    pub q: Option<String>,
}

async fn build_panel<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
    query: &str,
    av: Option<&str>,
    aui: Option<&str>,
) -> AppResult<AdminTemplate<'a>> {
    let user = require_user(state, headers).await?;
    session::guard(Some(&user), Permission::ManageUsers)?;
    let now = now_unix();
    let rows = repo::admin_list_users(state.db.pool(), query, 200).await?;
    let total_users = repo::count_users(state.db.pool()).await?;
    let pending_rows = repo::list_pending_posts(state.db.pool(), 50).await?;
    // 磁盘预算总览：服务器还剩多少、已经承诺出去多少、其中还没被用掉多少
    let (allocated, used) = repo::quota_totals(state.db.pool()).await?;
    let free_bytes = state.storage.available_bytes().await.unwrap_or(0);
    let unused = (allocated - used).max(0);
    let quota_over_committed =
        allocated.max(0) as u64 > free_bytes.saturating_add(used.max(0) as u64);
    // 分区档位（0 不启用 / 1 白名单 / 2 黑名单）——矩阵里的下拉要回显当前值
    let acl_sections = repo::list_sections(state.db.pool(), true).await?;
    let section_modes: std::collections::HashMap<String, i64> = acl_sections
        .iter()
        .map(|section| (section.key.clone(), section.group_mode))
        .collect();
    // 生效中的处罚（kind:section:until；同样逐个查，量小）
    let mut member_sanctions: std::collections::HashMap<i64, String> =
        std::collections::HashMap::new();
    for row in &rows {
        let list = repo::active_sanctions(state.db.pool(), row.id, now).await?;
        if !list.is_empty() {
            member_sanctions.insert(
                row.id,
                list.iter()
                    .map(|item| format!("{}:{}:{}", item.kind, item.section, item.until))
                    .collect::<Vec<_>>()
                    .join(";"),
            );
        }
    }
    // 每个用户所属的用户组（人数少，逐个查即可；将来量大再换成一条 JOIN）
    let mut member_groups: std::collections::HashMap<i64, Vec<i64>> =
        std::collections::HashMap::new();
    for group in repo::list_user_groups(state.db.pool(), true).await? {
        for member in repo::list_group_members(state.db.pool(), group.id).await? {
            member_groups.entry(member.0).or_default().push(group.id);
        }
    }
    let users: Vec<AdminUserView> = rows
        .into_iter()
        .map(|row| AdminUserView {
            id: row.id,
            ban_label: row
                .post_ban_until
                .filter(|until| *until > now)
                .map(|until| format!("禁言至 {}", crate::templates::format_date(until)))
                .unwrap_or_default(),
            sanctions: member_sanctions.get(&row.id).cloned().unwrap_or_default(),
            groups: member_groups.get(&row.id).cloned().unwrap_or_default(),
            trusted: row.trusted != 0,
            initial: row
                .display_name
                .chars()
                .next()
                .map(|c| c.to_uppercase().to_string())
                .unwrap_or_else(|| "?".to_string()),
            color_index: row.id % 6,
            online: row
                .last_seen_at
                .map(|ts| now.saturating_sub(ts) < 300)
                .unwrap_or(false),
            avatar: row.avatar_hash.clone(),
            handle: row.handle,
            display_name: row.display_name,
            role_label: Role::parse(&row.role)
                .map(|r| r.label().to_string())
                .unwrap_or_else(|_| row.role.clone()),
            role: row.role,
            activated: row.activated_at.is_some(),
            created_at: format_date(row.created_at),
            created_from_now: format_relative(row.created_at, now),
            last_seen: row
                .last_seen_at
                .map(|ts| format_relative(ts, now))
                .unwrap_or_else(|| "从未登录".to_string()),
            email: row.email.clone().unwrap_or_default(),
            quota_human: human_bytes(row.quota_bytes.max(0) as u64),
            quota_gb: format!("{:.1}", row.quota_bytes.max(0) as f64 / 1_073_741_824.0),
            used_human: human_bytes(row.used_bytes.max(0) as u64),
            is_self: row.id == user.id,
        })
        .collect();
    // 版式编号从原始查询串里取（面板的 query 是用户搜索词，不能混用）
    // 已评审通过的是 v2（列表行 + 顶部上传）
    let pool_variant = if state.config.server.debug_pages {
        av.and_then(|v| v.parse::<u8>().ok())
            .filter(|v| (1..=3).contains(v))
            .unwrap_or(2)
    } else {
        2
    };
    // 用户组 + 人数 + 规则（人数少，直接逐个查，不值得为它写一条聚合 SQL）
    // 版式编号走 AdminQuery（从搜索词里找参数是错的 —— av= 那次就栽过）
    let acl_variant = if state.config.server.debug_pages {
        aui.and_then(|value| value.parse::<u8>().ok())
            .filter(|value| (1..=3).contains(value))
            .unwrap_or(1)
    } else {
        1
    };
    let db_path = state.config.paths.db_path();
    let ai_config = crate::ai::AiConfig::load(state.db.pool(), &db_path).await;
    let all_rules = repo::list_all_group_rules(state.db.pool()).await?;
    let mut groups = Vec::new();
    for group in repo::list_user_groups(state.db.pool(), true).await? {
        let members = repo::list_group_members(state.db.pool(), group.id).await?;
        let rules = all_rules
            .iter()
            .filter(|rule| rule.group_id == group.id)
            .map(|rule| {
                (
                    rule.section.clone(),
                    rule.can_post != 0,
                    rule.can_reply != 0,
                    rule.deny_post != 0,
                    rule.deny_reply != 0,
                )
            })
            .collect();
        groups.push(crate::templates::AdminGroupView {
            id: group.id,
            key: group.key,
            name: group.name,
            description: group.description,
            member_count: members.len() as i64,
            archived: group.archived_at.is_some(),
            rules,
        });
    }
    let default_avatars = repo::list_default_avatars(state.db.pool())
        .await?
        .into_iter()
        .map(|row| crate::templates::DefaultAvatarView {
            id: row.id,
            hash: row.hash,
            note: row.note,
            date: crate::templates::format_date(row.created_at),
        })
        .collect();
    // 分区发言权限矩阵的全部初值（含每个分区当前的角色门槛与生效的用户组）
    let acl_json = acl_json(&acl_sections, &groups);
    // 三个面板的初值走 JSON 交给 React 控件（模板只留挂载点，见 AGENTS §6.6）：
    // 行数据在 Rust 侧只序列化一次，模板里不再有第二份渲染逻辑
    let roles: Vec<(String, String)> = Role::ALL
        .iter()
        .map(|r| (r.as_str().to_string(), r.label().to_string()))
        .collect();
    let ban_options: Vec<(String, String)> = BAN_HOUR_OPTIONS
        .iter()
        .map(|(hours, label)| (hours.to_string(), label.to_string()))
        .collect();
    let block_reply_enforced =
        repo::site_text(state.db.pool(), "block_reply_enforced", "0").await? == "1";
    let sections: Vec<crate::templates::SectionOption> = {
        let covers: std::collections::HashMap<String, String> =
            repo::list_section_covers(state.db.pool())
                .await?
                .into_iter()
                .map(|(section, hash, _mime)| (section, hash))
                .collect();
        sc2clud_core::resource::PostSection::ALL
            .iter()
            .map(|s| crate::templates::SectionOption {
                value: s.as_str().to_string(),
                label: s.label().to_string(),
                checked: false,
                cover: covers.get(s.as_str()).cloned(),
                mode: section_modes.get(s.as_str()).copied().unwrap_or(0),
            })
            .collect()
    };
    let pending: Vec<FeedView> = pending_rows
        .iter()
        .map(|row| feed_view(row, Some(user.id)))
        .collect();
    let held_titles: Vec<(i64, Vec<i64>)> = repo::held_title_ids_for(
        state.db.pool(),
        &users.iter().map(|u| u.id).collect::<Vec<_>>(),
    )
    .await?
    .into_iter()
    .collect();
    let titles_json = crate::admin_title_catalog::titles_catalog_json(
        &repo::list_titles(state.db.pool(), true).await?,
        &repo::title_holder_counts(state.db.pool()).await?,
    );
    let users_json = crate::admin_titles::users_json(
        &users,
        &roles,
        &groups,
        &sections,
        &ban_options,
        &held_titles,
        &repo::list_titles(state.db.pool(), true).await?,
    );
    let pending_json = serde_json::json!(
        pending
            .iter()
            .map(|post| serde_json::json!({
                "id": post.id,
                "title": post.title,
                "sectionLabel": post.section_label,
                "kindLabel": post.kind_label,
                "preview": post.preview,
                "author": post.author,
                "timeAgo": post.time_ago,
            }))
            .collect::<Vec<_>>()
    )
    .to_string();
    let community_json =
        serde_json::json!({ "blockReplyEnforced": block_reply_enforced }).to_string();
    // 封面面板的初值：顺序就是当前分区顺序，首末位决定 ↑↓ 的禁用（改序后由控件自己重算）
    let covers_json = serde_json::json!({
        "sections": sections
            .iter()
            .enumerate()
            .map(|(index, section)| serde_json::json!({
                "value": section.value,
                "label": section.label,
                "cover": section.cover,
                "first": index == 0,
                "last": index + 1 == sections.len(),
            }))
            .collect::<Vec<_>>()
    })
    .to_string();
    Ok(AdminTemplate {
        default_avatars,
        pool_variant,
        acl_variant,
        acl_json,
        users_json,
        titles_json,
        pending_json,
        community_json,
        covers_json,
        groups,
        block_reply_enforced,
        ai_review_posts: ai_config.review_posts,
        ai_endpoint: ai_config.endpoint.clone(),
        ai_model: ai_config.model.clone(),
        ai_key_set: !ai_config.api_key.is_empty(),
        ai_prompt_new_post: ai_config.prompt_new_post.clone(),
        ai_prompt_report: ai_config.prompt_report.clone(),
        ai_reasoning_effort: ai_config.reasoning_effort.clone(),
        ai_review_comments: ai_config.review_comments,
        ai_review_on_report: ai_config.review_on_report,
        ban_options,
        server_free_human: human_bytes(free_bytes),
        quota_allocated_human: human_bytes(allocated.max(0) as u64),
        quota_used_human: human_bytes(used.max(0) as u64),
        quota_unused_human: human_bytes(unused as u64),
        quota_over_committed,
        query: query.to_string(),
        total_users,
        now,
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        is_staff: true,
        csrf: user.csrf_token.clone(),
        is_super: user.role == Role::Super,
        require_activation: repo::registration_requires_activation(state.db.pool()).await?,
        roles,
        users,
        sections,
        pending,
    })
}

pub async fn panel(
    State(state): State<AppState>,
    headers: HeaderMap,
    axum::extract::Query(query): axum::extract::Query<AdminQuery>,
) -> Response {
    let q = query.q.unwrap_or_default();
    match build_panel(
        &state,
        &headers,
        &q,
        query.av.as_deref(),
        query.aui.as_deref(),
    )
    .await
    {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

/// 新建用户组。
#[derive(Debug, Deserialize)]
pub struct SectionAclForm {
    pub csrf: String,
    pub post_min_role: String,
    pub reply_min_role: String,
    #[serde(default)]
    pub group_mode: Option<String>,
    /// 允许的用户组 id，逗号分隔（绿标签集合）。
    #[serde(default)]
    pub groups: String,
}

/// 打回：让作者改完再提交（状态置为 `revision`，并通知作者）。
pub async fn request_revision(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<ReviewForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ReviewPost)?;
    session::check_csrf(&actor, &form.csrf)?;
    let typed = form
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let note = typed.unwrap_or("请按审核意见修改后重新提交");
    let now = now_unix();
    let Some(post) = repo::get_post_for(state.db.pool(), id, Some(actor.id), true).await? else {
        return Err(AppError::not_found("帖子不存在"));
    };
    // 打回时把待审修改丢掉：作者改完再提交（避免旧修改一直挂着）
    let _ = repo::drop_pending_revision(state.db.pool(), id).await;
    if !repo::set_post_review_state(state.db.pool(), id, "revision", Some(note), actor.id, now)
        .await?
    {
        return Err(AppError::not_found("帖子不存在"));
    }
    let _ = repo::notify(
        state.db.pool(),
        repo::NewNotification {
            user_id: post.author_id,
            actor_id: Some(actor.id),
            kind: "review",
            title: &format!("你的帖子「{}」需要修改", post.title),
            body: Some(note),
            link: Some(&format!("/p/{id}/edit")),
            now,
        },
    )
    .await;
    tracing::info!(post.id = id, actor.id = actor.id, "打回修改");
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        "post.request_revision",
        Some(&format!("post:{id}")),
        Some(note),
        now,
    )
    .await;
    Ok(done(&headers, "已打回", "/admin/users/overview"))
}
