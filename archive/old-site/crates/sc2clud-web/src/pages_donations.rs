//! 打赏记录：用户登记、管理员人工验证、按被打赏人统计。
//!
//! 为什么是「人工验证」：本站**不经手资金** —— 访客扫的是作者自己挂的收款码
//! （0013 `payment_channels`），钱直接进作者口袋。站点无法自动核对到账，
//! 只能由用户自报金额与订单号、管理员核对后拍板。由此：
//!
//! - 所有对外统计只认 `approved`（见 `repo::donation_summary_of_donor` 等）；
//! - 收入侧只累加「捐赠方已同意公开」的记录，避免绕过别人的隐私开关。

use axum::Form;
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use serde::Deserialize;

use sc2clud_core::auth::Permission;
use sc2clud_core::donation::{
    DonationState, MAX_DONATION_CENTS, format_amount, parse_amount, validate_not_self,
    validate_paid_at, validate_txn_id,
};
use sc2clud_core::now_unix;
use sc2clud_db::repo::{self, NewDonationRecord, NewNotification};

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::routes::require_user;
use crate::session;
use crate::templates::{
    AdminDonationRow, AdminDonationsTemplate, DonationNewTemplate, DonationSummaryView,
    DonationTab, DonationsTemplate, MyDonationRow, format_date, render,
};

/// 列表分页大小。管理端队列必须分页（2 vCPU 的机器上不一次拉全表）。
const PAGE_SIZE: i64 = 50;
/// 排行榜条数。
const LEADERBOARD_SIZE: i64 = 10;

// ---------------------------------------------------------------- 时间解析

/// 把表单里的时间解析成 Unix 秒。
///
/// **一律按 UTC 解析**，与 `templates::format_date`（也是 UTC）严格对齐 ——
/// 否则「填 2026-10-11、显示 2026-10-10」这种整体差一天的 bug 必然出现。
/// 时区偏移带来的「选今天被判成未来」问题由 `validate_paid_at` 的容差兜住。
fn parse_paid_at(raw: &str) -> Option<i64> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    for format in ["%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(text, format) {
            return Some(naive.and_utc().timestamp());
        }
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d") {
        return Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp());
    }
    None
}

/// 向上取整的除法。
///
/// i64 的 div_ceil 对有符号整数仍是 unstable（int_roundings），自己算。
fn pages_of(total: i64, size: i64) -> i64 {
    if total <= 0 {
        1
    } else {
        (total + size - 1) / size
    }
}

/// 今天的日期（回填 date 输入框）。
fn today_str() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

// ---------------------------------------------------------------- 帖子归属

/// 解析并校验「这笔打赏归属哪篇帖子」。
///
/// 帖子必须存在、未删除，且**作者就是被登记的那个人** —— 否则会出现
/// 「把打赏挂到别人帖子下」的错配。返回 (帖子 id, 标题)。
async fn resolve_post(
    pool: &sqlx::SqlitePool,
    raw: Option<&str>,
    recipient_id: i64,
) -> AppResult<Option<(i64, String)>> {
    let Some(text) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    let Ok(post_id) = text.parse::<i64>() else {
        return Err(AppError::rejected("帖子参数不正确"));
    };
    let Some(post) = repo::get_post(pool, post_id).await? else {
        return Err(AppError::not_found("找不到这篇帖子"));
    };
    if post.author_id != recipient_id {
        return Err(AppError::rejected("这篇帖子不是该作者的"));
    }
    Ok(Some((post.id, post.title)))
}

// ---------------------------------------------------------------- 我的记录

#[derive(Debug, Deserialize)]
pub struct MineQuery {
    #[serde(default)]
    pub ok: Option<String>,
    #[serde(default)]
    pub err: Option<String>,
    #[serde(default)]
    pub page: Option<i64>,
}

fn mine_notice(ok: Option<&str>, err: Option<&str>) -> (Option<String>, Option<String>) {
    let notice = match ok {
        Some("submitted") => Some("已提交，等待管理员验证后计入统计".to_string()),
        Some("withdrawn") => Some("已撤回这条待验证的记录".to_string()),
        _ => None,
    };
    let error = match err {
        Some("notfound") => Some("记录不存在，或状态已变化无法撤回".to_string()),
        _ => None,
    };
    (notice, error)
}

