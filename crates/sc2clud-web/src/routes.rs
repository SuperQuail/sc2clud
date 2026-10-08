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
use sc2clud_core::{BlobHash, Error as DomainError, now_unix, safety};
use sc2clud_db::repo;
use sc2clud_storage::BlobReader;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::io::StreamReader;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::templates::{
    ClaimRequest, FileDto, FilePageTemplate, FileView, IndexTemplate, PostCreateRequest, PostDto,
    PostView, UploadQuery, format_date, human_bytes,
};
use crate::upload::{DEFAULT_QUEUE_DEPTH, pump_body};

// ------------------------------------------------------------ 路由表

/// 只读页面：给足超时的同时不至于让慢客户端占住 worker。
pub fn pages() -> Router<AppState> {
    Router::new()
        .route("/", axum::routing::get(index))
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
        .route("/api/v1/files/claim", axum::routing::post(claim_file))
        .route("/api/v1/files/{id}", axum::routing::delete(delete_file))
        .route(
            "/api/v1/files/{id}/download",
            axum::routing::get(download_file),
        )
}

/// 上传接口：**不加超时层**——慢速上传是常态，超时交给 nginx 的 client_body_timeout。
pub fn api_upload() -> Router<AppState> {
    Router::new().route("/api/v1/files", axum::routing::put(upload_file))
}

// ------------------------------------------------------------ 工具

fn wants_html(headers: &HeaderMap) -> bool {
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

pub async fn index(State(state): State<AppState>, headers: HeaderMap) -> Response {
    match build_index(&state).await {
        Ok(template) => render_template(template),
        Err(e) => e.into_page_response(wants_html(&headers)),
    }
}

async fn build_index(state: &AppState) -> AppResult<IndexTemplate<'_>> {
    let posts = repo::list_posts(state.db.pool(), 20, 0).await?;
    let total_posts = repo::count_posts(state.db.pool()).await?;
    let files = repo::list_files(state.db.pool(), state.demo_owner_id, 20).await?;
    Ok(IndexTemplate {
        site_name: &state.config.server.site_name,
        posts: posts.into_iter().map(post_view).collect(),
        files: files.iter().map(FileView::from_row).collect(),
        total_posts,
        max_upload_human: human_bytes(state.config.limits.max_upload_bytes),
    })
}

fn post_view(row: sc2clud_db::PostRow) -> PostView {
    let preview = row.body.replace('\n', " ").chars().take(120).collect();
    PostView {
        id: row.id,
        title: row.title,
        preview,
        created_at: format_date(row.created_at),
    }
}

pub async fn file_page(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    headers: HeaderMap,
) -> Response {
    match build_file_page(&state, id).await {
        Ok(template) => render_template(template),
        Err(e) => e.into_page_response(wants_html(&headers)),
    }
}

async fn build_file_page(state: &AppState, id: i64) -> AppResult<FilePageTemplate<'_>> {
    let row = repo::get_file_with_owner(state.db.pool(), id)
        .await?
        .ok_or_else(|| AppError::not_found("文件不存在或已删除"))?;
    let download_href = format!("/api/v1/files/{}/download", row.id);
    Ok(FilePageTemplate {
        site_name: &state.config.server.site_name,
        file: FileView::from_owner_row(&row),
        owner_handle: row.owner_handle.clone(),
        download_href,
    })
}

/// 兜底 404：HTML 请求给错误页，接口请求给 JSON。
pub async fn not_found(headers: HeaderMap) -> Response {
    AppError::not_found("页面或接口不存在").into_page_response(wants_html(&headers))
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
    Json(req): Json<PostCreateRequest>,
) -> AppResult<(StatusCode, Json<PostDto>)> {
    let title = req.title.trim();
    let body = req.body.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err(invalid("标题需为 1..200 字"));
    }
    if body.is_empty() || body.chars().count() > 20_000 {
        return Err(invalid("正文需为 1..20000 字"));
    }

    let now = now_unix();
    let id = repo::create_post(state.db.pool(), state.demo_owner_id, title, body, now).await?;
    state.counters.bump("post:created", 1);
    tracing::info!(post.id = id, "发帖");
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

pub async fn list_files(State(state): State<AppState>) -> AppResult<Json<Vec<FileDto>>> {
    let files = repo::list_files(state.db.pool(), state.demo_owner_id, 100).await?;
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
    Json(req): Json<ClaimRequest>,
) -> AppResult<(StatusCode, Json<FileDto>)> {
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
            owner_id: state.demo_owner_id,
            blob_hash: hash.as_str(),
            name: &name,
            mime: &mime,
            size: req.size,
            now,
        },
    )
    .await?;
    repo::add_used_bytes(state.db.pool(), state.demo_owner_id, req.size).await?;
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
        if let Some(user) = repo::find_user_by_id(state.db.pool(), state.demo_owner_id).await?
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
            owner_id: state.demo_owner_id,
            blob_hash: hash.as_str(),
            name: &name,
            mime: &mime,
            size,
            now,
        },
    )
    .await?;
    repo::add_used_bytes(state.db.pool(), state.demo_owner_id, size).await?;
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
) -> AppResult<StatusCode> {
    let row = repo::get_file(state.db.pool(), id)
        .await?
        .ok_or_else(|| AppError::not_found("文件不存在或已删除"))?;

    if !repo::soft_delete_file(state.db.pool(), id, state.demo_owner_id, now_unix()).await? {
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

/// 下载：应用只做一次 DB 读 + 一次签名，**字节由 nginx 直出**。
pub async fn download_file(
    State(state): State<AppState>,
    Path(id): Path<i64>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let row = repo::get_file_with_owner(state.db.pool(), id)
        .await?
        .ok_or_else(|| AppError::not_found("文件不存在或已删除"))?;
    let hash = BlobHash::parse(&row.blob_hash)?;
    let client = client_ip(&headers, Some(peer));
    let signed = state
        .storage
        .presign_url(
            &hash,
            Duration::from_secs(state.config.download.url_ttl_secs),
            client.as_deref(),
        )
        .await?;

    // 下载计数进内存聚合，后台批量落库（SQLite 单写者，禁止每请求 UPDATE）。
    state.counters.bump(format!("file:{}:downloads", row.id), 1);

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
