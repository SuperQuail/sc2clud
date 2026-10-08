//! 路由与处理器。
//!
//! 页面走服务端渲染（askama）；接口走 JSON；两者共用同一套领域错误映射（见 crate::error）。
//!
//! 代理信任说明：应用只监听回环地址，nginx 在同一台机器上，因此可以直接信任
//! `X-Real-IP` / `X-Forwarded-For`。换部署拓扑（多机、容器）时必须同步调整。

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{ConnectInfo, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, middleware};
use bytes::Bytes;
use futures_util::StreamExt;
use sc2clud_core::auth::Permission;
use sc2clud_core::capacity::ensure_free_space;
use sc2clud_core::config::DownloadMode;
use sc2clud_core::resource::PostSection;
use sc2clud_core::review::{PostKind, ReviewState, review_for_author};
use sc2clud_core::{BlobHash, Error as DomainError, now_unix, safety};
use sc2clud_db::repo;
use sc2clud_storage::BlobReader;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::io::StreamReader;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::session::{self, CurrentUser};
use crate::templates::{
    ClaimRequest, FeedView, FileDto, FilePageTemplate, FileView, IndexTemplate, MyFileStats,
    PostCreateRequest, PostDto, SectionOption, UploadQuery, format_date, human_bytes,
};
use crate::upload::{DEFAULT_QUEUE_DEPTH, pump_body};

// ------------------------------------------------------------ 路由表

/// 只读页面：给足超时的同时不至于让慢客户端占住 worker。
pub fn pages() -> Router<AppState> {
    Router::new()
        .route("/", axum::routing::get(index))
        .route(
            "/register",
            axum::routing::get(crate::pages_auth::register_form)
                .post(crate::pages_auth::register_submit),
        )
        .route(
            "/login",
            axum::routing::get(crate::pages_auth::login_form).post(crate::pages_auth::login_submit),
        )
        .route("/logout", axum::routing::post(crate::pages_auth::logout))
        .route("/me", axum::routing::get(crate::pages_profile::me))
        .route(
            "/u/{handle}",
            axum::routing::get(crate::pages_profile::profile),
        )
        .route(
            "/avatar/{hash}",
            axum::routing::get(crate::pages_profile::serve_avatar),
        )
        .route("/admin", axum::routing::get(crate::pages_admin::panel))
        .route(
            "/admin/users/{id}/activate",
            axum::routing::post(crate::pages_admin::activate),
        )
        .route(
            "/admin/users/{id}/deactivate",
            axum::routing::post(crate::pages_admin::deactivate),
        )
        .route(
            "/admin/users/{id}/role",
            axum::routing::post(crate::pages_admin::set_role),
        )
        .route(
            "/admin/users/{id}/rename",
            axum::routing::post(crate::pages_admin::rename),
        )
        .route(
            "/admin/settings/require-activation",
            axum::routing::post(crate::pages_admin::toggle_activation_policy),
        )
        .route("/p/{id}", axum::routing::get(crate::pages_posts::post_page))
        .route(
            "/p/{id}/comments",
            axum::routing::post(crate::pages_posts::comment_submit),
        )
        .route(
            "/new",
            axum::routing::get(crate::pages_posts::new_post_form)
                .post(crate::pages_posts::new_post_submit),
        )
        .route("/f/{id}", axum::routing::get(file_page))
        .route("/healthz", axum::routing::get(healthz))
        .route("/readyz", axum::routing::get(readyz))
}

/// 读接口：GET / DELETE / 秒传声明。
pub fn api_read() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/posts",
            axum::routing::get(list_posts).post(create_post),
        )
        .route("/api/v1/files", axum::routing::get(list_files))
        .route("/img/{hash}", axum::routing::get(serve_image))
        .route("/api/v1/files/claim", axum::routing::post(claim_file))
        .route("/api/v1/files/{id}", axum::routing::delete(delete_file))
        .route(
            "/api/v1/files/{id}/download",
            axum::routing::get(download_file),
        )
}

/// 上传接口：**不加超时层**——慢速上传是常态，超时交给 nginx 的 client_body_timeout。
pub fn api_upload() -> Router<AppState> {
    Router::new()
        .route("/api/v1/files", axum::routing::put(upload_file))
        .route("/api/v1/me/avatar", axum::routing::post(upload_avatar))
        .route(
            "/api/v1/posts/{post_id}/images",
            axum::routing::post(upload_post_image),
        )
}

// ------------------------------------------------------------ 工具

