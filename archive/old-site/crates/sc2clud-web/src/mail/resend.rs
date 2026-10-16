//! Resend 提供者（官方 SDK resend-rs）。
//!
//! 一个账号 = 一个 key = 一个 resend_rs::Resend 实例（自带限速器与 base_url）。
//! 池子只管「换不换号」，这个文件只管两件事：
//!
//! 1. 把我们的 Outgoing 翻成 Resend 的请求；
//! 2. 把 SDK 的错误分成「该换号」和「换了也白换」两类 —— 这张表就是多 key 的价值所在。

use async_trait::async_trait;
use resend_rs::types::CreateEmailBaseOptions;
use resend_rs::{Config, Error as ResendError, Resend as Client};
use sc2clud_db::models::MailAccountRow;
use serde::Deserialize;

use super::{Failure, Outgoing, Provider};

/// 429 拿不到 ratelimit-reset 时的默认冷却。
const DEFAULT_COOLDOWN_SECONDS: i64 = 60;

/// options_json 的内容：Resend 专属的**非敏感**参数（密钥不在这里）。
#[derive(Debug, Default, Deserialize)]
struct Options {
    /// 自建反代 / 测试桩。留空即官方 https://api.resend.com。
    #[serde(default)]
    base_url: Option<String>,
}

/// 一个 Resend 账号。
pub struct Resend {
    client: Client,
    /// 已经拼好的 RFC 5322 发件人：显示名 + 地址。
    from: String,
    reply_to: Option<String>,
}

impl Resend {
    pub fn new(account: &MailAccountRow, api_key: &str) -> Result<Self, String> {
        let options: Options = serde_json::from_str(&account.options_json)
            .map_err(|e| format!("options_json 不是合法 JSON：{e}"))?;

        let from_address = account.from_address.trim();
        if from_address.is_empty() {
            return Err("没填发件地址".to_string());
        }
        let from = if account.from_name.trim().is_empty() {
            from_address.to_string()
        } else {
            format!("{} <{from_address}>", account.from_name.trim())
        };

        // 刻意不注入自建 HTTP 客户端：SDK 0.34 依赖 reqwest 0.13，而本 crate 是 0.12，
        // 跨版本的 Client 类型传不进去。超时由 crate::mail 那一层统一包（与 provider 无关）。
        let mut builder = Config::builder(api_key);
        if let Some(base_url) = options
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|u| !u.is_empty())
        {
            // 显式传进来，SDK 就不会去读进程环境变量 RESEND_BASE_URL。
            let url = base_url
                .parse()
                .map_err(|e| format!("base_url 不是合法 URL：{e}"))?;
            builder = builder.base_url(url);
        }

        let reply_to = account.reply_to.trim();
        Ok(Self {
            client: Client::with_config(builder.build()),
            from,
            reply_to: (!reply_to.is_empty()).then(|| reply_to.to_string()),
        })
    }
}

#[async_trait]
impl Provider for Resend {
    fn name(&self) -> &'static str {
        "resend"
    }

    async fn send(&self, msg: &Outgoing) -> Result<String, Failure> {
        let mut email = CreateEmailBaseOptions::new(
            self.from.clone(),
            vec![msg.to.clone()],
            msg.subject.clone(),
        )
        .with_html(&msg.html)
        .with_text(&msg.text);
        if let Some(reply_to) = msg.reply_to.as_deref().or(self.reply_to.as_deref()) {
            email = email.with_reply(reply_to);
        }

        let response = match msg.idempotency_key.as_deref() {
            Some(key) => {
                self.client
                    .emails
                    .send(email.with_idempotency_key(key))
                    .await
            }
            None => self.client.emails.send(email).await,
        };
        response
            .map(|response| response.id.to_string())
            .map_err(classify)
    }
}

