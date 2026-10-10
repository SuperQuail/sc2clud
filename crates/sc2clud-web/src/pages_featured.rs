//! 精华操作与页面共用授权。

use axum::extract::{Path, State, rejection::FormRejection};
use axum::http::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};
use axum::{Form, Json};
use sc2clud_core::auth::{Permission, allows_feature_post};
use sc2clud_core::{Error, now_unix};
use sc2clud_db::repo;
use serde::Deserialize;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::routes::require_user;
use crate::session::{self, CurrentUser};

/// 页面和提交共用同一判定；任职只从数据库读取。
pub async fn can_feature_post(
    state: &AppState,
    user: Option<&CurrentUser>,
    section: &str,
) -> AppResult<bool> {
    let Some(user) = user else {
        return Ok(false);
    };
    let capabilities =
        repo::section_capabilities(state.db.pool(), user.id, user.role, section).await?;
    Ok(capabilities.is_some_and(|caps| {
        allows_feature_post(Some(user.role), user.activated, caps.is_moderator)
    }))
}

#[derive(Deserialize)]
pub struct FeaturedForm {
    pub csrf: String,
    pub featured: String,
}

/// 精华状态使用 0/1 显式目标，避免重试时反转状态。
pub async fn set_featured(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
    form: Result<Form<FeaturedForm>, FormRejection>,
) -> AppResult<Response> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::FeaturePost)?;
    let Form(form) = form.map_err(|_| Error::InvalidInput("精华表单无效".to_string()))?;
    session::check_csrf(&user, &form.csrf)?;
    let featured = match form.featured.as_str() {
        "0" => false,
        "1" => true,
        _ => return Err(Error::InvalidInput("精华状态必须为 0 或 1".to_string()).into()),
    };
    let post = repo::get_post_for(state.db.pool(), id, Some(user.id), user.is_staff())
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在或不可见"))?;
    if !can_feature_post(&state, Some(&user), &post.section).await? {
        return Err(Error::Forbidden("没有此分区的精华管理权限".to_string()).into());
    }
    let changed =
        repo::set_post_featured(state.db.pool(), id, featured, Some(user.id), now_unix()).await?;
    // 普通表单默认重定向；显式 Accept: application/json 才返回 JSON。
    if headers
        .get(axum::http::header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("application/json"))
    {
        Ok(Json(serde_json::json!({ "featured": featured, "changed": changed })).into_response())
    } else {
        Ok(Redirect::to(&format!("/p/{id}")).into_response())
    }
}

#[cfg(test)]
mod tests {
    use crate::{AppState, router, session};
    use axum::body::{Body, to_bytes};
    use axum::http::{Request, StatusCode};
    use sc2clud_core::{config::Config, counter::Counters, now_unix, sign::DownloadSigner};
    use sc2clud_db::{Db, repo};
    use sc2clud_storage::LocalFs;
    use std::sync::Arc;
    use tower::ServiceExt;

    async fn setup() -> AppState {
        let db = Db::in_memory().await.unwrap();
        db.migrate().await.unwrap();
        AppState::new(
            Config::default(),
            db,
            Arc::new(LocalFs::new(
                std::env::temp_dir(),
                DownloadSigner::new("测试", false),
                "/files",
            )),
            Arc::new(Counters::default()),
            0,
        )
    }

    async fn user(
        state: &AppState,
        handle: &str,
        role: &str,
        active: bool,
    ) -> (i64, String, String) {
        let id = repo::register_user(
            state.db.pool(),
            repo::NewUser {
                handle,
                display_name: handle,
                email: &format!("{handle}@test.local"),
                password_hash: "测试",
                activated: active,
                now: now_unix(),
            },
        )
        .await
        .unwrap();
        repo::set_user_role(state.db.pool(), id, role)
            .await
            .unwrap();
        let (token, csrf) = session::start_session(state, id, None).await.unwrap();
        (id, format!("sc2clud_session={token}"), csrf)
    }

    async fn post(state: &AppState, author: i64, section: &str, review_state: &str) -> i64 {
        repo::create_post_reviewed(
            state.db.pool(),
            repo::NewPost {
                author_id: author,
                kind: "discussion",
                section,
                title: "测试帖子",
                body: "正文",
                image_count: 0,
                review_state,
                review_note: None,
                now: now_unix(),
            },
        )
        .await
        .unwrap()
    }

