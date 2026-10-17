//! 管理页的 AI 审核：配置读写、连通性测试、文本预览、手动触发一次审查。
//!
//! 从 pages_admin.rs 拆出（该文件超出体量门禁的 500 行）。这一层只做
//! 「解析表单 → 调 crate::ai / repo → 返回」；判定规则在 core::review，HTTP 调用在 crate::ai。

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::{Form, Json};
use sc2clud_core::auth::Permission;
use sc2clud_core::now_unix;
use sc2clud_core::resource::PostSection;
use sc2clud_core::review::{comment_review_text, post_review_text};
use sc2clud_db::repo;
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::ai::{self, AiConfig};
use crate::error::{AppError, AppResult};
use crate::pages_admin::done;
use crate::routes::require_user;
use crate::session;

#[derive(Debug, Deserialize)]
pub struct AiSettingsForm {
    pub csrf: String,
    /// 帖子审核开关。
    #[serde(default)]
    pub review_posts: Option<String>,
    pub endpoint: String,
    pub model: String,
    /// 留空表示不改密钥。
    #[serde(default)]
    pub api_key: String,
    pub prompt_new_post: String,
    pub prompt_report: String,
    /// 推理强度：留空 / none / low / high / max。
    #[serde(default)]
    pub reasoning_effort: String,
    #[serde(default)]
    pub review_comments: Option<String>,
    #[serde(default)]
    pub review_on_report: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AiTargetForm {
    pub csrf: String,
    /// post | comment
    #[serde(default)]
    pub kind: String,
    pub id: i64,
    /// 只看文本化结果，不调用 AI
    #[serde(default)]
    pub dry_run: Option<String>,
}

/// 复选框 → "1"/"0"。
fn flag(value: Option<&str>) -> &'static str {
    if value == Some("1") { "1" } else { "0" }
}

/// 保存 AI 审核配置（密钥单独加密存表；留空则保留原密钥）。
pub async fn save_ai_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<AiSettingsForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let now = now_unix();
    let pool = state.db.pool();
    let settings = [
        ("ai_review_posts", flag(form.review_posts.as_deref())),
        ("ai_endpoint", form.endpoint.trim()),
        ("ai_model", form.model.trim()),
        ("ai_prompt_new_post", form.prompt_new_post.trim()),
        ("ai_prompt_report", form.prompt_report.trim()),
        ("ai_reasoning_effort", form.reasoning_effort.trim()),
        ("ai_review_comments", flag(form.review_comments.as_deref())),
        (
            "ai_review_on_report",
            flag(form.review_on_report.as_deref()),
        ),
    ];
    for (key, value) in settings {
        repo::set_ai_setting(pool, key, value, now).await?;
    }
    if !form.api_key.trim().is_empty() {
        repo::set_ai_key(
            pool,
            &state.config.paths.db_path(),
            form.api_key.trim(),
            Some(actor.id),
            now,
        )
        .await?;
    }
    tracing::info!(actor.id = actor.id, "保存 AI 审核配置");
    Ok(done(&headers, "AI 配置已保存", "/admin/users/overview#ai"))
}

/// 连通性测试：真发一次最短请求。
pub async fn test_ai(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    let config = AiConfig::load(state.db.pool(), &state.config.paths.db_path()).await;
    Ok(Json(match ai::test_connection(&config).await {
        Ok(message) => json!({ "ok": true, "message": message }),
        Err(error) => json!({ "ok": false, "message": error }),
    })
    .into_response())
}

/// 预览「帖子/评论会怎么文本化发给 AI」；dry_run=1 时只回文本、不调用。
pub async fn preview_ai_text(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<AiTargetForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let text = ai_target_text(&state, &form.kind, form.id).await?;
    Ok(Json(json!({ "ok": true, "text": text })).into_response())
}

