//! 私信内容校验。

use crate::error::{Error, Result};

/// 单条私信的上限（字符数）。
pub const MAX_MESSAGE_CHARS: usize = 2000;

/// 校验私信正文：非空、≤ 2000 字符、允许换行但不允许其他控制字符。
pub fn validate_message_body(raw: &str) -> Result<String> {
    let body = raw.trim();
    if body.is_empty() {
        return Err(Error::InvalidInput("私信内容不能为空".to_string()));
    }
    if body.chars().count() > MAX_MESSAGE_CHARS {
        return Err(Error::InvalidInput(format!(
            "私信最多 {MAX_MESSAGE_CHARS} 个字符"
        )));
    }
    if body.chars().any(|c| c.is_control() && c != '\n') {
        return Err(Error::InvalidInput("私信不能包含控制字符".to_string()));
    }
    Ok(body.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_text() {
        assert_eq!(validate_message_body("  你好  ").expect("ok"), "你好");
        assert!(validate_message_body("第一行\n第二行").is_ok(), "换行允许");
    }

    #[test]
    fn rejects_empty_and_huge() {
        assert!(validate_message_body("   ").is_err());
        assert!(validate_message_body("").is_err());
        assert!(validate_message_body(&"字".repeat(MAX_MESSAGE_CHARS + 1)).is_err());
        assert!(validate_message_body(&"字".repeat(MAX_MESSAGE_CHARS)).is_ok());
    }

    #[test]
    fn rejects_control_chars() {
        assert!(validate_message_body("a\tb").is_err(), "制表符也算控制字符");
    }
}
