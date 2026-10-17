//! 管理页的发信配置：账号增删改、全局开关、测试发信。
//!
//! 这一层只做「解析表单 → 调 repo / crate::mail → 回 JSON」。选号与故障转移在
//! crate::mail，凭据加密在 sc2clud-db；provider 专属知识只剩「密钥字段叫什么」，
//! 那也在 crate::mail::secret_payload 里，这里不认识任何具体的邮箱服务商。

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Response};
use axum::{Form, Json};
use sc2clud_core::auth::Permission;
use sc2clud_core::now_unix;
use sc2clud_db::models::MailAccountDraft;
use sc2clud_db::repo;
use serde::Deserialize;
use serde_json::json;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::mail;
use crate::pages_admin::done;
use crate::routes::require_user;
use crate::session;
use crate::templates::{AdminMailTemplate, render};

/// 数值开关的范围，报文里来的数字一律先夹进来再落库。
const PER_MINUTE_RANGE: std::ops::RangeInclusive<i64> = 1..=600;
const COOLDOWN_RANGE: std::ops::RangeInclusive<i64> = 0..=86_400;
const TTL_RANGE: std::ops::RangeInclusive<i64> = 60..=86_400;

fn clamp(value: i64, range: std::ops::RangeInclusive<i64>) -> i64 {
    value.clamp(*range.start(), *range.end())
}

/// 岛初值：全局开关 + 账号列表。管理页低频，每次现读库，不做缓存。
async fn mail_json(state: &AppState) -> AppResult<String> {
    let pool = state.db.pool();
    let settings = mail::settings(pool).await;
    let accounts = repo::list_mail_accounts(pool, true).await?;

    let mut items = Vec::with_capacity(accounts.len());
    for account in &accounts {
        items.push(json!({
            "id": account.id,
            "provider": account.provider,
            "label": account.label,
            "priority": account.priority,
            "fromAddress": account.from_address,
            "fromName": account.from_name,
            "replyTo": account.reply_to,
            "options": serde_json::from_str::<serde_json::Value>(&account.options_json)
                .unwrap_or_else(|_| json!({})),
            "dailyQuota": account.daily_quota,
            "sentToday": account.sent_today,
            "quotaDay": account.quota_day,
            "enabled": account.enabled != 0,
            "cooldownUntil": account.cooldown_until.unwrap_or(0),
            "lastOkAt": account.last_ok_at.unwrap_or(0),
            "lastError": account.last_error,
            "lastErrorAt": account.last_error_at.unwrap_or(0),
            "archived": account.archived_at.is_some(),
            "updatedAt": account.updated_at,
            // 只看有没有密文，不解密：列表页不该把密钥明文读进内存。
            "secretSet": repo::mail_secret_set(pool, account.id).await.unwrap_or(false),
        }));
    }

    Ok(json!({
        "now": now_unix(),
        "settings": {
            "enabled": settings.enabled,
            "perMinute": settings.per_minute,
            "cooldownSeconds": settings.cooldown_seconds,
            "codeTtlSeconds": settings.code_ttl_seconds,
        },
        "accounts": items,
        "providers": mail::providers(),
    })
    .to_string())
}

/// /admin/mail：发信配置页。
pub async fn page(State(state): State<AppState>, headers: HeaderMap) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    Ok(render(AdminMailTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(actor.display_name.clone()),
        is_staff: actor.is_staff(),
        csrf: actor.csrf_token.clone(),
        mail_json: mail_json(&state).await?,
    }))
}

// ---------------------------------------------------------------- 全局开关

#[derive(Debug, Deserialize)]
pub struct SettingsForm {
    pub csrf: String,
    /// 复选框：有值即开启。
    #[serde(default)]
    pub enabled: Option<String>,
    #[serde(default)]
    pub per_minute: i64,
    #[serde(default)]
    pub cooldown_seconds: i64,
    #[serde(default)]
    pub code_ttl_seconds: i64,
}

pub async fn save_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<SettingsForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;

    let now = now_unix();
    let pool = state.db.pool();
    let values = [
        (
            "mail_enabled",
            if form.enabled.is_some() { "1" } else { "0" }.to_string(),
        ),
        (
            "mail_per_minute",
            clamp(form.per_minute, PER_MINUTE_RANGE).to_string(),
        ),
        (
            "mail_cooldown_seconds",
            clamp(form.cooldown_seconds, COOLDOWN_RANGE).to_string(),
        ),
        (
            "mail_code_ttl_seconds",
            clamp(form.code_ttl_seconds, TTL_RANGE).to_string(),
        ),
    ];
    for (key, value) in values {
        repo::set_site_text(pool, key, &value, Some(actor.id), now).await?;
    }
    tracing::info!(
        actor.id = actor.id,
        enabled = form.enabled.is_some(),
        "保存发信配置"
    );
    Ok(done(&headers, "发信配置已保存", "/admin/mail"))
}

// ---------------------------------------------------------------- 发信账号

#[derive(Debug, Deserialize)]
pub struct AccountForm {
    pub csrf: String,
    pub provider: String,
    pub from_address: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub priority: i64,
    #[serde(default)]
    pub from_name: String,
    #[serde(default)]
    pub reply_to: String,
    /// provider 专属的非敏感参数（前端拼好的 JSON 对象字符串）。
    #[serde(default)]
    pub options_json: String,
    #[serde(default)]
    pub daily_quota: i64,
    /// 复选框：有值即启用。
    #[serde(default)]
    pub enabled: Option<String>,
    /// 密钥明文。留空 = 不改（编辑时永不回显）。
    #[serde(default)]
    pub secret: String,
}