#[derive(Debug, serde::Deserialize)]
pub struct IndexQuery {
    #[serde(default)]
    pub section: Option<String>,
}

pub(crate) fn wants_html(headers: &HeaderMap) -> bool {
    headers
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("text/html"))
        .unwrap_or(false)
}

fn content_length(headers: &HeaderMap) -> Option<u64> {
    headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
}

/// 客户端 IP：优先取 nginx 写入的转发头。
pub fn client_ip(headers: &HeaderMap, peer: Option<SocketAddr>) -> Option<String> {
    for name in ["x-real-ip", "x-forwarded-for"] {
        if let Some(value) = headers.get(name).and_then(|v| v.to_str().ok()) {
            if let Some(first) = value.split(',').map(str::trim).find(|s| !s.is_empty()) {
                return Some(first.to_string());
            }
        }
    }
    peer.map(|addr| addr.ip().to_string())
}

/// 限速主体：当前脚手架用 IP；接入登录后换成 user id（改这一处即可）。
fn client_subject(headers: &HeaderMap, peer: Option<SocketAddr>) -> String {
    client_ip(headers, peer).unwrap_or_else(|| "unknown".to_string())
}

fn render_template<T: askama::Template>(template: T) -> Response {
    match template.render() {
        Ok(html) => ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], html).into_response(),
        Err(e) => {
            tracing::error!(error = %e, "模板渲染失败");
            AppError::internal(format!("模板渲染失败：{e}")).into_response()
        }
    }
}

/// 访问日志：跳过探针路径，避免把日志刷满。
pub async fn access_log(request: axum::extract::Request, next: middleware::Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let started = std::time::Instant::now();
    let response = next.run(request).await;
    if path != "/healthz" && path != "/readyz" {
        tracing::info!(
            method = %method,
            path = %path,
            status = response.status().as_u16(),
            elapsed_ms = started.elapsed().as_millis() as u64,
            "request"
        );
    }
    response
}

// ------------------------------------------------------------ 探针

pub async fn healthz() -> impl IntoResponse {
    Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") }))
}

/// 就绪探针：真的打一次数据库与存储根目录。
pub async fn readyz(State(state): State<AppState>) -> Response {
    let mut problems = Vec::new();
    if let Err(e) = state.db.ping().await {
        problems.push(format!("db: {e}"));
    }
    if let Err(e) = state.storage.health().await {
        problems.push(format!("storage: {e}"));
    }
    if problems.is_empty() {
        (StatusCode::OK, Json(json!({ "status": "ready" }))).into_response()
    } else {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "status": "degraded", "problems": problems })),
        )
            .into_response()
    }
}

// ------------------------------------------------------------ 页面

/// 取当前登录者；文件与发帖相关操作都要求已登录。
pub(crate) async fn require_user(state: &AppState, headers: &HeaderMap) -> AppResult<CurrentUser> {
    session::current_user(state, headers)
        .await?
        .ok_or_else(|| AppError::Domain(DomainError::Unauthorized("请先登录".to_string())))
}

pub async fn index(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<IndexQuery>,
) -> Response {
    let user = session::current_user(&state, &headers).await.ok().flatten();
    let section = query
        .section
        .as_deref()
        .and_then(|raw| PostSection::parse(raw).ok());
    match build_index(&state, user.as_ref(), section).await {
        Ok(template) => render_template(template),
        Err(e) => e.into_page_response(wants_html(&headers)),
    }
}

