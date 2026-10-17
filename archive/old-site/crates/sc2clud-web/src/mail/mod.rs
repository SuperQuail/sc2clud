//! 发信：provider 中立的抽象 + 多账号（多 key）池。
//!
//! # 抽象面只有一条
//!
//! Provider::send。**多 key 不进抽象** —— 它是池子的内部实现：按 priority 依次试账号，
//! 限速/抖动就换下一个号，401/403 把该号打进长冷却。加 SendGrid / SES 只是多一个
//! provider 实现 + 一个 match 分支，池子与调用点一行不改。
//!
//! # 为什么不做队列
//!
//! 发信量级是「验证码」，一天几十封。同步发（带超时）比「有界队列 + 后台 worker + 落盘
//! 重试」少一整套故障模式，调用方还立刻知道成没成。真要做群发时再引入队列，改动只在这一个文件里。

mod resend;

use std::time::Duration;

use async_trait::async_trait;
use sc2clud_core::auth::{hash_token, random_hex};
use sc2clud_core::now_unix;
use sc2clud_db::models::MailAccountRow;
use sc2clud_db::repo;
use sqlx::SqlitePool;

use crate::AppState;

/// 单次发信的 HTTP 超时。发信在请求路径上（用户点「发送验证码」），不能挂太久。
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
/// 凭据作废（401/403）后的冷却：相当于本进程内停用该号，后台能看到原因。
const DEAD_COOLDOWN_SECONDS: i64 = 24 * 3600;
/// 服务端 5xx / 网络抖动后的冷却。
const TRANSIENT_COOLDOWN_SECONDS: i64 = 30;
/// 验证码最多试几次（超过就作废，得重新发）。
const MAX_CODE_ATTEMPTS: i64 = 5;
/// 全站每分钟验证码上限：防被刷爆发信额度（单邮箱的限制挡不住换邮箱刷）。
const GLOBAL_CODES_PER_MINUTE: i64 = 60;

// ---------------------------------------------------------------- 消息与回执

/// 一封待发的信。provider 中立：不是任何 SDK 的结构体。
#[derive(Debug, Clone)]
pub struct Outgoing {
    pub to: String,
    pub subject: String,
    pub html: String,
    pub text: String,
    /// 留空则用账号自己的 reply_to。
    pub reply_to: Option<String>,
    /// 幂等键：同一次业务重试不重复投递。
    pub idempotency_key: Option<String>,
}

/// 发信回执（记日志，以及验证码归属哪个账号）。
#[derive(Debug, Clone)]
pub struct Sent {
    pub account_id: i64,
    pub provider: &'static str,
    pub message_id: String,
}

/// 提供商的判定：换号还是放弃。
///
/// 这张分类表就是「多 key」的全部价值：把 401/429/5xx 变成「换个号」，
/// 把 422 变成「别换，是我们自己的 payload 错」。
#[derive(Debug)]
pub enum Failure {
    /// 该换下一个号。dead = 凭据作废，直接长冷却。
    Switch {
        reason: String,
        cooldown_seconds: i64,
        dead: bool,
    },
    /// 换了也一样错（payload / 配置问题）：立刻失败，别浪费其余账号的额度。
    Fatal(String),
}

#[derive(Debug, thiserror::Error)]
pub enum MailError {
    /// 功能开关关着（默认）。调用方据此「静默跳过」而不是报错。
    #[error("邮件功能未开启")]
    Disabled,
    #[error("发送太频繁，请 {0} 秒后再试")]
    TooSoon(i64),
    #[error("发送过于频繁，请稍后再试")]
    TooMany,
    #[error("没有可用的发信账号")]
    NoAccount,
    /// 提供商明确拒绝，或所有账号都不通。
    #[error("{0}")]
    Failed(String),
    /// 我们自己的故障（数据库/凭据解密）；文案泛化，细节只进日志。
    #[error("发信服务暂时不可用，请稍后重试")]
    Backend(String),
}

/// 一个发信通道 = 一个账号 + 一份凭据。
#[async_trait]
pub trait Provider: Send + Sync {
    fn name(&self) -> &'static str;
    /// 发一封。成功返回提供商侧的消息 id。
    async fn send(&self, msg: &Outgoing) -> Result<String, Failure>;
}

