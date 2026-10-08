//! HTTP 错误映射。
//!
//! 领域错误（`sc2clud_core::Error`）在这里统一翻译成状态码与稳定的错误码字符串。
//! 日志记结构化字段；内部故障（Storage / Database / Io）一律回 500 + 泛化文案，不外泄细节。

use askama::Template;
use axum::Json;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use sc2clud_core::Error as DomainError;
use serde_json::json;

use crate::templates::ErrorTemplate;

pub type AppResult<T> = std::result::Result<T, AppError>;

#[derive(Debug)]
pub enum AppError {
    /// 领域层错误（路径越界、配额、哈希不符……）。
    Domain(DomainError),
    /// 业务层判定「不存在」。
    NotFound(String),
    /// 业务层判定的其他明确拒绝（如秒传声明与服务器记录不符）。
    Rejected(String),
    /// 服务端内部故障（详情只进日志）。
    Internal(String),
}

impl AppError {
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::NotFound(msg.into())
    }

    pub fn rejected(msg: impl Into<String>) -> Self {
        Self::Rejected(msg.into())
    }

    pub fn internal(msg: impl Into<String>) -> Self {
        Self::Internal(msg.into())
    }

    /// 状态码 / 稳定错误码 / 面向前端的文案。
    pub fn parts(&self) -> (StatusCode, &'static str, String) {
        match self {
            AppError::Domain(e) => {
                let status = match e {
                    DomainError::PathEscapesRoot { .. }
                    | DomainError::IllegalFileName { .. }
                    | DomainError::InvalidInput(_) => StatusCode::BAD_REQUEST,
                    DomainError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
                    DomainError::Forbidden(_) => StatusCode::FORBIDDEN,
                    DomainError::NotFound(_) => StatusCode::NOT_FOUND,
                    DomainError::QuotaExceeded(_) => StatusCode::PAYLOAD_TOO_LARGE,
                    DomainError::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
                    DomainError::HashMismatch { .. } => StatusCode::UNPROCESSABLE_ENTITY,
                    DomainError::Unsupported(_) => StatusCode::NOT_IMPLEMENTED,
                    DomainError::Config(_) => StatusCode::INTERNAL_SERVER_ERROR,
                    DomainError::Storage(_) | DomainError::Database(_) | DomainError::Io(_) => {
                        StatusCode::INTERNAL_SERVER_ERROR
                    }
                };
                let message = match e {
                    DomainError::Storage(_) | DomainError::Database(_) | DomainError::Io(_) => {
                        "服务端故障，请稍后重试".to_string()
                    }
                    other => other.to_string(),
                };
                (status, e.kind(), message)
            }
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, "not_found", msg.clone()),
            AppError::Rejected(msg) => (StatusCode::CONFLICT, "rejected", msg.clone()),
            AppError::Internal(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                format!("服务端故障：{msg}"),
            ),
        }
    }

    /// 页面路由用：要求 HTML 时渲染错误页，否则回 JSON。
    pub fn into_page_response(self, wants_html: bool) -> Response {
        if !wants_html {
            return self.into_response();
        }
        let (status, code, message) = self.parts();
        let template = ErrorTemplate {
            status: status.as_u16(),
            code,
            message: &message,
        };
        match template.render() {
            Ok(html) => (
                status,
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                html,
            )
                .into_response(),
            Err(render_err) => {
                tracing::error!(error = %render_err, "错误页渲染失败");
                self.into_response()
            }
        }
    }
}

impl From<DomainError> for AppError {
    fn from(value: DomainError) -> Self {
        Self::Domain(value)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, code, message) = self.parts();
        if status.is_server_error() {
            tracing::error!(error.code = code, detail = ?self, "请求失败");
        } else {
            tracing::debug!(error.code = code, detail = ?self, "请求被拒绝");
        }
        (status, Json(json!({ "error": code, "message": message }))).into_response()
    }
}