/// 首页：**按查看者过滤**，不把别人的东西摊给普通用户。
///
/// - 帖子流走 `repo::list_feed`（审核中只有作者与管理员可见）；
/// - 网盘区块只显示**自己的**文件与统计，游客与未登录者完全看不到；
/// - 发帖/上传入口按「是否已激活」显示，未激活只给提示。
async fn build_index<'a>(
    state: &'a AppState,
    user: Option<&CurrentUser>,
    section: Option<PostSection>,
) -> AppResult<IndexTemplate<'a>> {
    let viewer_id = user.map(|u| u.id);
    let is_staff = user.is_some_and(CurrentUser::is_staff);
    let feed = repo::list_feed_by_section(
        state.db.pool(),
        viewer_id,
        is_staff,
        section.map(PostSection::as_str),
        20,
        0,
    )
    .await?;

    // 网盘是后续施工内容：**只对网站管理员及以上**开放，普通用户与游客都看不到这一块。
    let netdisk_visible = user.is_some_and(CurrentUser::is_staff);
    let my_files = match (viewer_id, netdisk_visible) {
        (Some(id), true) => repo::list_files(state.db.pool(), id, 20).await?,
        _ => Vec::new(),
    };
    let my_file_stats = match (viewer_id, netdisk_visible) {
        (Some(id), true) => {
            let stats = repo::file_stats(state.db.pool(), id).await?;
            Some(MyFileStats {
                files: stats.files,
                bytes_human: human_bytes(stats.bytes.max(0) as u64),
                downloads: stats.downloads,
            })
        }
        _ => None,
    };

    Ok(IndexTemplate {
        site_name: &state.config.server.site_name,
        user_label: user.map(|u| u.display_name.clone()),
        user_role_label: user.map(|u| u.role.label().to_string()).unwrap_or_default(),
        can_post: user.is_some_and(|u| u.activated),
        needs_activation: user.is_some_and(|u| !u.activated),
        sections_all_active: section.is_none(),
        sections: PostSection::ALL
            .iter()
            .map(|s| SectionOption {
                value: s.as_str().to_string(),
                label: s.label().to_string(),
                checked: section == Some(*s),
            })
            .collect(),
        visible_posts: feed.len() as i64,
        posts: feed.iter().map(|row| feed_view(row, viewer_id)).collect(),
        is_staff,
        my_avatar: user.and_then(|u| u.avatar_hash.clone()),
        netdisk_visible,
        my_files: my_files.iter().map(FileView::from_row).collect(),
        my_file_stats,
        max_upload_human: human_bytes(state.config.limits.max_upload_bytes),
    })
}

/// 帖子卡片视图：状态解析失败时按「审核中」处理——宁可不显示，也不要误露。
pub(crate) fn feed_view(row: &sc2clud_db::PostWithAuthorRow, viewer_id: Option<i64>) -> FeedView {
    let state = ReviewState::parse(&row.review_state).unwrap_or(ReviewState::Pending);
    let kind = PostKind::parse(&row.kind).unwrap_or(PostKind::Discussion);
    let author_role = sc2clud_core::auth::Role::parse(&row.author_role)
        .map(|role| role.label())
        .unwrap_or("普通用户");
    let section = PostSection::parse(&row.section).unwrap_or(PostSection::default_section());
    FeedView {
        id: row.id,
        avatar: row.author_avatar.clone(),
        title: row.title.clone(),
        section: section.as_str().to_string(),
        section_label: section.label().to_string(),
        preview: row.body.replace('\n', " ").chars().take(120).collect(),
        kind: kind.as_str().to_string(),
        kind_label: kind.label().to_string(),
        state: state.as_str().to_string(),
        state_label: state.label().to_string(),
        author: row.author_display_name.clone(),
        author_role_label: author_role.to_string(),
        created_at: format_date(row.created_at),
        image_count: row.image_count,
        is_mine: viewer_id == Some(row.author_id),
        cover_hash: row.cover_hash.clone(),
    }
}

/// 文件详情页：**只有所有者与管理员及以上**能看；其他人一律 404（不泄露「存在但无权」）。
pub async fn file_page(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    let user = session::current_user(&state, &headers).await.ok().flatten();
    match build_file_page(&state, id, user.as_ref()).await {
        Ok(template) => render_template(template),
        Err(e) => e.into_page_response(wants_html(&headers)),
    }
}

async fn build_file_page<'a>(
    state: &'a AppState,
    id: i64,
    user: Option<&CurrentUser>,
) -> AppResult<FilePageTemplate<'a>> {
    let user = user.ok_or_else(|| AppError::not_found("文件不存在或已删除"))?;
    let row = repo::get_file_with_owner(state.db.pool(), id)
        .await?
        .ok_or_else(|| AppError::not_found("文件不存在或已删除"))?;
    if row.owner_id != user.id && !user.is_staff() {
        return Err(AppError::not_found("文件不存在或已删除"));
    }
    let download_href = format!("/api/v1/files/{}/download", row.id);
    Ok(FilePageTemplate {
        site_name: &state.config.server.site_name,
        user_label: Some(user.display_name.clone()),
        file: FileView::from_owner_row(&row),
        owner_handle: row.owner_handle.clone(),
        download_href,
    })
}

/// 兜底 404：HTML 请求给错误页，接口请求给 JSON。
pub async fn not_found(headers: HeaderMap) -> Response {
    AppError::not_found("页面或接口不存在").into_page_response(wants_html(&headers))
}

// ------------------------------------------------------------ 帖子图片

