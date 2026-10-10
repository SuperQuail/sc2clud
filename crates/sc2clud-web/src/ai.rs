//! AI 审核：OpenAI 兼容的 Chat Completions + 工具调用（通过 / 待定 / 不通过）。
//!
//! 发出去的请求体就是 OpenAPI 里规定的形状：`tools` 用 `function` 类型、`tool_choice` 强制选一个；
//! 我们只认这三个工具名，别的名字一律当成模型不听话（记留痕、返回错误）。

use std::time::Duration;

use sc2clud_core::review::{AiVerdict, ai_tools};

/// 审核用的配置（超管在后台改，密钥单独加密存表）。
#[derive(Debug, Clone)]
pub struct AiConfig {
    pub enabled: bool,
    pub endpoint: String,
    pub api_key: String,
    pub model: String,
    pub prompt_new_post: String,
    pub prompt_report: String,
    pub review_comments: bool,
    pub review_on_report: bool,
}

impl AiConfig {
    /// 从库里读一份配置（密钥解密不出来就当成没配）。
    pub async fn load(pool: &sqlx::SqlitePool, db_path: &std::path::Path) -> Self {
        let get = |key: &'static str, default: &'static str| async move {
            sc2clud_db::repo::ai_setting(pool, key, default)
                .await
                .unwrap_or_else(|_| default.to_string())
        };
        let enabled = get("ai_enabled", "0").await == "1";
        let endpoint = get("ai_endpoint", "https://api.openai.com/v1").await;
        let model = get("ai_model", "gpt-4o-mini").await;
        let prompt_new_post = get("ai_prompt_new_post", "判断这条社区内容是否合规。").await;
        let prompt_report = get("ai_prompt_report", "这条内容被举报，请重新判定。").await;
        let review_comments = get("ai_review_comments", "0").await == "1";
        let review_on_report = get("ai_review_on_report", "1").await == "1";
        let api_key = sc2clud_db::repo::ai_key(pool, db_path)
            .await
            .unwrap_or_default();
        Self {
            enabled,
            endpoint: endpoint.trim_end_matches('/').to_string(),
            api_key,
            model,
            prompt_new_post,
            prompt_report,
            review_comments,
            review_on_report,
        }
    }

    fn ready(&self) -> Result<(), String> {
        if self.endpoint.is_empty() {
            return Err("还没配置 AI 接口地址".to_string());
        }
        if self.api_key.is_empty() {
            return Err("还没配置 AI 的 API 密钥".to_string());
        }
        Ok(())
    }
}

/// 一次审核的结果。
#[derive(Debug, Clone)]
pub struct AiReview {
    pub verdict: AiVerdict,
    pub reason: String,
    /// 原始响应（留痕用，截断保存）。
    pub raw: String,
}

/// 拼请求体：工具定义来自 core（三个工具），tool_choice 强制模型调用其中之一。
fn request_body(config: &AiConfig, system: &str, user: &str, target: &str) -> serde_json::Value {
    serde_json::json!({
        "model": config.model,
        "messages": [
            { "role": "system", "content": system },
            { "role": "user", "content": user }
        ],
        "tools": ai_tools(target),
        "tool_choice": "required",
        "temperature": 0
    })
}

/// 把响应里第一个工具调用解析成判词。
fn parse_reply(value: &serde_json::Value) -> Result<AiReview, String> {
    let message = value
        .get("choices")
        .and_then(|choices| choices.get(0))
        .and_then(|choice| choice.get("message"))
        .ok_or_else(|| "AI 响应里没有 choices".to_string())?;
    let call = message
        .get("tool_calls")
        .and_then(|calls| calls.get(0))
        .ok_or_else(|| "AI 没有调用任何工具（可能是模型不支持工具调用）".to_string())?;
    let name = call
        .get("function")
        .and_then(|function| function.get("name"))
        .and_then(|name| name.as_str())
        .ok_or_else(|| "工具调用里没有函数名".to_string())?;
    let verdict =
        AiVerdict::from_tool_name(name).ok_or_else(|| format!("AI 调用了未知工具：{name}"))?;
    let reason = call
        .get("function")
        .and_then(|function| function.get("arguments"))
        .and_then(|arguments| arguments.as_str())
        .and_then(|arguments| serde_json::from_str::<serde_json::Value>(arguments).ok())
        .and_then(|parsed| {
            parsed
                .get("reason")
                .and_then(|reason| reason.as_str())
                .map(|reason| reason.to_string())
        })
        .unwrap_or_default();
    Ok(AiReview {
        verdict,
        reason,
        raw: value.to_string(),
    })
}