// ---------------------------------------------------------------- 配置（site_texts）

#[derive(Debug, Clone, Copy)]
pub struct Settings {
    pub enabled: bool,
    pub per_minute: i64,
    pub cooldown_seconds: i64,
    pub code_ttl_seconds: i64,
}

pub async fn settings(pool: &SqlitePool) -> Settings {
    Settings {
        enabled: flag(pool, "mail_enabled").await,
        per_minute: number(pool, "mail_per_minute", 5).await,
        cooldown_seconds: number(pool, "mail_cooldown_seconds", 60).await,
        code_ttl_seconds: number(pool, "mail_code_ttl_seconds", 600).await,
    }
}

async fn flag(pool: &SqlitePool, key: &str) -> bool {
    matches!(repo::site_text(pool, key, "0").await.as_deref(), Ok("1"))
}

async fn number(pool: &SqlitePool, key: &str, fallback: i64) -> i64 {
    let raw = repo::site_text(pool, key, "").await.unwrap_or_default();
    match raw.trim().parse::<i64>() {
        Ok(value) => value,
        Err(_) => {
            tracing::warn!(key, raw = %raw, "发信配置项不是整数，回落到默认值");
            fallback
        }
    }
}

// ---------------------------------------------------------------- 发信池

/// 发一封信：按 priority 依次试可用账号，全都不行才失败。
///
/// 每次都从库里重读账号：发信是低频路径，比起「缓存 + 失效」，直接读表更简单，
/// 也永远不会和后台的改动不同步。
pub async fn send(state: &AppState, msg: &Outgoing) -> Result<Sent, MailError> {
    let pool = state.db.pool();
    let db_path = state.config.paths.db_path();
    let now = now_unix();
    // UTC 日起点：额度按天算，与访问者时区无关。
    let day = now.div_euclid(86_400) * 86_400;

    let accounts = repo::list_mail_accounts(pool, false)
        .await
        .map_err(|e| MailError::Backend(format!("读取发信账号：{e}")))?;
    if accounts.is_empty() {
        return Err(MailError::NoAccount);
    }

    let mut skipped: Vec<String> = Vec::new();
    let mut last_switch: Option<String> = None;

    for account in accounts {
        if account.enabled == 0 {
            skipped.push(format!("{}：已停用", account.label));
            continue;
        }
        if account.cooldown_until.is_some_and(|until| until > now) {
            skipped.push(format!("{}：冷却中", account.label));
            continue;
        }
        // 当日额度用完 → 交给下一个号。多 key 存在的意义就在这几行。
        if account.daily_quota > 0
            && account.quota_day == day
            && account.sent_today >= account.daily_quota
        {
            skipped.push(format!("{}：今日额度已用完", account.label));
            continue;
        }

        let Some(secret) = repo::mail_secret(pool, &db_path, account.id).await else {
            skipped.push(format!("{}：没配密钥", account.label));
            continue;
        };
        let provider = match build(&account, &secret) {
            Ok(provider) => provider,
            Err(e) => {
                skipped.push(format!("{}：{e}", account.label));
                continue;
            }
        };

        // 超时包在抽象层外面：这样它和具体 provider 无关（SDK 自己建的 HTTP 客户端
        // 没有超时设置，而这里一道就够）。
        let result = match tokio::time::timeout(SEND_TIMEOUT, provider.send(msg)).await {
            Ok(result) => result,
            Err(_) => Err(Failure::Switch {
                reason: format!("超过 {} 秒没响应", SEND_TIMEOUT.as_secs()),
                cooldown_seconds: TRANSIENT_COOLDOWN_SECONDS,
                dead: false,
            }),
        };
        match result {
            Ok(message_id) => {
                let _ = repo::mark_mail_sent(pool, account.id, day, now).await;
                let _ = repo::record_mail_result(pool, account.id, true, "", None, now).await;
                return Ok(Sent {
                    account_id: account.id,
                    provider: provider.name(),
                    message_id,
                });
            }
            Err(Failure::Fatal(reason)) => {
                // 换号也一样错：立刻失败，别把其余账号的额度也烧在同一个坏请求上。
                let _ = repo::record_mail_result(pool, account.id, false, &reason, None, now).await;
                tracing::error!(account.id = account.id, %reason, "发信被拒绝（不再换号）");
                return Err(MailError::Failed(reason));
            }
            Err(Failure::Switch {
                reason,
                cooldown_seconds,
                dead,
            }) => {
                let cooldown = now
                    + if dead {
                        DEAD_COOLDOWN_SECONDS
                    } else {
                        cooldown_seconds.clamp(TRANSIENT_COOLDOWN_SECONDS, DEAD_COOLDOWN_SECONDS)
                    };
                let _ =
                    repo::record_mail_result(pool, account.id, false, &reason, Some(cooldown), now)
                        .await;
                tracing::warn!(account.id = account.id, %reason, "发信账号不可用，换下一个");
                skipped.push(format!("{}：{reason}", account.label));
                last_switch = Some(reason);
            }
        }
    }

    if let Some(reason) = last_switch {
        Err(MailError::Failed(reason))
    } else {
        tracing::warn!(skipped = ?skipped, "没有可用的发信账号");
        Err(MailError::NoAccount)
    }
}