/// 认图片格式只看魔数，不信客户端声明的 Content-Type。
pub(crate) fn sniff_image_mime(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if head.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if head.starts_with(b"GIF8") {
        Some("image/gif")
    } else if head.len() >= 12 && &head[0..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// 给某篇帖子加一张图（主帖最多 10 张；回复不带图）。
///
/// 原图直接落内容寻址存储并**永久保留**；压缩与缩略图由后台任务补齐
/// （见 `image_jobs`）。上传同样要过「登录 + 已激活 + 磁盘闸门」。
pub async fn upload_post_image(
    State(state): State<AppState>,
    Path(post_id): Path<i64>,
    headers: HeaderMap,
    body: Body,
) -> AppResult<Json<serde_json::Value>> {
    let user = require_user(&state, &headers).await?;
    // 帖子配图不是网盘：任何已激活用户都能给自己的帖子加图
    session::guard(Some(&user), Permission::CreateDiscussion)?;
    ensure_free_space(
        state.storage.available_bytes().await?,
        state.config.limits.min_free_bytes,
    )?;

    // 只能给自己的帖子加图，且帖子必须对自己可见。
    let post = repo::get_post_for(state.db.pool(), post_id, Some(user.id), user.is_staff())
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在或不可见"))?;
    if post.author_id != user.id {
        return Err(AppError::Domain(DomainError::Forbidden(
            "只能给自己的帖子加图".to_string(),
        )));
    }
    let count = repo::count_post_images(state.db.pool(), post_id).await?;
    if count >= sc2clud_core::review::MAX_IMAGES_PER_POST as i64 {
        return Err(invalid(format!(
            "主帖最多 {} 张图",
            sc2clud_core::review::MAX_IMAGES_PER_POST
        )));
    }

    // 先读一小块判类型，再把它接回流的头部——恒定内存，不整份读入。
    let mut stream = body.into_data_stream();
    let first = stream.next().await;
    let head_bytes = match &first {
        Some(Ok(chunk)) => chunk.clone(),
        Some(Err(e)) => return Err(AppError::internal(format!("读取请求体失败：{e}"))),
        None => Bytes::new(),
    };
    let Some(mime) = sniff_image_mime(&head_bytes) else {
        return Err(invalid("只接受 PNG / JPEG / GIF / WebP 图片"));
    };

    // `stream::iter(Option)` 恰好产出 0 或 1 项：把用于判类型的头一块拼回流的开头，
    // 类型与后续一致，且全程只多留一个 chunk 的内存。
    let chained = futures_util::stream::iter(first).chain(stream);
    let body_stream: std::pin::Pin<
        Box<dyn futures_util::Stream<Item = Result<Bytes, axum::Error>> + Send>,
    > = Box::pin(chained);

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(DEFAULT_QUEUE_DEPTH);
    let reader: BlobReader = Box::pin(StreamReader::new(ReceiverStream::new(rx)));
    let subject = client_subject(&headers, None);
    let pump = tokio::spawn(pump_body(
        body_stream,
        tx,
        Arc::clone(&state.upload_gate),
        subject,
        state.config.limits.max_upload_bytes,
    ));

    let stored = state.storage.put_stream(reader, None).await;
    let pumped = match pump.await {
        Ok(result) => result,
        Err(join) => Err(AppError::internal(format!("上传任务异常：{join}"))),
    };
    let outcome = match (stored, pumped) {
        (Ok(outcome), Ok(_)) => outcome,
        (Ok(_), Err(client_err)) => return Err(client_err),
        (Err(storage_err), Err(client_err)) => {
            let (status, _, _) = client_err.parts();
            return if status.is_client_error() {
                Err(client_err)
            } else {
                Err(storage_err.into())
            };
        }
        (Err(storage_err), Ok(_)) => return Err(storage_err.into()),
    };

    let hash = outcome.stat.hash.clone();
    let size = outcome.stat.size as i64;
    repo::ensure_blob(state.db.pool(), hash.as_str(), size, now_unix()).await?;
    let image_id = repo::add_post_image(
        state.db.pool(),
        post_id,
        count,
        hash.as_str(),
        size,
        mime,
        now_unix(),
    )
    .await?;
    state.counters.bump("post:image", 1);
    tracing::info!(post.id = post_id, image.id = image_id, blob = %hash, size, %mime, "帖子配图已入库");

    Ok(Json(json!({
        "id": image_id,
        "hash": hash.to_string(),
        "url": format!("/img/{hash}"),
        "size": size,
        "mime": mime,
        "count": count + 1,
    })))
}

/// 图片读取：内容寻址，因此可以长缓存。
///
/// 只服务**登记为帖子图片**的内容（不开放任意 blob）；生产由 nginx 直出字节，
/// 本地开发（`serve_blobs_locally`）时由应用补齐，方便本机与截图。
pub async fn serve_image(
    State(state): State<AppState>,
    Path(raw_hash): Path<String>,
) -> AppResult<Response> {
    let hash = BlobHash::parse(&raw_hash)?;
    let Some(image) = repo::find_post_image_by_hash(state.db.pool(), hash.as_str()).await? else {
        return Err(AppError::not_found("图片不存在"));
    };
    if state.storage.stat(&hash).await?.is_none() {
        return Err(AppError::not_found("图片不存在"));
    }
    let mime = image.mime.clone();
    let cache = [(header::CACHE_CONTROL, "public, max-age=31536000, immutable")];

    if !state.config.server.serve_blobs_locally {
        // 按图片真实类型选内部目录：nginx 那里每个目录一个 default_type，
        // 这样浏览器拿到的 Content-Type 才是 image/webp 之类而不是 octet-stream。
        let kind = match mime.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpeg",
            "image/gif" => "gif",
            _ => "webp",
        };
        let location = format!(
            "{}/{}/{}",
            state.config.download.image_prefix.trim_end_matches('/'),
            kind,
            hash.relative_path()
        );
        return Ok((
            StatusCode::OK,
            [(
                header::HeaderName::from_static("x-accel-redirect"),
                location.as_str(),
            )],
        )
            .into_response());
    }

    // 本地开发：直接把字节流给出去（生产走不到这里，配置校验也会拦住非回环监听）。
    let reader = state.storage.get_stream(&hash).await?;
    let stream = tokio_util::io::ReaderStream::new(reader);
    let mut response = Response::new(Body::from_stream(stream));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_str(&mime)
            .unwrap_or_else(|_| header::HeaderValue::from_static("application/octet-stream")),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("public, max-age=31536000, immutable"),
    );
    let _ = cache;
    Ok(response)
}

