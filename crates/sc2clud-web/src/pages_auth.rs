//! 注册 / 登录 / 登出。
//!
//! 未登录的 POST（注册、登录）没有会话 CSRF 令牌，改用 `Origin` 校验：
//! 浏览器表单一定带 Origin/Referer，跨站伪造请求会被挡在门外，不需要额外下发匿名令牌。

use axum::Form;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::{IntoResponse, Redirect, Response};
use serde::Deserialize;

use sc2clud_core::auth::{
    hash_password, validate_display_name, validate_email, validate_handle, validate_password,
    verify_password,
};
use sc2clud_core::{Error as DomainError, now_unix};
use sc2clud_db::repo;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::session;
use crate::templates::{LoginTemplate, RegisterTemplate};

#[derive(Debug, Deserialize)]
pub struct RegisterForm {
    pub handle: String,
    pub display_name: String,
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginForm {
    pub account: String,
    pub password: String,
}

/// 从 URL 里抠出 host（含端口，去掉默认端口）。
fn host_of(url: &str) -> Option<String> {
    let rest = url.split("://").nth(1).unwrap_or(url);
    let host = rest.split('/').next()?.trim().to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    Some(
        host.strip_suffix(":80")
            .or_else(|| host.strip_suffix(":443"))
            .unwrap_or(&host)
            .to_string(),
    )
}

/// 判断某个 Origin 是否算「本站」。
///
/// **优先比请求自己的 Host 头**：站点会被域名、www、IP 等多种方式访问，
/// 把 base_url 写死会导致换域名后登录直接被 403（踩过一次）。
/// base_url 只作为兜底（例如反向代理没透传 Host 时）。
fn origin_is_same_site(origin: &str, host_header: Option<&str>, base_url: &str) -> bool {
    let Some(origin_host) = host_of(origin) else {
        return false;
    };
    if let Some(host) = host_header.and_then(host_of) {
        if host == origin_host {
            return true;
        }
    }
    host_of(base_url).as_deref() == Some(origin_host.as_str())
}

/// 校验请求来源：表单页与提交必须同源（挡 CSRF）。
fn check_origin(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    let origin = headers
        .get(header::ORIGIN)
        .or_else(|| headers.get(header::REFERER))
        .and_then(|value| value.to_str().ok());
    let host = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());
    match origin {
        Some(origin) if origin_is_same_site(origin, host, &state.config.server.base_url) => Ok(()),
        _ => Err(AppError::Domain(DomainError::Forbidden(
            "请求来源校验失败，请从站点页面重试".to_string(),
        ))),
    }
}

#[cfg(test)]
mod origin_tests {
    use super::*;

    #[test]
    fn same_host_passes() {
        // 域名访问：Host 头就是域名，Origin 也是域名 → 同源
        assert!(origin_is_same_site(
            "http://www.xn--xpra07ba.fun",
            Some("www.xn--xpra07ba.fun"),
            "http://191.40.41.97"
        ));
        // 默认端口应当被抹平
        assert!(origin_is_same_site(
            "http://example.com:80",
            Some("example.com"),
            "http://191.40.41.97"
        ));
    }

    #[test]
    fn base_url_still_works_as_fallback() {
        assert!(origin_is_same_site(
            "http://191.40.41.97",
            None,
            "http://191.40.41.97"
        ));
    }

    #[test]
    fn foreign_origin_is_rejected() {
        assert!(!origin_is_same_site(
            "http://evil.example",
            Some("www.xn--xpra07ba.fun"),
            "http://191.40.41.97"
        ));
    }
}

fn with_cookie(mut response: Response, cookie: String) -> Response {
    if let Ok(value) = HeaderValue::from_str(&cookie) {
        response.headers_mut().append(header::SET_COOKIE, value);
    }
    response
}

// ---------------------------------------------------------------- 注册

pub async fn register_form(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let needs_activation = repo::registration_requires_activation(state.db.pool())
        .await
        .unwrap_or(true);
    let user = session::current_user(&state, &headers).await.ok().flatten();
    crate::templates::render(RegisterTemplate {
        site_name: &state.config.server.site_name,
        is_staff: false,
        csrf: user
            .as_ref()
            .map(|u| u.csrf_token.clone())
            .unwrap_or_default(),
        user_label: user.as_ref().map(|u| u.display_name.clone()),
        needs_activation,
        error: None,
        handle: "",
        display_name: "",
        email: "",
    })
}