/// 按 provider 造通道。加新 provider 只需要在这里加一个分支 + 一个文件。
fn build(account: &MailAccountRow, secret_json: &str) -> Result<Box<dyn Provider>, String> {
    match account.provider.as_str() {
        "resend" => {
            let api_key = secret_value("resend", secret_json)?;
            Ok(Box::new(resend::Resend::new(account, &api_key)?))
        }
        other => Err(format!("不认识的 provider「{other}」")),
    }
}

/// 凭据 JSON 里那个「主密钥」字段名：后台表单只有一个密钥输入框，
/// 由 provider 自己决定它叫什么。加 provider 时改这一处。
pub fn secret_field(provider: &str) -> Result<&'static str, String> {
    match provider {
        "resend" => Ok("api_key"),
        other => Err(format!("不认识的 provider「{other}」")),
    }
}

/// 把后台表单里的密钥明文包成该 provider 的凭据 JSON（加密后才落库）。
pub fn secret_payload(provider: &str, secret: &str) -> Result<String, String> {
    Ok(serde_json::json!({ secret_field(provider)?: secret }).to_string())
}

/// 从凭据 JSON 里取出「主密钥」。与 [`secret_payload`] 对称 —— 加 provider 时要改的另一处。
///
/// 少了这一步，发给服务商的就不是 key，而是整个 JSON 串（线上表现为
/// `validation_error: API key is invalid`）。
pub fn secret_value(provider: &str, secret_json: &str) -> Result<String, String> {
    let field = secret_field(provider)?;
    let parsed: serde_json::Value =
        serde_json::from_str(secret_json).map_err(|e| format!("凭据不是合法 JSON：{e}"))?;
    parsed
        .get(field)
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("凭据里没有 {field}"))
}

/// 后台下拉里能选的 provider（只列真的实现了的，不列「以后可能加」的）。
pub fn providers() -> Vec<serde_json::Value> {
    vec![serde_json::json!({
        "value": "resend",
        "label": "Resend",
        "secretLabel": "API Key",
        "secretHint": "re_ 开头。每个账号一个 key，额度互相独立",
    })]
}

/// 给 admin 页的「测试发信」用：按 id 造出那一个账号的通道（不走池子选号）。
pub async fn provider_for(state: &AppState, id: i64) -> Result<Box<dyn Provider>, MailError> {
    let pool = state.db.pool();
    let account = repo::list_mail_accounts(pool, true)
        .await
        .map_err(|e| MailError::Backend(format!("读取发信账号：{e}")))?
        .into_iter()
        .find(|account| account.id == id)
        .ok_or(MailError::NoAccount)?;
    let secret = repo::mail_secret(pool, &state.config.paths.db_path(), id)
        .await
        .ok_or_else(|| MailError::Failed("这个账号还没配密钥".to_string()))?;
    build(&account, &secret).map_err(MailError::Failed)
}