// ------------------------------------------------------------ 头像

/// 上传头像。
///
/// 压缩与裁剪**已经在浏览器里做完**（canvas，压到 ≤64KB），服务端只做：
/// 登录 + 已激活 + CSRF + 魔数认类型 + 体积上限（流式计数，超了直接断）+ 磁盘闸门。
pub async fn upload_avatar(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> AppResult<Json<serde_json::Value>> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::SetAvatar)?;
    let token = headers
        .get("x-csrf-token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    session::check_csrf(&user, token)?;
    ensure_free_space(
        state.storage.available_bytes().await?,
        state.config.limits.min_free_bytes,
    )?;

    let mut stream = body.into_data_stream();
    let first = stream.next().await;
    let head_bytes = match &first {
        Some(Ok(chunk)) => chunk.clone(),
        Some(Err(e)) => return Err(AppError::internal(format!("读取请求体失败：{e}"))),
        None => Bytes::new(),
    };
    let Some(mime) = sniff_image_mime(&head_bytes) else {
        return Err(invalid("只接受 PNG / JPEG / GIF / WebP 图片"));
    };

    let chained = futures_util::stream::iter(first).chain(stream);
    let body_stream: std::pin::Pin<
        Box<dyn futures_util::Stream<Item = Result<Bytes, axum::Error>> + Send>,
    > = Box::pin(chained);
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(DEFAULT_QUEUE_DEPTH);
    let reader: BlobReader = Box::pin(StreamReader::new(ReceiverStream::new(rx)));
    let subject = client_subject(&headers, None);
    let limit = sc2clud_core::auth::MAX_AVATAR_BYTES.min(state.config.limits.max_upload_bytes);
    let pump = tokio::spawn(pump_body(
        body_stream,
        tx,
        Arc::clone(&state.upload_gate),
        subject,
        limit,
    ));

    let stored = state.storage.put_stream(reader, None).await;
    let pumped = match pump.await {
        Ok(result) => result,
        Err(join) => Err(AppError::internal(format!("上传任务异常：{join}"))),
    };
    let outcome = match (stored, pumped) {
        (Ok(outcome), Ok(_)) => outcome,
        (Ok(_), Err(client_err)) => return Err(client_err),
        (Err(storage_err), Err(client_err)) => {
            let (status, _, _) = client_err.parts();
            return if status.is_client_error() {
                Err(client_err)
            } else {
                Err(storage_err.into())
            };
        }
        (Err(storage_err), Ok(_)) => return Err(storage_err.into()),
    };

    let hash = outcome.stat.hash.clone();
    let size = outcome.stat.size as i64;
    if outcome.stat.size > sc2clud_core::auth::MAX_AVATAR_BYTES {
        return Err(AppError::Domain(DomainError::QuotaExceeded(format!(
            "头像不得超过 {} KB",
            sc2clud_core::auth::MAX_AVATAR_BYTES / 1024
        ))));
    }
    repo::ensure_blob(state.db.pool(), hash.as_str(), size, now_unix()).await?;
    repo::set_user_avatar(state.db.pool(), user.id, Some(hash.as_str()), Some(mime)).await?;
    state.counters.bump("avatar:set", 1);
    tracing::info!(user.id = user.id, blob = %hash, size, %mime, "更新头像");
    Ok(Json(json!({
        "hash": hash.to_string(),
        "url": format!("/avatar/{hash}"),
        "size": size,
        "mime": mime,
    })))
}