    async fn request(
        state: &AppState,
        id: i64,
        cookie: &str,
        csrf: &str,
        value: &str,
        json: bool,
    ) -> axum::response::Response {
        router(state.clone())
            .oneshot(
                Request::post(format!("/p/{id}/featured"))
                    .header("cookie", cookie)
                    .header("content-type", "application/x-www-form-urlencoded")
                    .header(
                        "accept",
                        if json {
                            "application/json"
                        } else {
                            "text/html"
                        },
                    )
                    .body(Body::from(format!("csrf={csrf}&featured={value}")))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn featured_endpoint_scopes_authority_and_rechecks_revocation() {
        let state = setup().await;
        let (id, cookie, csrf) = user(&state, "moderator", "member", true).await;
        let own = post(&state, id, "custom_campaign", "approved").await;
        let cross = post(&state, id, "vanilla_mod", "approved").await;
        assert_eq!(
            request(&state, own, "", &csrf, "1", true).await.status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            request(&state, own, &cookie, &csrf, "1", true)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        repo::add_section_moderator(state.db.pool(), "custom_campaign", id, None, now_unix())
            .await
            .unwrap();
        let (other, other_cookie, other_csrf) =
            user(&state, "other_moderator", "developer", true).await;
        repo::add_section_moderator(state.db.pool(), "vanilla_mod", other, None, now_unix())
            .await
            .unwrap();
        assert_eq!(
            request(&state, own, &other_cookie, &other_csrf, "1", true)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(
                &state,
                cross,
                &cookie,
                &csrf,
                "1&section=custom_campaign&role=admin",
                true
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(&state, cross, &cookie, &csrf, "1", true)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(&state, own, &cookie, "错误", "1", true)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        for invalid in ["2", "true", "01", "", "-1"] {
            assert_eq!(
                request(&state, own, &cookie, &csrf, invalid, true)
                    .await
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
        for changed in [true, false] {
            let response = request(&state, own, &cookie, &csrf, "1", true).await;
            assert_eq!(response.status(), StatusCode::OK);
            let body = to_bytes(response.into_body(), 1024).await.unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                serde_json::json!({"featured": true, "changed": changed})
            );
        }
        let response = request(&state, own, &cookie, &csrf, "0", false).await;
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        assert_eq!(response.headers()["location"], format!("/p/{own}"));
        repo::remove_section_moderator(state.db.pool(), "custom_campaign", id)
            .await
            .unwrap();
        assert_eq!(
            request(&state, own, &cookie, &csrf, "1", true)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            repo::recent_audit(state.db.pool(), 20).await.unwrap().len(),
            2
        );
    }

    #[tokio::test]
    async fn featured_endpoint_enforces_activation_visibility_and_archives() {
        let state = setup().await;
        let (author, cookie, csrf) = user(&state, "author", "member", true).await;
        let (admin, admin_cookie, admin_csrf) = user(&state, "admin", "admin", true).await;
        let (_, inactive_cookie, inactive_csrf) = user(&state, "inactive", "super", false).await;
        repo::add_section_moderator(state.db.pool(), "custom_campaign", author, None, now_unix())
            .await
            .unwrap();
        let others_post = post(&state, admin, "custom_campaign", "approved").await;
        let response = router(state.clone())
            .oneshot(
                Request::get(format!("/p/{others_post}/edit"))
                    .header("cookie", &cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        for action in ["archive", "approve"] {
            let response = router(state.clone())
                .oneshot(
                    Request::post(format!("/admin/posts/{others_post}/{action}"))
                        .header("cookie", &cookie)
                        .header("content-type", "application/x-www-form-urlencoded")
                        .body(Body::from(format!("csrf={csrf}")))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::FORBIDDEN);
        }
        for review in ["pending", "rejected"] {
            let hidden = post(&state, admin, "custom_campaign", review).await;
            assert_eq!(
                request(&state, hidden, &cookie, &csrf, "0", true)
                    .await
                    .status(),
                StatusCode::NOT_FOUND
            );
            assert_eq!(
                request(&state, hidden, &admin_cookie, &admin_csrf, "1", true)
                    .await
                    .status(),
                StatusCode::FORBIDDEN
            );
        }
        let live = post(&state, author, "custom_campaign", "approved").await;
        assert_eq!(
            request(&state, live, &inactive_cookie, &inactive_csrf, "1", true)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(&state, live, &admin_cookie, &admin_csrf, "1", true)
                .await
                .status(),
            StatusCode::OK
        );
        repo::set_post_archived(state.db.pool(), live, true, now_unix())
            .await
            .unwrap();
        assert_eq!(
            request(&state, live, &cookie, &csrf, "0", true)
                .await
                .status(),
            StatusCode::OK
        );
        assert_eq!(
            request(&state, live, &cookie, &csrf, "1", true)
                .await
                .status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            request(&state, 999999, &cookie, &csrf, "0", true)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}
