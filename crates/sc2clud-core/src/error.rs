//! 统一错误类型（领域层）。
//!
//! 约定：领域错误直接面向用户与日志，信息用中文；`anyhow` 只在应用边界
//! （`sc2clud-app`）聚合上下文，库层不吞错、不做字符串化的错误传递。

use std::path::PathBuf;

/// 领域层统一 `Result`。
pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// 路径校验失败：目标不在允许的根目录内（``..``、符号链接越界、TOCTOU 的第一道闸门）。
    #[error("路径越界：{target} 不在允许的根目录 {root} 内")]
    PathEscapesRoot { root: PathBuf, target: PathBuf },

    /// 用户提供的文件名不合法。
    #[error("非法文件名 {name:?}：{reason}")]
    IllegalFileName { name: String, reason: &'static str },

    /// 配置缺失或自相矛盾。
    #[error("配置错误：{0}")]
    Config(String),

    /// 请求参数不合法。
    #[error("参数无效：{0}")]
    InvalidInput(String),

    /// 未登录。
    #[error("未登录：{0}")]
    Unauthorized(String),

    /// 已登录但权限不足。
    #[error("权限不足：{0}")]
    Forbidden(String),

    /// 目标不存在。
    #[error("未找到：{0}")]
    NotFound(String),

    /// 超出配额（单文件上限、用户总量、站点总量）。
    #[error("超出配额：{0}")]
    QuotaExceeded(String),

    /// 触发限速（令牌桶 / 并发闸门）。
    #[error("请求过于频繁：{0}")]
    RateLimited(String),

    /// 内容哈希与声明不符（秒传声明、分片校验）。
    #[error("内容校验失败：期望 {expected}，实际 {actual}")]
    HashMismatch { expected: String, actual: String },

    /// 当前存储后端不支持该操作。
    #[error("存储后端不支持该操作：{0}")]
    Unsupported(&'static str),

    /// 存储层自身的失败。
    #[error("存储错误：{0}")]
    Storage(String),

    /// 元数据库失败（db 层把 sqlx::Error 归一到这里，避免 core 依赖 sqlx）。
    #[error("数据库错误：{0}")]
    Database(String),

    /// 底层 I/O 失败。
    #[error("I/O 错误：{0}")]
    Io(#[from] std::io::Error),
}

impl Error {
    /// 稳定的错误分类，用于映射 HTTP 状态码与日志字段（不要改已有取值）。
    pub fn kind(&self) -> &'static str {
        match self {
            Error::PathEscapesRoot { .. } => "path_escapes_root",
            Error::IllegalFileName { .. } => "illegal_file_name",
            Error::Config(_) => "config",
            Error::InvalidInput(_) => "invalid_input",
            Error::Unauthorized(_) => "unauthorized",
            Error::Forbidden(_) => "forbidden",
            Error::NotFound(_) => "not_found",
            Error::QuotaExceeded(_) => "quota_exceeded",
            Error::RateLimited(_) => "rate_limited",
            Error::HashMismatch { .. } => "hash_mismatch",
            Error::Unsupported(_) => "unsupported",
            Error::Storage(_) => "storage",
            Error::Database(_) => "database",
            Error::Io(_) => "io",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_is_stable() {
        let e = Error::NotFound("x".into());
        assert_eq!(e.kind(), "not_found");
        assert!(e.to_string().contains('x'));
    }

    #[test]
    fn io_error_converts() {
        let e: Error = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "nope").into();
        assert_eq!(e.kind(), "io");
    }
}
