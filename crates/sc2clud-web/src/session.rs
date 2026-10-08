//! 会话与权限守卫。
//!
//! 约定：**权限判定只有 core::auth::allows 一个入口**，这里只负责「把会话变成 CurrentUser」
//! 与「按权限拒绝请求」，不在处理器里比较角色字符串。
//!
//! Cookie 只放随机令牌；库里存的是它的 blake3 摘要，数据库泄露也无法直接冒充登录。

use axum::http::{HeaderMap, header};
use sc2clud_core::auth::{Permission, Role, allows, hash_token, new_csrf_token, new_session_token};
use sc2clud_core::{Error as DomainError, now_unix};
use sc2clud_db::repo;

use crate::AppState;
use crate::error::{AppError, AppResult};

/// 会话 Cookie 名。
pub const SESSION_COOKIE: &str = "sc2clud_session";
/// 会话有效期：14 天。
pub const SESSION_TTL_SECS: i64 = 14 * 24 * 3600;

/// 当前登录者。游客是 `None`。
#[derive(Debug, Clone)]
pub struct CurrentUser {
    pub id: i64,
    /// 登录名：账号标识。
    pub handle: String,
    /// 显示名：页面上展示的名字。
    pub display_name: String,
    pub role: Role,
    pub activated: bool,
    pub csrf_token: String,
}

impl CurrentUser {
    /// 管理员及以上（能看审核中/被拒的帖子、能进后台）。
    pub fn is_staff(&self) -> bool {
        self.role >= Role::Admin
    }
}

/// 取某个 Cookie 的值（够用即可，不引 cookie crate）。
fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let part = part.trim();
        if let Some(rest) = part.strip_prefix(name)
            && let Some(value) = rest.strip_prefix('=')
            && !value.is_empty()
        {
            return Some(value.to_string());
        }
    }
    None
}

/// 装载当前用户；顺带续期 `last_seen_at`。
pub async fn current_user(state: &AppState, headers: &HeaderMap) -> AppResult<Option<CurrentUser>> {
    let Some(token) = cookie_value(headers, SESSION_COOKIE) else {
        return Ok(None);
    };
    let digest = hash_token(&token);
    let now = now_unix();
    let Some((session, user)) = repo::load_session(state.db.pool(), &digest, now).await? else {
        return Ok(None);
    };
    let _ = repo::touch_session(state.db.pool(), &digest, now).await;
    let role = Role::parse(&user.role)?;
    // 显示名兜底为登录名（存量数据在迁移里已回填，这里只是防御）。
    let display_name = if user.display_name.trim().is_empty() {
        user.handle.clone()
    } else {
        user.display_name.clone()
    };
    Ok(Some(CurrentUser {
        id: user.id,
        handle: user.handle,
        display_name,
        role,
        activated: user.activated_at.is_some(),
        csrf_token: session.csrf_token,
    }))
}

/// 权限守卫：不满足就 401（未登录）或 403（已登录但不够）。
/// 判断某个用户（可能未登录）是否具备权限。
///
/// 页面用它决定「显示哪些选项」（例如公告分区只对管理员出现）；
/// 真正的写操作仍然要再走一次 `guard`，界面过滤不能当授权。
pub fn allows_for(user: Option<&CurrentUser>, permission: Permission) -> bool {
    sc2clud_core::auth::allows(
        user.map(|u| u.role),
        user.is_some_and(|u| u.activated),
        permission,
    )
}

pub fn guard(user: Option<&CurrentUser>, permission: Permission) -> AppResult<()> {
    match user {
        None => Err(AppError::Domain(DomainError::Unauthorized(
            "请先登录".to_string(),
        ))),
        Some(user) => {
            if allows(Some(user.role), user.activated, permission) {
                Ok(())
            } else if !user.activated {
                Err(AppError::Domain(DomainError::Forbidden(
                    "账号尚未激活，请联系管理员".to_string(),
                )))
            } else {
                Err(AppError::Domain(DomainError::Forbidden(format!(
                    "需要{}及以上权限",
                    permission
                        .min_role()
                        .map(|role| role.label())
                        .unwrap_or("访客")
                ))))
            }
        }
    }
}

/// 登录：创建会话，返回 (令牌, CSRF 令牌)。
pub async fn start_session(
    state: &AppState,
    user_id: i64,
    user_agent: Option<&str>,
) -> AppResult<(String, String)> {
    let (token, digest) = new_session_token();
    let csrf = new_csrf_token();
    let now = now_unix();
    repo::create_session(
        state.db.pool(),
        &digest,
        user_id,
        &csrf,
        now,
        now + SESSION_TTL_SECS,
        user_agent,
    )
    .await?;
    Ok((token, csrf))
}

/// 登出：删除会话（幂等）。
pub async fn end_session(state: &AppState, headers: &HeaderMap) -> AppResult<()> {
    if let Some(token) = cookie_value(headers, SESSION_COOKIE) {
        repo::delete_session(state.db.pool(), &hash_token(&token)).await?;
    }
    Ok(())
}

/// `Set-Cookie` 值；站点走 https 时自动加 `Secure`。
pub fn session_cookie(state: &AppState, token: &str) -> String {
    let secure = if state.config.server.base_url.starts_with("https") {
        "; Secure"
    } else {
        ""
    };
    format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_TTL_SECS}{secure}"
    )
}

/// 清除 Cookie（登出时用）。
pub fn clear_cookie(state: &AppState) -> String {
    let secure = if state.config.server.base_url.starts_with("https") {
        "; Secure"
    } else {
        ""
    };
    format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}")
}

/// CSRF 双提交校验：表单隐藏字段必须与会话里的值一致。
pub fn check_csrf(user: &CurrentUser, form_token: &str) -> AppResult<()> {
    if form_token == user.csrf_token && !user.csrf_token.is_empty() {
        Ok(())
    } else {
        Err(AppError::Domain(DomainError::Forbidden(
            "CSRF 校验失败，请刷新页面重试".to_string(),
        )))
    }
}