pub async fn mine(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<MineQuery>,
) -> Response {
    match build_mine(&state, &headers, query).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

async fn build_mine<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
    query: MineQuery,
) -> AppResult<DonationsTemplate<'a>> {
    let user = require_user(state, headers).await?;
    session::guard(Some(&user), Permission::SubmitDonation)?;
    let pool = state.db.pool();

    let page = query.page.unwrap_or(1).max(1);
    let total_count = repo::count_donations_by_donor(pool, user.id).await?;
    let records = repo::list_donations_by_donor(pool, user.id, PAGE_SIZE, (page - 1) * PAGE_SIZE)
        .await?
        .into_iter()
        .map(|row| {
            let state = DonationState::parse(&row.state).unwrap_or(DonationState::Pending);
            MyDonationRow {
                id: row.id,
                to_name: display_or_handle(&row.recipient_name, &row.recipient_handle),
                to_handle: row.recipient_handle,
                to_avatar: row.recipient_avatar,
                amount: format_amount(row.amount_cents),
                txn_id: row.txn_id,
                paid_at: format_date(row.paid_at),
                state: state.as_str().to_string(),
                state_label: state.label().to_string(),
                review_note: row.review_note.unwrap_or_default(),
                settled: row.settled_at.is_some(),
                post_id: row.post_id,
                post_title: row.post_title,
                can_withdraw: state == DonationState::Pending,
            }
        })
        .collect::<Vec<_>>();

    // 支出侧：这是我自己的数据，本人始终可见。
    let outgoing = repo::donation_summary_of_donor(pool, user.id)
        .await?
        .into_iter()
        .map(summary_view)
        .collect::<Vec<_>>();
    // 收入侧：只累计捐赠方已公开的部分。
    let incoming = repo::donation_total_of_recipient(pool, user.id).await?;
    let (unsettled, _) = repo::unsettled_total_of_recipient(pool, user.id).await?;
    let leaderboard = repo::donation_leaderboard(pool, LEADERBOARD_SIZE)
        .await?
        .into_iter()
        .map(summary_view)
        .collect::<Vec<_>>();

    let (notice, error) = mine_notice(query.ok.as_deref(), query.err.as_deref());
    let total_pages = pages_of(total_count, PAGE_SIZE);
    let page_q = |p: i64| Some(format!("/donations?page={p}"));
    Ok(DonationsTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        is_staff: user.is_staff(),
        csrf: user.csrf_token.clone(),
        notice,
        error,
        records,
        total_count,
        page,
        previous_page: (page > 1).then(|| page_q(page - 1)).flatten(),
        next_page: (page < total_pages).then(|| page_q(page + 1)).flatten(),
        records_public: repo::donation_records_public(pool, user.id).await?,
        outgoing,
        incoming_total: format_amount(incoming),
        unsettled_total: format_amount(unsettled),
        leaderboard,
    })
}

fn summary_view(row: sc2clud_db::models::DonationSummaryRow) -> DonationSummaryView {
    DonationSummaryView {
        handle: row.handle.clone(),
        display_name: display_or_handle(&row.display_name, &row.handle),
        avatar: row.avatar_hash,
        total: format_amount(row.total_cents),
        count: row.count,
    }
}

/// 显示名可能为空串（存量数据），兜底用登录名。
fn display_or_handle(name: &str, handle: &str) -> String {
    if name.trim().is_empty() {
        handle.to_string()
    } else {
        name.to_string()
    }
}

// ---------------------------------------------------------------- 提交

#[derive(Debug, Deserialize)]
pub struct NewQuery {
    #[serde(default)]
    pub to: String,
    /// 从帖子页进来时带上帖子 id。
    #[serde(default)]
    pub post: Option<i64>,
}