// ------------------------------------------------------------ 社区接口

pub async fn list_posts(State(state): State<AppState>) -> AppResult<Json<Vec<PostDto>>> {
    let posts = repo::list_posts(state.db.pool(), 50, 0).await?;
    Ok(Json(
        posts
            .into_iter()
            .map(|p| PostDto {
                id: p.id,
                title: p.title,
                body: p.body,
                created_at: p.created_at,
            })
            .collect(),
    ))
}

pub async fn create_post(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<PostCreateRequest>,
) -> AppResult<(StatusCode, Json<PostDto>)> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::CreateDiscussion)?;
    let title = req.title.trim();
    let body = req.body.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err(invalid("标题需为 1..200 字"));
    }
    if body.is_empty() || body.chars().count() > 20_000 {
        return Err(invalid("正文需为 1..20000 字"));
    }

    // 三类帖子对所有已激活用户开放；管理员及以上跳过审核机直接发布。
    let kind = PostKind::parse(req.kind.as_deref().unwrap_or("discussion"))?;
    session::guard(Some(&user), kind.required_permission())?;
    let outcome = review_for_author(Some(user.role), kind, title, body, 0);
    if !outcome.state.visible_to(false, false) {
        // 被拒的帖子不进 feed：这里先把结论记下来，由调用方看到 422 的说明。
        tracing::info!(user.id = user.id, note = ?outcome.note, "帖子被审核机拒绝");
    }

    let now = now_unix();
    let id = repo::create_post_reviewed(
        state.db.pool(),
        repo::NewPost {
            author_id: user.id,
            kind: kind.as_str(),
            section: PostSection::default_section().as_str(),
            title,
            body,
            image_count: 0,
            review_state: outcome.state.as_str(),
            review_note: outcome.note.as_deref(),
            now,
        },
    )
    .await?;
    state.counters.bump("post:created", 1);
    tracing::info!(
        post.id = id,
        kind = kind.as_str(),
        state = outcome.state.as_str(),
        "发帖"
    );
    Ok((
        StatusCode::CREATED,
        Json(PostDto {
            id,
            title: title.to_string(),
            body: body.to_string(),
            created_at: now,
        }),
    ))
}

/// 文件列表：**只返回调用者自己的文件**（原来会把别人的列表摊出去）。
pub async fn list_files(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> AppResult<Json<Vec<FileDto>>> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::UseNetdisk)?;
    let files = repo::list_files(state.db.pool(), user.id, 100).await?;
    Ok(Json(files.iter().map(|row| file_dto(row, false)).collect()))
}

fn file_dto(row: &sc2clud_db::FileRow, deduplicated: bool) -> FileDto {
    FileDto {
        id: row.id,
        name: row.name.clone(),
        size: row.size,
        hash: row.blob_hash.clone(),
        mime: row.mime.clone(),
        deduplicated,
        download_url: format!("/api/v1/files/{}/download", row.id),
    }
}

fn invalid(msg: impl Into<String>) -> AppError {
    AppError::Domain(DomainError::InvalidInput(msg.into()))
}

// ------------------------------------------------------------ 秒传