async fn post_chat(
    config: &AiConfig,
    body: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    config.ready()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败：{e}"))?;
    let response = client
        .post(format!("{}/chat/completions", config.endpoint))
        .bearer_auth(&config.api_key)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("调用 AI 失败：{e}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "AI 返回 {status}：{}",
            text.chars().take(300).collect::<String>()
        ));
    }
    serde_json::from_str(&text).map_err(|e| format!("AI 响应不是合法 JSON：{e}"))
}

/// 审核一段文本（帖子或评论）。`source` 决定用哪套提示词。
pub async fn review_text(
    config: &AiConfig,
    text: &str,
    target: &str,
    source: &str,
) -> Result<AiReview, String> {
    let system = if source == "report" {
        config.prompt_report.clone()
    } else {
        config.prompt_new_post.clone()
    };
    let body = request_body(config, &system, text, target);
    let value = post_chat(config, &body).await?;
    parse_reply(&value)
}

/// 连通性测试：发一句最短的话，看能不能拿到正常响应（不要求它调用工具）。
pub async fn test_connection(config: &AiConfig) -> Result<String, String> {
    let body = serde_json::json!({
        "model": config.model,
        "messages": [{ "role": "user", "content": "ping" }],
        "max_tokens": 8
    });
    let value = post_chat(config, &body).await?;
    let model = value
        .get("model")
        .and_then(|model| model.as_str())
        .unwrap_or(&config.model)
        .to_string();
    Ok(format!("连通正常，模型：{model}"))
}

#[cfg(test)]
mod ai_client_tests {
    use super::*;

    fn config() -> AiConfig {
        AiConfig {
            enabled: true,
            endpoint: "https://example.invalid/v1".to_string(),
            api_key: "sk-test".to_string(),
            model: "gpt-4o-mini".to_string(),
            prompt_new_post: "审核帖子".to_string(),
            prompt_report: "审核举报".to_string(),
            review_comments: false,
            review_on_report: true,
        }
    }

    #[test]
    fn body_carries_three_tools_and_forces_a_choice() {
        let body = request_body(&config(), "s", "u", "post");
        assert_eq!(body["tool_choice"], "required");
        assert_eq!(body["tools"].as_array().map(|tools| tools.len()), Some(3));
        assert_eq!(body["messages"][1]["content"], "u");
    }

    #[test]
    fn reply_parsing_maps_tools_and_rejects_nonsense() {
        let ok = serde_json::json!({ "choices": [ { "message": { "tool_calls": [ { "function": {
            "name": "pending_post", "arguments": "{\"reason\":\"拿不准\"}" } } ] } } ] });
        let review = parse_reply(&ok).expect("能解析");
        assert_eq!(review.verdict, AiVerdict::Pending);
        assert_eq!(review.reason, "拿不准");

        let no_call =
            serde_json::json!({ "choices": [ { "message": { "content": "我觉得还行" } } ] });
        assert!(parse_reply(&no_call).is_err());

        let weird = serde_json::json!({ "choices": [ { "message": { "tool_calls": [ { "function": {
            "name": "delete_post", "arguments": "{}" } } ] } } ] });
        assert!(parse_reply(&weird).is_err());
    }

    #[test]
    fn missing_key_is_reported_before_any_request() {
        let mut broken = config();
        broken.api_key = String::new();
        assert!(broken.ready().is_err());
    }
}