pub async fn new_form(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<NewQuery>,
) -> Response {
    match build_new(&state, &headers, query).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

async fn build_new<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
    query: NewQuery,
) -> AppResult<DonationNewTemplate<'a>> {
    let user = require_user(state, headers).await?;
    session::guard(Some(&user), Permission::SubmitDonation)?;
    let to_handle = query.to.trim().trim_start_matches('@').to_string();
    if to_handle.is_empty() {
        return Err(AppError::rejected("请从作者主页或帖子页进入登记页面"));
    }
    let Some(recipient) = repo::find_user_by_handle(state.db.pool(), &to_handle).await? else {
        return Err(AppError::not_found("找不到这位作者"));
    };
    if recipient.id == user.id {
        return Err(AppError::rejected("不能给自己登记打赏记录"));
    }
    // 收款码是否开着：没开也允许登记（可能走的是线下转账），只给个提示。
    let accepts = repo::donation_visible(state.db.pool(), recipient.id).await?
        && !repo::list_payment_channels(state.db.pool(), recipient.id)
            .await?
            .is_empty();
    let (post_id, post_title) = match query.post {
        Some(pid) => {
            let Some(post) = repo::get_post(state.db.pool(), pid).await? else {
                return Err(AppError::not_found("找不到这篇帖子"));
            };
            if post.author_id != recipient.id {
                return Err(AppError::rejected("这篇帖子不是该作者的"));
            }
            (Some(post.id), Some(post.title))
        }
        None => (None, None),
    };
    Ok(DonationNewTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        is_staff: user.is_staff(),
        csrf: user.csrf_token.clone(),
        to_handle: recipient.handle.clone(),
        to_name: display_or_handle(&recipient.display_name, &recipient.handle),
        to_avatar: recipient.avatar_hash.clone(),
        to_accepts_donation: accepts,
        post_id,
        post_title,
        error: None,
        today: today_str(),
        max_yuan: MAX_DONATION_CENTS / 100,
    })
}

#[derive(Debug, Deserialize)]
pub struct DonationForm {
    pub csrf: String,
    /// 被打赏人 handle。
    pub to: String,
    pub amount: String,
    #[serde(default)]
    pub txn_id: String,
    /// 打赏日期；留空表示「现在」。
    #[serde(default)]
    pub paid_at: String,
    /// 归属帖子 id（帖子页登记时带上，主页登记为空）。
    #[serde(default)]
    pub post: String,
}

pub async fn submit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<DonationForm>,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::SubmitDonation)?;
    session::check_csrf(&user, &form.csrf)?;
    let pool = state.db.pool();
    let now = now_unix();

    let to_handle = form.to.trim().trim_start_matches('@');
    let Some(recipient) = repo::find_user_by_handle(pool, to_handle).await? else {
        return Err(AppError::not_found("找不到这位作者"));
    };
    validate_not_self(user.id, recipient.id)?;
    let amount_cents = parse_amount(&form.amount)?;
    let txn_id = validate_txn_id(&form.txn_id)?;
    let paid_at = match parse_paid_at(&form.paid_at) {
        Some(ts) => ts,
        None if form.paid_at.trim().is_empty() => now,
        None => {
            return Err(AppError::from(sc2clud_core::Error::InvalidInput(
                "打赏日期格式不正确".to_string(),
            )));
        }
    };
    validate_paid_at(paid_at, now)?;
    // 归属帖子：帖作者必须就是收款人（防止把打赏挂到别人帖子下）
    let post = resolve_post(pool, Some(&form.post), recipient.id).await?;

    let id = repo::create_donation_record(
        pool,
        NewDonationRecord {
            donor_id: user.id,
            recipient_id: recipient.id,
            amount_cents,
            txn_id: &txn_id,
            paid_at,
            post_id: post.as_ref().map(|(id, _)| *id),
            now,
        },
    )
    .await?;
    tracing::info!(
        donation.id = id,
        donor.id = user.id,
        recipient.id = recipient.id,
        amount_cents,
        "提交打赏记录（待验证）"
    );
    Ok(Redirect::to("/donations?ok=submitted").into_response())
}

#[derive(Debug, Deserialize)]
pub struct WithdrawForm {
    pub csrf: String,
}

/// 撤回自己**待验证**的记录。
pub async fn withdraw(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<WithdrawForm>,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::SubmitDonation)?;
    session::check_csrf(&user, &form.csrf)?;
    let now = now_unix();
    if repo::delete_own_pending_donation(state.db.pool(), id, user.id, now).await? {
        tracing::info!(donation.id = id, user.id = user.id, "撤回待验证的打赏记录");
        Ok(Redirect::to("/donations?ok=withdrawn").into_response())
    } else {
        Ok(Redirect::to("/donations?err=notfound").into_response())
    }
}

// ---------------------------------------------------------------- 管理端

#[derive(Debug, Deserialize)]
pub struct QueueQuery {
    #[serde(default)]
    pub tab: Option<String>,
    #[serde(default)]
    pub page: Option<i64>,
}

pub async fn admin_queue(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<QueueQuery>,
) -> Response {
    match build_queue(&state, &headers, query).await {
        Ok(template) => render(template),
        Err(e) => e.into_page_response(true),
    }
}