/// SDK 错误 → 「换号」还是「放弃」。
fn classify(error: ResendError) -> Failure {
    match error {
        ResendError::RateLimit {
            ratelimit_remaining,
            ratelimit_reset,
            ..
        } => {
            // 429。SDK 在解析响应体之前就短路了，所以 daily_quota_exceeded 这类名字拿不到，
            // 只能靠 remaining == 0 判断「额度用尽」——两者的冷却时长差得很远。
            let exhausted = ratelimit_remaining == Some(0);
            let cooldown = ratelimit_reset
                .map(|seconds| seconds as i64)
                .unwrap_or(DEFAULT_COOLDOWN_SECONDS);
            Failure::Switch {
                reason: if exhausted {
                    format!("额度已用尽（冷却 {cooldown} 秒）")
                } else {
                    format!("被限速（冷却 {cooldown} 秒）")
                },
                cooldown_seconds: cooldown,
                dead: false,
            }
        }
        ResendError::Resend(response) => {
            let reason = format!("{}：{}", response.name, response.message);
            match response.status_code {
                // key 本身废了（缺失/受限/停用/权限不足）：换号，并长冷却。
                401 | 403 => Failure::Switch {
                    reason,
                    cooldown_seconds: 0,
                    dead: true,
                },
                // 对方抖动：换号重试。
                code if code >= 500 => Failure::Switch {
                    reason,
                    cooldown_seconds: DEFAULT_COOLDOWN_SECONDS,
                    dead: false,
                },
                // 其余 4xx（422 参数错、400 幂等键非法……）：我们自己的 payload 问题，
                // 换号也一样错 —— 别把其余账号的额度也烧掉。
                _ => Failure::Fatal(reason),
            }
        }
        // 连不上 / 超时：换号。
        //
        // reqwest 的 Display 只有一句「error sending request for url (...)」，真正的原因
        // （TLS 没开、DNS、证书、超时）全在 source 链里 —— 不把它挖出来，排障只能靠猜。
        ResendError::Http(e) => {
            let mut reason = format!("网络错误：{e}");
            let mut cause = std::error::Error::source(&e);
            while let Some(inner) = cause {
                reason.push_str(&format!("（{inner}）"));
                cause = inner.source();
            }
            Failure::Switch {
                reason,
                cooldown_seconds: DEFAULT_COOLDOWN_SECONDS,
                dead: false,
            }
        }
        other => Failure::Fatal(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use resend_rs::types::ErrorResponse;

    fn api_error(status_code: u16, name: &str) -> ResendError {
        ResendError::Resend(ErrorResponse {
            status_code,
            message: "细节".to_string(),
            name: name.to_string(),
        })
    }

    #[test]
    fn dead_key_switches_with_long_cooldown() {
        match classify(api_error(401, "missing_api_key")) {
            Failure::Switch { dead, .. } => assert!(dead),
            other => panic!("401 应该换号并标记作废，实际 {other:?}"),
        }
        match classify(api_error(403, "suspended_api_key")) {
            Failure::Switch { dead, .. } => assert!(dead),
            other => panic!("403 应该换号并标记作废，实际 {other:?}"),
        }
    }

    #[test]
    fn server_error_switches_but_keeps_the_key() {
        match classify(api_error(500, "application_error")) {
            Failure::Switch { dead, .. } => assert!(!dead),
            other => panic!("5xx 应该换号但保留 key，实际 {other:?}"),
        }
    }

    #[test]
    fn payload_error_does_not_switch() {
        // 换号也一样错：这三个都必须直接失败，否则会把每个账号的额度都烧一遍。
        for (status, name) in [
            (422, "validation_error"),
            (422, "missing_required_field"),
            (400, "invalid_idempotency_key"),
        ] {
            assert!(
                matches!(classify(api_error(status, name)), Failure::Fatal(_)),
                "{status} {name} 不该换号"
            );
        }
    }

    #[test]
    fn quota_exhausted_is_recognised_by_remaining_zero() {
        match classify(ResendError::RateLimit {
            ratelimit_limit: Some(2),
            ratelimit_remaining: Some(0),
            ratelimit_reset: Some(3600),
        }) {
            Failure::Switch {
                reason,
                cooldown_seconds,
                dead,
            } => {
                assert!(!dead);
                assert_eq!(cooldown_seconds, 3600);
                assert!(reason.contains("额度已用尽"), "{reason}");
            }
            other => panic!("429 应该换号，实际 {other:?}"),
        }
    }
}