/// 用指定的某一个账号发一封（admin 的「测试发信」）。
///
/// 健康度/冷却的记法与池子一致，所以测试失败也会让这个号进冷却、在后台看得见。
pub async fn send_with_account(
    state: &AppState,
    id: i64,
    msg: &Outgoing,
) -> Result<Sent, MailError> {
    let provider = provider_for(state, id).await?;
    let pool = state.db.pool();
    let now = now_unix();
    let day = now.div_euclid(86_400) * 86_400;
    let result = match tokio::time::timeout(SEND_TIMEOUT, provider.send(msg)).await {
        Ok(result) => result,
        Err(_) => Err(Failure::Switch {
            reason: format!("超过 {} 秒没响应", SEND_TIMEOUT.as_secs()),
            cooldown_seconds: TRANSIENT_COOLDOWN_SECONDS,
            dead: false,
        }),
    };
    match result {
        Ok(message_id) => {
            let _ = repo::mark_mail_sent(pool, id, day, now).await;
            let _ = repo::record_mail_result(pool, id, true, "", None, now).await;
            Ok(Sent {
                account_id: id,
                provider: provider.name(),
                message_id,
            })
        }
        Err(Failure::Fatal(reason)) => {
            let _ = repo::record_mail_result(pool, id, false, &reason, None, now).await;
            Err(MailError::Failed(reason))
        }
        Err(Failure::Switch {
            reason,
            cooldown_seconds,
            dead,
        }) => {
            let cooldown = now
                + if dead {
                    DEAD_COOLDOWN_SECONDS
                } else {
                    cooldown_seconds.clamp(TRANSIENT_COOLDOWN_SECONDS, DEAD_COOLDOWN_SECONDS)
                };
            let _ = repo::record_mail_result(pool, id, false, &reason, Some(cooldown), now).await;
            Err(MailError::Failed(reason))
        }
    }
}

// ---------------------------------------------------------------- 验证码

/// 发一封验证码并落库。
///
/// 顺序是「先发信、成功后才写码」：发送失败时不留一条用户永远收不到的验证码，
/// 也不会因此触发下一次的冷却。
pub async fn send_verification_code(
    state: &AppState,
    email: &str,
    purpose: &str,
    request_ip: &str,
    subject: &str,
) -> Result<(), MailError> {
    let pool = state.db.pool();
    let config = settings(pool).await;
    if !config.enabled {
        return Err(MailError::Disabled);
    }

    let now = now_unix();
    // 同一邮箱的最小间隔。
    let (_, last_at) = repo::email_codes_since(pool, email, now - config.cooldown_seconds)
        .await
        .map_err(|e| MailError::Backend(format!("查询发码记录：{e}")))?;
    if let Some(last_at) = last_at {
        let wait = config.cooldown_seconds - (now - last_at);
        if wait > 0 {
            return Err(MailError::TooSoon(wait));
        }
    }
    // 单邮箱每分钟上限，以及全站每分钟上限（后者防换邮箱刷）。
    let (recent, _) = repo::email_codes_since(pool, email, now - 60)
        .await
        .map_err(|e| MailError::Backend(format!("查询发码记录：{e}")))?;
    if recent >= config.per_minute {
        return Err(MailError::TooMany);
    }
    let total = repo::email_codes_total_since(pool, now - 60)
        .await
        .map_err(|e| MailError::Backend(format!("查询发码总数：{e}")))?;
    if total >= GLOBAL_CODES_PER_MINUTE {
        tracing::warn!(total, "全站发码速率触顶，已拒绝");
        return Err(MailError::TooMany);
    }

    // 6 位数字码；库里只存「盐 + 哈希」，明文只在这封邮件里出现一次。
    let code = format!("{:06}", code_value());
    let salt = random_hex(8);
    let code_hash = hash_token(&format!("{salt}:{code}"));

    let message = Outgoing {
        to: email.to_string(),
        subject: subject.to_string(),
        html: code_html(&code, config.code_ttl_seconds),
        text: format!(
            "你的验证码是 {code}，{} 分钟内有效。",
            config.code_ttl_seconds / 60
        ),
        reply_to: None,
        idempotency_key: Some(format!("code-{purpose}-{email}-{now}")),
    };
    let sent = send(state, &message).await?;

    repo::create_email_code(
        pool,
        email,
        &code_hash,
        &salt,
        purpose,
        now + config.code_ttl_seconds,
        Some(sent.account_id),
        request_ip,
        now,
    )
    .await
    .map_err(|e| MailError::Backend(format!("写入验证码：{e}")))?;

    tracing::info!(
        account.id = sent.account_id,
        provider = sent.provider,
        message.id = %sent.message_id,
        purpose,
        "验证码已发出"
    );
    Ok(())
}