async fn build_queue<'a>(
    state: &'a AppState,
    headers: &HeaderMap,
    query: QueueQuery,
) -> AppResult<AdminDonationsTemplate<'a>> {
    let actor = require_user(state, headers).await?;
    session::guard(Some(&actor), Permission::ReviewDonation)?;
    let pool = state.db.pool();

    let tab = query
        .tab
        .as_deref()
        .and_then(|raw| DonationState::parse(raw).ok())
        .unwrap_or(DonationState::Pending);
    let page = query.page.unwrap_or(1).max(1);
    let total = repo::count_donations_by_state(pool, tab.as_str()).await?;
    let records =
        repo::list_donations_for_review(pool, tab.as_str(), PAGE_SIZE, (page - 1) * PAGE_SIZE)
            .await?
            .into_iter()
            .map(|row| {
                let st = DonationState::parse(&row.state).unwrap_or(DonationState::Pending);
                AdminDonationRow {
                    id: row.id,
                    donor_handle: row.donor_handle.clone(),
                    donor_name: display_or_handle(&row.donor_name, &row.donor_handle),
                    donor_avatar: row.donor_avatar,
                    recipient_handle: row.recipient_handle.clone(),
                    recipient_name: display_or_handle(&row.recipient_name, &row.recipient_handle),
                    recipient_avatar: row.recipient_avatar,
                    amount: format_amount(row.amount_cents),
                    txn_id: row.txn_id,
                    paid_at: format_date(row.paid_at),
                    created_at: format_date(row.created_at),
                    state: st.as_str().to_string(),
                    state_label: st.label().to_string(),
                    review_note: row.review_note.unwrap_or_default(),
                    settled: row.settled_at.is_some(),
                    post_id: row.post_id,
                    post_title: row.post_title,
                    can_review: st == DonationState::Pending,
                    can_settle: st == DonationState::Approved && row.settled_at.is_none(),
                }
            })
            .collect::<Vec<_>>();

    let mut tabs = Vec::with_capacity(DonationState::ALL.len());
    for st in DonationState::ALL {
        tabs.push(DonationTab {
            state: st.as_str().to_string(),
            label: st.label().to_string(),
            count: repo::count_donations_by_state(pool, st.as_str()).await?,
            active: st == tab,
            href: format!("/admin/donations?tab={}", st.as_str()),
        });
    }

    let total_pages = pages_of(total, PAGE_SIZE);
    let q = |p: i64| Some(format!("/admin/donations?tab={}&page={p}", tab.as_str()));
    Ok(AdminDonationsTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(actor.display_name.clone()),
        is_staff: true,
        csrf: actor.csrf_token.clone(),
        tab: tab.as_str().to_string(),
        tabs,
        records,
        total,
        page,
        previous_page: (page > 1).then(|| q(page - 1)).flatten(),
        next_page: (page < total_pages).then(|| q(page + 1)).flatten(),
    })
}

#[derive(Debug, Deserialize)]
pub struct ReviewForm {
    pub csrf: String,
    #[serde(default)]
    pub note: Option<String>,
}

pub async fn admin_approve(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<ReviewForm>,
) -> AppResult<Response> {
    decide(&state, id, &headers, &form, DonationState::Approved).await
}

pub async fn admin_reject(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    Form(form): Form<ReviewForm>,
) -> AppResult<Response> {
    decide(&state, id, &headers, &form, DonationState::Rejected).await
}

/// 人工改判 + 留痕 + 通知提交者。
async fn decide(
    state: &AppState,
    id: i64,
    headers: &HeaderMap,
    form: &ReviewForm,
    target: DonationState,
) -> AppResult<Response> {
    let actor = require_user(state, headers).await?;
    session::guard(Some(&actor), Permission::ReviewDonation)?;
    session::check_csrf(&actor, &form.csrf)?;
    let pool = state.db.pool();
    let now = now_unix();

    let typed = form
        .note
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let fallback = match target {
        DonationState::Approved => "管理员核对无误",
        DonationState::Rejected => "管理员核对未通过",
        DonationState::Pending => "管理员退回待验证",
    };
    let note = typed.unwrap_or(fallback);

    if !repo::review_donation(pool, id, target.as_str(), Some(note), actor.id, now).await? {
        // 只允许 pending 流转：已被审过 / 不存在 / 已删除都走这里
        return Err(AppError::rejected("这条记录已不在待验证状态"));
    }
    tracing::info!(
        donation.id = id,
        state = target.as_str(),
        actor.id = actor.id,
        "人工改判打赏状态"
    );
    let _ = repo::record_audit(
        pool,
        Some(actor.id),
        match target {
            DonationState::Approved => "donation.approve",
            DonationState::Rejected => "donation.reject",
            DonationState::Pending => "donation.pending",
        },
        Some(&format!("donation:{id}")),
        Some(note),
        now,
    )
    .await;

    // 通知提交者（钱款相关，必须让他知道结论）
    if let Some(donor_id) = repo::donation_donor_id(pool, id).await? {
        let title = match target {
            DonationState::Approved => "打赏记录已验证",
            DonationState::Rejected => "打赏记录未通过",
            DonationState::Pending => "打赏记录已退回",
        };
        let _ = repo::notify(
            pool,
            NewNotification {
                user_id: donor_id,
                actor_id: Some(actor.id),
                kind: "donation",
                title,
                body: Some(note),
                link: Some("/donations"),
                now,
            },
        )
        .await;
    }
    Ok(Redirect::to(&format!("/admin/donations?tab={}", target.as_str())).into_response())
}