/// 立刻审一次（人工点「审核」），把判词落到帖子状态并留痕。
pub async fn run_ai_review(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<AiTargetForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let kind = if form.kind == "comment" {
        "comment"
    } else {
        "post"
    };
    let text = ai_target_text(&state, kind, form.id).await?;
    let config = AiConfig::load(state.db.pool(), &state.config.paths.db_path()).await;
    Ok(Json(
        match run_review(&state, &config, kind, form.id, &text, "manual", true).await {
            Ok((verdict, reason)) => json!({ "ok": true, "verdict": verdict, "reason": reason }),
            Err(error) => json!({ "ok": false, "message": error }),
        },
    )
    .into_response())
}

/// 取一段要被审核的文本（帖子含来源，评论带上所属帖子标题）。
pub(crate) async fn ai_target_text(state: &AppState, kind: &str, id: i64) -> AppResult<String> {
    if kind == "comment" {
        let post_id = repo::comment_post_id(state.db.pool(), id)
            .await?
            .ok_or_else(|| AppError::not_found("评论不存在"))?;
        let post = repo::get_post_for(state.db.pool(), post_id, None, true)
            .await?
            .ok_or_else(|| AppError::not_found("帖子不存在"))?;
        let author_id = repo::comment_author(state.db.pool(), id)
            .await?
            .unwrap_or(0);
        let author = repo::find_user_by_id(state.db.pool(), author_id)
            .await?
            .map(|user| user.display_name)
            .unwrap_or_else(|| "未知".to_string());
        let body = repo::comment_body(state.db.pool(), id)
            .await?
            .unwrap_or_default();
        return Ok(comment_review_text(&body, &author, &post.title));
    }
    let post = repo::get_post_for(state.db.pool(), id, None, true)
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在"))?;
    let section = PostSection::parse(&post.section)
        .map(|section| section.label().to_string())
        .unwrap_or_else(|_| post.section.clone());
    let author = repo::find_user_by_id(state.db.pool(), post.author_id)
        .await?
        .map(|user| user.display_name)
        .unwrap_or_else(|| "未知".to_string());
    // shortcut: 帖子的下载来源暂不拼进审核文本（来源行的字段名待确认），要加时再补
    Ok(post_review_text(
        &post.title,
        &section,
        &post.body,
        &author,
        &[],
    ))
}

/// 跑一次审核 + 留痕（+ 帖子落状态）。返回 (判词, 理由)。
pub async fn run_review(
    state: &AppState,
    config: &AiConfig,
    kind: &str,
    id: i64,
    text: &str,
    source: &str,
    // 新帖/举报/手动 = true（判词直接落到帖子上）；编辑 = false（由编辑流程自己决定要不要应用修订）
    apply_state: bool,
) -> Result<(String, String), String> {
    let now = now_unix();
    // 第一次；失败自动重试一次（偶发不调工具/网络抖动靠这一次救回来）
    let mut attempt = ai::review_text(config, text, kind, source).await;
    if attempt.is_err() {
        tracing::warn!(kind, id, source, "AI 审核第一次失败，自动重试一次");
        attempt = ai::review_text(config, text, kind, source).await;
    }
    match attempt {
        Ok(review) => {
            let verdict = review.verdict.as_str().to_string();
            let reason = review.reason.clone();
            let _ = repo::log_ai_review(
                state.db.pool(),
                kind,
                id,
                source,
                &verdict,
                &reason,
                &review.raw.chars().take(2000).collect::<String>(),
                &config.model,
                true,
                now,
            )
            .await;
            if kind == "post" && apply_state {
                let _ = repo::set_post_review_state_auto(
                    state.db.pool(),
                    id,
                    review.verdict.review_state(),
                    &reason,
                    now,
                )
                .await;
            }
            Ok((verdict, reason))
        }
        Err(error) => {
            // 两次都没成：记留痕，并把内容放进人工队列，帖子里明确写上 AI 审核报错
            let _ = repo::log_ai_review(
                state.db.pool(),
                kind,
                id,
                source,
                "error",
                &error,
                "",
                &config.model,
                false,
                now,
            )
            .await;
            if kind == "post" && apply_state {
                let _ = repo::set_post_review_state_auto(
                    state.db.pool(),
                    id,
                    "pending",
                    &format!("AI 审核失败，已转人工：{error}"),
                    now,
                )
                .await;
            }
            Err(error)
        }
    }
}
