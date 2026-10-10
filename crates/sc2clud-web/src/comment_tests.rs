use crate::{AppState, router, session};
use axum::body::{Body, to_bytes};
use axum::http::{Request, StatusCode};
use sc2clud_core::{config::Config, counter::Counters, now_unix, sign::DownloadSigner};
use sc2clud_db::{Db, repo};
use sc2clud_storage::LocalFs;
use std::sync::Arc;
use tower::ServiceExt;

async fn setup() -> (AppState, i64, i64, String, String) {
    let db = Db::in_memory().await.unwrap();
    db.migrate().await.unwrap();
    let state = AppState::new(
        Config::default(),
        db,
        Arc::new(LocalFs::new(
            std::env::temp_dir(),
            DownloadSigner::new("测试", false),
            "/files",
        )),
        Arc::new(Counters::default()),
        0,
    );
    let user = repo::register_user(
        state.db.pool(),
        repo::NewUser {
            handle: "comments",
            display_name: "评论测试",
            email: "comments@test.local",
            password_hash: "测试",
            activated: true,
            now: now_unix(),
        },
    )
    .await
    .unwrap();
    let post = repo::create_post(state.db.pool(), user, "评论回归", "正文", now_unix())
        .await
        .unwrap();
    let (token, csrf) = session::start_session(&state, user, None).await.unwrap();
    (state, user, post, format!("sc2clud_session={token}"), csrf)
}

async fn json_comment(
    state: &AppState,
    post: i64,
    cookie: &str,
    csrf: &str,
    parent: Option<i64>,
) -> axum::response::Response {
    let mut request = Request::post(format!("/api/v1/posts/{post}/comments"))
        .header("cookie", cookie)
        .header("content-type", "application/json");
    if !csrf.is_empty() {
        request = request.header("x-csrf-token", csrf);
    }
    router(state.clone())
        .oneshot(
            request
                .body(Body::from(
                    serde_json::json!({"body":"有效回复", "parent_id":parent}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn json_root_comments_keep_valid_header_csrf() {
    let (state, _, post, cookie, csrf) = setup().await;
    let response = json_comment(&state, post, &cookie, &csrf, None).await;
    assert_eq!(response.status(), StatusCode::OK);
    let rows = repo::list_comments(state.db.pool(), post, 20)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].parent_id, None);
}

#[tokio::test]
async fn json_nested_comments_keep_valid_header_csrf_and_flatten_to_root() {
    let (state, user, post, cookie, csrf) = setup().await;
    let root = repo::create_comment(state.db.pool(), post, user, "现有根评论", None, now_unix())
        .await
        .unwrap();
    assert_eq!(
        json_comment(&state, post, &cookie, &csrf, Some(root))
            .await
            .status(),
        StatusCode::OK
    );
    let rows = repo::list_comments(state.db.pool(), post, 20)
        .await
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[1].parent_id, Some(root));
    // 回复楼中楼仍挂在根楼层，不新增第三层。
    assert_eq!(
        json_comment(&state, post, &cookie, &csrf, Some(rows[1].id))
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        repo::list_comments(state.db.pool(), post, 20)
            .await
            .unwrap()[2]
            .parent_id,
        Some(root)
    );
}

#[tokio::test]
async fn json_wrong_or_missing_csrf_never_creates_root_or_nested_comments() {
    let (state, user, post, cookie, _) = setup().await;
    let root = repo::create_comment(state.db.pool(), post, user, "现有根评论", None, now_unix())
        .await
        .unwrap();
    for parent in [None, Some(root)] {
        for token in ["wrong-token", ""] {
            assert_eq!(
                json_comment(&state, post, &cookie, token, parent)
                    .await
                    .status(),
                StatusCode::FORBIDDEN
            );
            assert_eq!(
                repo::list_comments(state.db.pool(), post, 20)
                    .await
                    .unwrap()
                    .len(),
                1
            );
        }
    }
}

#[tokio::test]
async fn ordinary_comment_form_still_validates_its_own_csrf() {
    let (state, _, post, cookie, csrf) = setup().await;
    for token in ["wrong-token", "", &csrf] {
        let response = router(state.clone())
            .oneshot(
                Request::post(format!("/p/{post}/comments"))
                    .header("cookie", &cookie)
                    .header("content-type", "application/x-www-form-urlencoded")
                    .body(Body::from(
                        form_urlencoded::Serializer::new(String::new())
                            .append_pair("csrf", token)
                            .append_pair("body", "普通提交")
                            .finish(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        // 表单错误保持 403；只有正确隐藏字段会写入并重定向。
        assert_eq!(
            response.status(),
            if token == csrf {
                StatusCode::SEE_OTHER
            } else {
                StatusCode::FORBIDDEN
            }
        );
        assert_eq!(
            repo::list_comments(state.db.pool(), post, 20)
                .await
                .unwrap()
                .len(),
            usize::from(token == csrf)
        );
    }
}

#[tokio::test]
async fn rendered_small_avatars_close_before_root_and_nested_content() {
    let (state, user, post, cookie, _) = setup().await;
    repo::set_avatar_small(state.db.pool(), user, Some("small-avatar"))
        .await
        .unwrap();
    let root = repo::create_comment(state.db.pool(), post, user, "根评论", None, 1)
        .await
        .unwrap();
    repo::create_comment(state.db.pool(), post, user, "楼中楼", Some(root), 2)
        .await
        .unwrap();
    let response = router(state.clone())
        .oneshot(
            Request::get(format!("/p/{post}"))
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let html = String::from_utf8(
        to_bytes(response.into_body(), 1_000_000)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    let avatars: Vec<_> = html.match_indices("src=\"/avatar/small-avatar\"").collect();
    assert_eq!(avatars.len(), 2, "根评论与楼中楼都应渲染小头像");
    for (index, _) in avatars {
        let tag = html[index..].split_once('>').unwrap().0;
        assert!(!tag.contains('<'), "头像标签不得吸收下一元素：{tag}");
        assert!(tag.contains("alt=\"\""));
        assert!(tag.contains("loading=\"lazy\""));
        assert!(tag.contains("width=\"") && tag.contains("height=\""));
    }
}