/// 批量结算的表单。
///
/// 用 `HashMap` 而不是具名结构体：复选框的 `name` 直接带记录 id
/// （`pick_123=1`），这样**不需要 JS** 也能把「勾了哪几条」原样提交上来。
/// 具名 `Vec<i64>` 在 `serde_urlencoded` 下无法从重复键还原，这是最省事且无歧义的解法。
pub type SettleForm = std::collections::HashMap<String, String>;

/// 批量标记结算。只对**已验证且未结算**的记录生效，重复提交不重复计数。
pub async fn admin_settle(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<SettleForm>,
) -> AppResult<Response> {
    let actor = require_user(&state, &headers).await?;
    session::guard(Some(&actor), Permission::ReviewDonation)?;
    let csrf = form.get("csrf").map(String::as_str).unwrap_or_default();
    session::check_csrf(&actor, csrf)?;

    let ids: Vec<i64> = form
        .keys()
        .filter_map(|key| key.strip_prefix("pick_"))
        .filter_map(|raw| raw.trim().parse::<i64>().ok())
        .collect();
    if ids.is_empty() {
        return Err(AppError::rejected("请先勾选要结算的记录"));
    }
    let batch_ref = validate_txn_id(
        form.get("batch_ref")
            .map(String::as_str)
            .unwrap_or_default(),
    )
    .map_err(AppError::from)?;
    let now = now_unix();
    let affected = repo::mark_donations_settled(state.db.pool(), &ids, &batch_ref, now).await?;
    tracing::info!(
        settled = affected,
        requested = ids.len(),
        batch_ref = %batch_ref,
        actor.id = actor.id,
        "批量标记打赏结算"
    );
    let _ = repo::record_audit(
        state.db.pool(),
        Some(actor.id),
        "donation.settle",
        Some(&format!("batch:{batch_ref}")),
        Some(&format!("结算 {affected} 条")),
        now,
    )
    .await;
    Ok(Redirect::to("/admin/donations?tab=approved").into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 关键回归：表单填的日期必须**原样显示回去**。
    ///
    /// `format_date` 是 UTC 的，所以解析也必须是 UTC；只要有一侧用了本地时区，
    /// 东八区用户就会整体看到差一天 —— 这正是之前踩到的 bug。
    #[test]
    fn paid_at_round_trips_through_format_date() {
        for raw in ["2026-03-05", "2026-10-11", "2025-01-01"] {
            let ts = parse_paid_at(raw).unwrap_or_else(|| panic!("{raw} 应能解析"));
            assert_eq!(
                crate::templates::format_date(ts),
                raw,
                "{raw} 解析再格式化后变了"
            );
        }
    }

    #[test]
    fn paid_at_parses_datetime_forms() {
        for raw in [
            "2026-03-05 14:30",
            "2026-03-05T14:30",
            "2026-03-05 14:30:00",
        ] {
            let ts = parse_paid_at(raw).unwrap_or_else(|| panic!("{raw} 应能解析"));
            assert_eq!(
                crate::templates::format_date(ts),
                "2026-03-05",
                "{raw} 的日期部分不对"
            );
        }
    }

    #[test]
    fn paid_at_rejects_garbage() {
        assert!(parse_paid_at("").is_none());
        assert!(parse_paid_at("昨天").is_none());
        assert!(parse_paid_at("2026-13-45").is_none());
    }

    #[test]
    fn display_name_falls_back_to_handle() {
        assert_eq!(display_or_handle("", "alice"), "alice");
        assert_eq!(display_or_handle("   ", "alice"), "alice");
        assert_eq!(display_or_handle("爱丽丝", "alice"), "爱丽丝");
    }
}