/// 秒传声明：客户端先报 blake3，命中则直接建引用，**0 字节传输**。
///
/// 关键点：只信服务端自己的记录（`storage.stat`），绝不信客户端声明的体积。
pub async fn claim_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ClaimRequest>,
) -> AppResult<(StatusCode, Json<FileDto>)> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::UseNetdisk)?;
    let hash = BlobHash::parse(&req.hash)?;
    let name = safety::safe_file_name(&req.name)?;
    if req.size <= 0 {
        return Err(invalid("文件体积必须大于 0"));
    }
    if req.size as u64 > state.config.limits.max_upload_bytes {
        return Err(AppError::Domain(DomainError::QuotaExceeded(format!(
            "单文件上限 {} 字节",
            state.config.limits.max_upload_bytes
        ))));
    }

    let stat = state
        .storage
        .stat(&hash)
        .await?
        .ok_or_else(|| AppError::rejected("服务器上没有这份内容，请走正常上传"))?;
    if stat.size != req.size as u64 {
        return Err(AppError::rejected(format!(
            "声明体积 {} 与服务器记录 {} 不一致",
            req.size, stat.size
        )));
    }

    let mime = req
        .mime
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let now = now_unix();
    let created = repo::ensure_blob(state.db.pool(), hash.as_str(), req.size, now).await?;
    let id = repo::create_file(
        state.db.pool(),
        repo::NewFile {
            owner_id: user.id,
            blob_hash: hash.as_str(),
            name: &name,
            mime: &mime,
            size: req.size,
            now,
        },
    )
    .await?;
    repo::add_used_bytes(state.db.pool(), user.id, req.size).await?;
    state.counters.bump("upload:dedup_hits", 1);
    tracing::info!(file.id = id, blob = %hash, newly_registered = created, "秒传命中");

    Ok((
        StatusCode::CREATED,
        Json(FileDto {
            id,
            name,
            size: req.size,
            hash: hash.to_string(),
            mime,
            deduplicated: true,
            download_url: format!("/api/v1/files/{id}/download"),
        }),
    ))
}

// ------------------------------------------------------------ 上传

/// 流式上传：**字节不经过内存聚合**，边收边算 blake3，直写目标文件。
pub async fn upload_file(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(params): Query<UploadQuery>,
    headers: HeaderMap,
    body: Body,
) -> AppResult<Json<FileDto>> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::UseNetdisk)?;
    // 磁盘闸门：可用空间低于阈值就拒绝，避免把服务器写爆（507）。
    ensure_free_space(
        state.storage.available_bytes().await?,
        state.config.limits.min_free_bytes,
    )?;
    let name = safety::safe_file_name(&params.name)?;
    let declared = params.hash.as_deref().map(BlobHash::parse).transpose()?;
    let mime = params
        .mime
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let subject = client_subject(&headers, Some(peer));
    let max_upload = state.config.limits.max_upload_bytes;

    // 有 Content-Length 就先挡掉明显超限的请求，不必读完整条请求体再拒。
    if let Some(len) = content_length(&headers) {
        if len > max_upload {
            return Err(AppError::Domain(DomainError::QuotaExceeded(format!(
                "单文件上限 {max_upload} 字节"
            ))));
        }
        if let Some(user) = repo::find_user_by_id(state.db.pool(), user.id).await?
            && user.used_bytes + len as i64 > user.quota_bytes
        {
            return Err(AppError::Domain(DomainError::QuotaExceeded(format!(
                "配额不足：已用 {} 字节 / 上限 {} 字节",
                user.used_bytes, user.quota_bytes
            ))));
        }
    }

    // 并发闸门：满了立刻 429，不排队。许可在函数返回时自动释放。
    let _permit = state.upload_gate.try_acquire().ok_or_else(|| {
        AppError::Domain(DomainError::RateLimited(
            "当前上传数已达上限，请稍后重试".to_string(),
        ))
    })?;

    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(DEFAULT_QUEUE_DEPTH);
    let reader: BlobReader = Box::pin(StreamReader::new(ReceiverStream::new(rx)));
    let pump = tokio::spawn(pump_body(
        body.into_data_stream(),
        tx,
        Arc::clone(&state.upload_gate),
        subject,
        max_upload,
    ));

    let stored = state.storage.put_stream(reader, declared.as_ref()).await;
    let pumped = match pump.await {
        Ok(result) => result,
        Err(join) => Err(AppError::internal(format!("上传任务异常：{join}"))),
    };

    let outcome = match (stored, pumped) {
        (Ok(outcome), Ok(_)) => outcome,
        (Ok(_), Err(client_err)) => return Err(client_err),
        (Err(storage_err), Err(client_err)) => {
            // 客户端侧的原因（超限、请求体中断）比存储层的连锁失败更有信息量。
            let (status, _, _) = client_err.parts();
            return if status.is_client_error() {
                Err(client_err)
            } else {
                Err(storage_err.into())
            };
        }
        (Err(storage_err), Ok(_)) => return Err(storage_err.into()),
    };

    let hash = outcome.stat.hash.clone();
    let size = outcome.stat.size as i64;
    let now = now_unix();
    repo::ensure_blob(state.db.pool(), hash.as_str(), size, now).await?;
    let id = repo::create_file(
        state.db.pool(),
        repo::NewFile {
            owner_id: user.id,
            blob_hash: hash.as_str(),
            name: &name,
            mime: &mime,
            size,
            now,
        },
    )
    .await?;
    repo::add_used_bytes(state.db.pool(), user.id, size).await?;
    if outcome.deduplicated {
        state.counters.bump("upload:dedup_hits", 1);
    }
    state.counters.bump("upload:bytes", size);
    tracing::info!(
        file.id = id,
        blob = %hash,
        size,
        deduplicated = outcome.deduplicated,
        "上传完成"
    );

    Ok(Json(FileDto {
        id,
        name,
        size,
        hash: hash.to_string(),
        mime,
        deduplicated: outcome.deduplicated,
        download_url: format!("/api/v1/files/{id}/download"),
    }))
}