pub async fn register_submit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<RegisterForm>,
) -> Response {
    let page = |state: &AppState, error: &str| {
        crate::templates::render(RegisterTemplate {
            site_name: &state.config.server.site_name,
            is_staff: false,
            csrf: String::new(),
            user_label: None,
            needs_activation: true,
            error: Some(error.to_string()),
            handle: "",
            display_name: "",
            email: "",
        })
    };

    if let Err(e) = check_origin(&state, &headers) {
        return page(&state, &e.parts().2);
    }
    let handle = match validate_handle(&form.handle) {
        Ok(handle) => handle,
        Err(e) => return page(&state, &e.to_string()),
    };
    let display_name = match validate_display_name(&form.display_name) {
        Ok(name) => name,
        Err(e) => return page(&state, &e.to_string()),
    };
    let email = match validate_email(&form.email) {
        Ok(email) => email,
        Err(e) => return page(&state, &e.to_string()),
    };
    if let Err(e) = validate_password(&form.password) {
        return page(&state, &e.to_string());
    }

    let pool = state.db.pool();
    match repo::find_user_by_handle(pool, &handle).await {
        Ok(Some(_)) => return page(&state, "该用户名已被占用"),
        Err(e) => return AppError::from(e).into_response(),
        Ok(None) => {}
    }
    match repo::find_user_by_email(pool, &email).await {
        Ok(Some(_)) => return page(&state, "该邮箱已注册"),
        Err(e) => return AppError::from(e).into_response(),
        Ok(None) => {}
    }

    let needs_activation = repo::registration_requires_activation(pool)
        .await
        .unwrap_or(true);
    let hash = match hash_password(&form.password) {
        Ok(hash) => hash,
        Err(e) => return AppError::from(e).into_response(),
    };
    let now = now_unix();
    let user_id = match repo::register_user(
        pool,
        repo::NewUser {
            handle: &handle,
            display_name: &display_name,
            email: &email,
            password_hash: &hash,
            activated: !needs_activation,
            now,
        },
    )
    .await
    {
        Ok(id) => id,
        Err(e) => return AppError::from(e).into_response(),
    };
    let _ = repo::record_audit(
        pool,
        Some(user_id),
        "user.register",
        Some(&format!("user:{user_id}")),
        None,
        now,
    )
    .await;
    tracing::info!(user.id = user_id, %handle, needs_activation, "新用户注册");

    if needs_activation {
        // 默认未激活：登录后会被引导到「待激活」提示
        Redirect::to("/login?registered=1").into_response()
    } else {
        match session::start_session(&state, user_id, None).await {
            Ok((token, _csrf)) => with_cookie(
                Redirect::to("/").into_response(),
                session::session_cookie(&state, &token),
            ),
            Err(e) => e.into_response(),
        }
    }
}

// ---------------------------------------------------------------- 登录 / 登出

pub async fn login_form(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let user = session::current_user(&state, &headers).await.ok().flatten();
    if user.is_some() {
        return Redirect::to("/").into_response();
    }
    crate::templates::render(LoginTemplate {
        site_name: &state.config.server.site_name,
        is_staff: false,
        csrf: user
            .as_ref()
            .map(|u| u.csrf_token.clone())
            .unwrap_or_default(),
        user_label: None,
        error: None,
        account: "",
    })
}

pub async fn login_submit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Form(form): Form<LoginForm>,
) -> Response {
    let page = |state: &AppState, error: &str| {
        crate::templates::render(LoginTemplate {
            site_name: &state.config.server.site_name,
            is_staff: false,
            csrf: String::new(),
            user_label: None,
            error: Some(error.to_string()),
            account: "",
        })
    };
    if let Err(e) = check_origin(&state, &headers) {
        return page(&state, &e.parts().2);
    }

    let account = form.account.trim().to_string();
    let pool = state.db.pool();
    let found = if account.contains('@') {
        repo::find_user_by_email(pool, &account.to_ascii_lowercase()).await
    } else {
        repo::find_user_by_handle(pool, &account).await
    };
    let user = match found {
        Ok(Some(user)) => user,
        Ok(None) => return page(&state, "用户名或口令不正确"),
        Err(e) => return AppError::from(e).into_response(),
    };
    // 刻意不区分「账号不存在」与「口令错误」，避免账号枚举。
    if !verify_password(&form.password, &user.password_hash) {
        return page(&state, "用户名或口令不正确");
    }

    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.chars().take(160).collect::<String>());
    match session::start_session(&state, user.id, user_agent.as_deref()).await {
        Ok((token, _csrf)) => with_cookie(
            Redirect::to("/").into_response(),
            session::session_cookie(&state, &token),
        ),
        Err(e) => e.into_response(),
    }
}

pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(e) = session::end_session(&state, &headers).await {
        return e.into_response();
    }
    with_cookie(
        Redirect::to("/").into_response(),
        session::clear_cookie(&state),
    )
}