fn account_draft(form: &AccountForm, actor_id: i64) -> AppResult<MailAccountDraft> {
    let provider = form.provider.trim();
    let _ = mail::secret_field(provider).map_err(AppError::rejected)?;

    let from_address = form.from_address.trim();
    if !from_address.contains('@') {
        return Err(AppError::rejected("发件地址要像个邮箱"));
    }
    let options_json = if form.options_json.trim().is_empty() {
        "{}".to_string()
    } else {
        form.options_json.trim().to_string()
    };
    let parsed: serde_json::Value = serde_json::from_str(&options_json)
        .map_err(|_| AppError::rejected("provider 参数不是合法 JSON"))?;
    if !parsed.is_object() {
        return Err(AppError::rejected("provider 参数得是 JSON 对象"));
    }

    Ok(MailAccountDraft {
        provider: provider.to_string(),
        label: form.label.trim().to_string(),
        priority: form.priority.clamp(0, 100_000),
        from_address: from_address.to_string(),
        from_name: form.from_name.trim().to_string(),
        reply_to: form.reply_to.trim().to_string(),
        options_json,
        daily_quota: form.daily_quota.max(0),
        enabled: form.enabled.is_some(),
        actor_id: Some(actor_id),
    })
}

/// 存密钥（表单留空则整个跳过，保留原密钥）。
async fn store_secret(
    state: &AppState,
    account_id: i64,
    provider: &str,
    secret: &str,
    actor_id: i64,
) -> AppResult<()> {
    let secret = secret.trim();
    if secret.is_empty() {
        return Ok(());
    }
    let payload = mail::secret_payload(provider, secret).map_err(AppError::rejected)?;
    repo::set_mail_secret(
        state.db.pool(),
        &state.config.paths.db_path(),
        account_id,
        &payload,
        Some(actor_id),
        now_unix(),
    )
    .await?;
    Ok(())
}

pub async fn create_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<AccountForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;

    let draft = account_draft(&form, actor.id)?;
    let id = repo::add_mail_account(state.db.pool(), &draft, now_unix()).await?;
    store_secret(&state, id, &draft.provider, &form.secret, actor.id).await?;
    tracing::info!(
        actor.id = actor.id,
        account.id = id,
        provider = %draft.provider,
        "新增发信账号"
    );
    Ok(done(&headers, "账号已添加", "/admin/mail"))
}

pub async fn update_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Form(form): Form<AccountForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;

    let draft = account_draft(&form, actor.id)?;
    let changed = repo::update_mail_account(state.db.pool(), id, &draft, now_unix()).await?;
    if !changed {
        return Err(AppError::not_found("账号不存在"));
    }
    store_secret(&state, id, &draft.provider, &form.secret, actor.id).await?;
    tracing::info!(actor.id = actor.id, account.id = id, "修改发信账号");
    Ok(done(&headers, "账号已保存", "/admin/mail"))
}

#[derive(Debug, Deserialize)]
pub struct FlagForm {
    pub csrf: String,
    #[serde(default)]
    pub value: Option<String>,
}

/// 启停一个账号（不动 archived_at）。
pub async fn set_enabled(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Form(form): Form<FlagForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;

    let enabled = form.value.is_some();
    if !repo::set_mail_enabled(state.db.pool(), id, enabled, now_unix()).await? {
        return Err(AppError::not_found("账号不存在"));
    }
    tracing::info!(
        actor.id = actor.id,
        account.id = id,
        enabled,
        "启停发信账号"
    );
    Ok(done(
        &headers,
        if enabled {
            "账号已启用"
        } else {
            "账号已停用"
        },
        "/admin/mail",
    ))
}

/// 归档 / 恢复一个账号。
pub async fn archive_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Form(form): Form<FlagForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;

    let archived = form.value.is_some();
    if !repo::archive_mail_account(state.db.pool(), id, archived, now_unix()).await? {
        return Err(AppError::not_found("账号状态没变化"));
    }
    tracing::info!(
        actor.id = actor.id,
        account.id = id,
        archived,
        "归档发信账号"
    );
    Ok(done(
        &headers,
        if archived {
            "账号已归档"
        } else {
            "账号已恢复"
        },
        "/admin/mail",
    ))
}

#[derive(Debug, Deserialize)]
pub struct TestForm {
    pub csrf: String,
    pub to: String,
}

/// 用指定账号真发一封测试信：这是「这条链路通不通」唯一的验收手段。
pub async fn test_send(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Form(form): Form<TestForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;

    let to = form.to.trim();
    if !to.contains('@') {
        return Err(AppError::rejected("收件地址要像个邮箱"));
    }

    let message = mail::Outgoing {
        to: to.to_string(),
        subject: "SC2clud 发信测试".to_string(),
        html: "<p>这是 SC2clud 后台发出的测试邮件。收到即说明该账号可用。</p>".to_string(),
        text: "这是 SC2clud 后台发出的测试邮件。收到即说明该账号可用。".to_string(),
        reply_to: None,
        idempotency_key: Some(format!("test-{}-{}", id, now_unix())),
    };

    Ok(
        Json(match mail::send_with_account(&state, id, &message).await {
            Ok(sent) => json!({
                "ok": true,
                "message": format!("已由 {} 发出，消息 id {}", sent.provider, sent.message_id),
            }),
            Err(error) => json!({ "ok": false, "message": error.to_string() }),
        })
        .into_response(),
    )
}