/// 校验验证码。对了就消费掉，错了就累加尝试次数。
pub async fn verify_code(
    state: &AppState,
    email: &str,
    purpose: &str,
    code: &str,
) -> Result<bool, MailError> {
    let pool = state.db.pool();
    let now = now_unix();
    let Some((id, expected, salt, attempts)) = repo::newest_email_code(pool, email, purpose, now)
        .await
        .map_err(|e| MailError::Backend(format!("读取验证码：{e}")))?
    else {
        return Ok(false);
    };
    if attempts >= MAX_CODE_ATTEMPTS {
        // 试太多次：作废，逼用户重新发一封。
        let _ = repo::consume_email_code(pool, id, now).await;
        return Ok(false);
    }
    let ok = hash_token(&format!("{salt}:{}", code.trim())) == expected;
    if ok {
        repo::consume_email_code(pool, id, now)
            .await
            .map_err(|e| MailError::Backend(format!("消费验证码：{e}")))?;
    } else {
        let _ = repo::bump_email_code_attempts(pool, id).await;
    }
    Ok(ok)
}

/// 6 位数字（对 10^6 取模的偏差可忽略：2^32 / 10^6 ≈ 4295）。
fn code_value() -> u32 {
    let hex = random_hex(4);
    u32::from_str_radix(&hex, 16).unwrap_or(0) % 1_000_000
}

fn code_html(code: &str, ttl_seconds: i64) -> String {
    format!(
        "<p>你的验证码是</p>\
         <p style='font-size:28px;font-weight:700;letter-spacing:4px'>{code}</p>\
         <p>{} 分钟内有效。若不是你本人操作，忽略这封邮件即可。</p>",
        ttl_seconds / 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_is_six_digits() {
        for _ in 0..200 {
            let code = format!("{:06}", code_value());
            assert_eq!(code.len(), 6);
            assert!(code.chars().all(|c| c.is_ascii_digit()), "{code}");
        }
    }

    #[test]
    fn secret_payload_round_trips_through_secret_value() {
        // 存进去的是 JSON，发出去必须是裸 key —— 这条断言就是「少了取出来那一步」的守门人。
        let payload = secret_payload("resend", "re_test_123").expect("打包凭据");
        assert_eq!(payload, "{\"api_key\":\"re_test_123\"}");
        assert_eq!(
            secret_value("resend", &payload).as_deref(),
            Ok("re_test_123"),
            "取出来的必须是裸 key，不是整个 JSON"
        );
        // 带空白的粘贴要能容忍
        let padded = secret_payload("resend", "re_x").expect("打包");
        assert_eq!(secret_value("resend", &padded).as_deref(), Ok("re_x"));
        // 形状不对要明确报错，而不是把 JSON 当 key 发出去
        assert!(secret_value("resend", "not json").is_err());
        assert!(secret_value("resend", "{\"other\":\"x\"}").is_err());
        assert!(
            secret_value("smtp", "{}").is_err(),
            "没实现的 provider 要拒绝"
        );
    }

    #[test]
    fn code_hash_is_salted_and_stable() {
        let salt = random_hex(8);
        assert_ne!(hash_token(&format!("{salt}:123456")), hash_token("123456"));
        assert_eq!(
            hash_token(&format!("{salt}:123456")),
            hash_token(&format!("{salt}:123456"))
        );
    }
}