// ------------------------------------------------------------ 删除与下载

pub async fn delete_file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> AppResult<StatusCode> {
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::UseNetdisk)?;
    let row = repo::get_file(state.db.pool(), id)
        .await?
        .ok_or_else(|| AppError::not_found("文件不存在或已删除"))?;

    if !repo::soft_delete_file(state.db.pool(), id, user.id, now_unix()).await? {
        return Err(AppError::not_found("文件不存在或无权删除"));
    }

    // 引用计数归零才真正删盘（同一份内容可能被多个文件记录共享）。
    if let Some(blob) = repo::find_blob(state.db.pool(), &row.blob_hash).await?
        && blob.refcount <= 0
        && let Ok(hash) = BlobHash::parse(&row.blob_hash)
    {
        match state.storage.delete(&hash).await {
            Ok(()) => tracing::info!(blob = %hash, "引用归零，已删除物理内容"),
            Err(e) => tracing::warn!(blob = %hash, error = %e, "物理删除失败，留待清理任务"),
        }
    }

    state.counters.bump("file:deleted", 1);
    Ok(StatusCode::NO_CONTENT)
}

/// 下载：应用只做一次 DB 读 + 一次授权，**字节由 nginx 直出**。
///
/// 两种下发方式都满足硬约束「文件字节不经过应用进程」：
/// - `secure_link`：应用 302 到带签名 URL，nginx 自行校验签名与过期时间；
/// - `x_accel`：应用回 `X-Accel-Redirect`，nginx 从 `internal` location 直出
///   （宝塔自编译的 nginx 通常没有 secure_link 模块，这是本机的默认通道）。
pub async fn download_file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let row = repo::get_file_with_owner(state.db.pool(), id)
        .await?
        .ok_or_else(|| AppError::not_found("文件不存在或已删除"))?;
    let user = require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::UseNetdisk)?;
    if row.owner_id != user.id && !user.is_staff() {
        return Err(AppError::not_found("文件不存在或已删除"));
    }
    let hash = BlobHash::parse(&row.blob_hash)?;

    // 下载计数进内存聚合，后台批量落库（SQLite 单写者，禁止每请求 UPDATE）。
    state.counters.bump(format!("file:{}:downloads", row.id), 1);

    if state.config.download.mode == DownloadMode::XAccel {
        // 授权已在上面完成；nginx 侧的 internal location 客户端无法直接访问。
        let location = format!(
            "{}/{}",
            state.config.download.internal_prefix.trim_end_matches('/'),
            hash.relative_path()
        );
        tracing::info!(file.id = row.id, blob = %hash, location = %location, "X-Accel-Redirect 下发");
        return Ok((
            StatusCode::OK,
            [(
                header::HeaderName::from_static("x-accel-redirect"),
                location,
            )],
        )
            .into_response());
    }

    let client = client_ip(&headers, Some(peer));
    let signed = state
        .storage
        .presign_url(
            &hash,
            Duration::from_secs(state.config.download.url_ttl_secs),
            client.as_deref(),
        )
        .await?;

    let location = if signed.url.starts_with("http") {
        signed.url
    } else {
        format!(
            "{}{}",
            state.config.server.base_url.trim_end_matches('/'),
            signed.url
        )
    };
    tracing::info!(
        file.id = row.id,
        blob = %hash,
        expires_at = signed.expires_at,
        "签发下载跳转"
    );
    Ok((StatusCode::FOUND, [(header::LOCATION, location)]).into_response())
}
