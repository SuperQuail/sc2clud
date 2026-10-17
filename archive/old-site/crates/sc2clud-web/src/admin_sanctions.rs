//! 管理页的处罚域：限期禁言、全站「被拉黑不能回复」开关、按类型/分区的处罚记录。
//!
//! 从 pages_admin.rs 拆出（该文件超出体量门禁的 500 行）。这一层只做
//! 「校验表单 → 调 repo → 回 done()」；处罚本身的判定与存储都在 repo 的 user_sanctions 表。

use axum::Form;
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use sc2clud_core::auth::{Permission, Role};
use sc2clud_core::{Error as DomainError, now_unix};
use sc2clud_db::repo;
use serde::Deserialize;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::pages_admin::done;
use crate::routes::require_user;
use crate::session;

/// 禁言 / 处罚时长选项（后台下拉用）：(值, 显示名)。0 = 解禁。
/// /admin/users/overview 的模板数据也从这里取，所以是 pub。
pub const BAN_HOUR_OPTIONS: [(i64, &str); 6] = [
    (0, "不禁言"),
    (1, "1 小时"),
    (24, "1 天"),
    (72, "3 天"),
    (168, "7 天"),
    (720, "30 天"),
];

/// 一次禁言/处罚的上限：一年（下拉选值和别人手填的小时数共用这个上限）。
const MAX_HOURS: i64 = 24 * 365;

#[derive(Debug, Deserialize)]
pub struct BanForm {
    pub csrf: String,
    /// 时长小时数：0 或空 = 解禁。
    #[serde(default)]
    pub hours: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct BlockReplyForm {
    pub csrf: String,
    /// "1" 开启 / "0" 关闭。
    pub enabled: String,
}

#[derive(Debug, Deserialize)]
pub struct SanctionForm {
    pub csrf: String,
    /// post / reply
    pub kind: String,
    /// 空串 = 全局，否则是分区 key
    #[serde(default)]
    pub section: String,
    /// 到期时间：3d / 12h / 2026-10-20 12:00；留空表示解除
    #[serde(default)]
    pub until: String,
}

/// 限期禁言 / 解禁：hours = 0 解禁，其余为小时数。管理员及以上不能被禁（避免管理员互相锁死）。
pub async fn ban_user(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<BanForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let target = repo::find_user_by_id(state.db.pool(), id)
        .await?
        .ok_or_else(|| AppError::not_found("用户不存在"))?;
    reject_staff(&target.role, "禁言")?;

    let hours: i64 = form
        .hours
        .as_deref()
        .unwrap_or("0")
        .trim()
        .parse()
        .unwrap_or(0)
        .clamp(0, MAX_HOURS);
    let now = now_unix();
    let until = if hours > 0 {
        Some(now + hours * 3600)
    } else {
        None
    };
    // 写进处罚表（全局禁止发帖）；解禁时撤销同一类同范围的处罚
    if let Some(until) = until {
        repo::add_sanction(state.db.pool(), id, "post", "", until, Some(actor.id), now).await?;
    } else {
        repo::revoke_sanctions(state.db.pool(), id, "post", "", now).await?;
    }
    // 兼容：老的单列也一并清掉，免得两个地方各说各话
    repo::set_post_ban(state.db.pool(), id, until).await?;
    tracing::info!(user.id = id, hours, actor.id = actor.id, "限期禁言");
    let message = if hours > 0 {
        "已设置禁言"
    } else {
        "已解除禁言"
    };
    Ok(done(&headers, message, "/admin/users/overview"))
}

/// 全站开关：被拉黑后能否在对方帖子下回复。
pub async fn set_block_reply(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<BlockReplyForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let value = if form.enabled == "1" { "1" } else { "0" };
    repo::set_site_text(
        state.db.pool(),
        "block_reply_enforced",
        value,
        Some(actor.id),
        now_unix(),
    )
    .await?;
    tracing::info!(
        enabled = value,
        actor.id = actor.id,
        "设置「被拉黑不能回复」开关"
    );
    Ok(done(
        &headers,
        "设置已保存",
        "/admin/users/overview#settings",
    ))
}

/// 设置或解除一条处罚。until 留空 = 撤销同类同范围的处罚。
pub async fn set_sanction(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<SanctionForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ManageUsers)?;
    session::check_csrf(&actor, &form.csrf)?;
    let kind = if form.kind == "reply" {
        "reply"
    } else {
        "post"
    };
    let section = form.section.trim();
    if !section.is_empty() {
        repo::get_section(state.db.pool(), section)
            .await?
            .ok_or_else(|| AppError::Domain(DomainError::InvalidInput("分区不存在".to_string())))?;
    }
    let target = repo::find_user_by_id(state.db.pool(), id)
        .await?
        .ok_or_else(|| AppError::not_found("用户不存在"))?;
    reject_staff(&target.role, "处罚")?;

    let now = now_unix();
    let message = match parse_instant(&form.until, now) {
        Some(until) if until > now => {
            repo::add_sanction(
                state.db.pool(),
                id,
                kind,
                section,
                until,
                Some(actor.id),
                now,
            )
            .await?;
            "处罚已生效"
        }
        Some(_) => {
            repo::revoke_sanctions(state.db.pool(), id, kind, section, now).await?;
            "时间已过，按解除处理"
        }
        None => {
            repo::revoke_sanctions(state.db.pool(), id, kind, section, now).await?;
            "已解除"
        }
    };
    tracing::info!(
        user.id = id,
        kind,
        section,
        raw = form.until,
        actor.id = actor.id,
        "设置处罚"
    );
    Ok(done(&headers, message, "/admin/users/overview"))
}

/// 管理员及以上不接受处罚（避免管理员互相锁死）。what 只进文案：禁言 / 处罚。
fn reject_staff(role: &str, what: &str) -> AppResult<()> {
    if Role::parse(role).is_ok_and(|role| role >= Role::Admin) {
        return Err(AppError::Domain(DomainError::InvalidInput(format!(
            "管理员及以上不接受{what}"
        ))));
    }
    Ok(())
}

/// 把后台输入的到期时间解析成 unix 秒：
/// - 纯数字 = 小时数（兼容老的「禁言 N 小时」下拉）；
/// - 时长：3d / 12h / 30m / 90s（相对现在）；
/// - 日期：2026-10-20 12:00 或 2026-10-20（按 UTC 解释，服务器就是 UTC）。
pub fn parse_instant(raw: &str, now: i64) -> Option<i64> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(hours) = text.parse::<i64>() {
        return Some(now + hours.clamp(0, MAX_HOURS) * 3600);
    }
    // 单位可能是多字节字符（如「3天」）：按 char 边界切，按字节切会 panic
    let (cut, _) = text.char_indices().next_back()?;
    let (digits, unit) = text.split_at(cut);
    if let Ok(amount) = digits.trim().parse::<i64>() {
        let seconds = match unit {
            "m" | "M" => Some(amount * 60),
            "h" | "H" => Some(amount * 3600),
            "d" | "D" => Some(amount * 86400),
            "s" | "S" => Some(amount),
            _ => None,
        };
        if let Some(seconds) = seconds {
            return Some(now + seconds.clamp(60, 365 * 86400));
        }
    }
    for format in [
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
        "%Y-%m-%d",
    ] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(text, format) {
            return Some(naive.and_utc().timestamp());
        }
        if let Ok(date) = chrono::NaiveDate::parse_from_str(text, format) {
            return Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp());
        }
    }
    None
}
