//! 图片：上传（通用插图 / 帖子配图）、读取（内容寻址 + 可见性授权）、MIME 嗅探。
//!
//! 从 routes.rs 拆出并**重写**（原处 1500+ 行、多类业务耦合；见 AGENTS §6.6 渐进重构义务）。

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router};
use bytes::Bytes;
use futures_util::StreamExt;
use sc2clud_core::auth::Permission;
use sc2clud_core::capacity::ensure_free_space;
use sc2clud_core::review::MAX_IMAGES_PER_POST;
use sc2clud_core::{BlobHash, Error as DomainError, now_unix};
use sc2clud_db::repo;
use sc2clud_storage::BlobReader;
use serde_json::json;
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tokio_util::io::StreamReader;

use crate::AppState;
use crate::error::{AppError, AppResult};
use crate::routes::{client_subject, invalid};
use crate::session;
use crate::upload::{DEFAULT_QUEUE_DEPTH, pump_body};

/// 图片路由。
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/images", axum::routing::post(upload_image))
        .route(
            "/api/v1/posts/{post_id}/images",
            axum::routing::post(upload_post_image),
        )
        .route("/img/{hash}", axum::routing::get(serve_image))
}

/// 按文件头识别图片类型（只认四种我们接受的格式）。
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

/// 入库后的图片信息。
struct Stored {
    hash: BlobHash,
    size: i64,
    mime: &'static str,
}

/// 流式把请求体存成图片（恒定内存：先判魔数，再落盘）。两个上传端点共用这一份。
async fn store_image(state: &AppState, headers: &HeaderMap, body: Body) -> AppResult<Stored> {
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
    // 判类型用掉的第一块拼回流的开头，内存占用与直接收流一致
    let body_stream: std::pin::Pin<
        Box<dyn futures_util::Stream<Item = Result<Bytes, axum::Error>> + Send>,
    > = Box::pin(futures_util::stream::iter(first).chain(stream));
    let (tx, rx) = mpsc::channel::<Result<Bytes, std::io::Error>>(DEFAULT_QUEUE_DEPTH);
    let reader: BlobReader = Box::pin(StreamReader::new(ReceiverStream::new(rx)));
    let pump = tokio::spawn(pump_body(
        body_stream,
        tx,
        Arc::clone(&state.upload_gate),
        client_subject(headers, None),
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
            // 客户端自己的错（超限/中断）优先于存储侧报错
            let (status, _, _) = client_err.parts();
            return if status.is_client_error() {
                Err(client_err)
            } else {
                Err(storage_err.into())
            };
        }
        (Err(storage_err), Ok(_)) => return Err(storage_err.into()),
    };
    Ok(Stored {
        hash: outcome.stat.hash.clone(),
        size: outcome.stat.size as i64,
        mime,
    })
}

/// 通用插图：入库但不挂到某个帖子上 —— 发帖之前也能插图，正文直接引用 /img/{hash}。
pub async fn upload_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Body,
) -> AppResult<Json<serde_json::Value>> {
    let user = crate::routes::require_user(&state, &headers).await?;
    session::guard(Some(&user), Permission::CreateDiscussion)?;
    ensure_free_space(
        state.storage.available_bytes().await?,
        state.config.limits.min_free_bytes,
    )?;
    let stored = store_image(&state, &headers, body).await?;
    let hash = stored.hash.clone();
    repo::ensure_blob(state.db.pool(), hash.as_str(), stored.size, now_unix()).await?;
    state.counters.bump("image", 1);
    Ok(Json(json!({
        "hash": hash.to_string(),
        "url": format!("/img/{hash}"),
        "size": stored.size,
        "mime": stored.mime,
    })))
}

/// 帖子配图：登记进 post_images（作者本人、主帖上限 MAX_IMAGES_PER_POST）。
pub async fn upload_post_image(
    State(state): State<AppState>,
    Path(post_id): Path<i64>,
    headers: HeaderMap,
    body: Body,
) -> AppResult<Json<serde_json::Value>> {
    let user = crate::routes::require_user(&state, &headers).await?;
    // 帖子配图不是网盘：任何已激活用户都能给自己的帖子加图
    session::guard(Some(&user), Permission::CreateDiscussion)?;
    ensure_free_space(
        state.storage.available_bytes().await?,
        state.config.limits.min_free_bytes,
    )?;
    let post = repo::get_post_for(state.db.pool(), post_id, Some(user.id), user.is_staff())
        .await?
        .ok_or_else(|| AppError::not_found("帖子不存在或不可见"))?;
    if post.author_id != user.id {
        return Err(AppError::Domain(DomainError::Forbidden(
            "只能给自己的帖子加图".to_string(),
        )));
    }
    let count = repo::count_post_images(state.db.pool(), post_id).await?;
    if count >= MAX_IMAGES_PER_POST as i64 {
        return Err(invalid(format!("主帖最多 {MAX_IMAGES_PER_POST} 张图")));
    }
    let stored = store_image(&state, &headers, body).await?;
    let hash = stored.hash.clone();
    repo::ensure_blob(state.db.pool(), hash.as_str(), stored.size, now_unix()).await?;
    let image_id = repo::add_post_image(
        state.db.pool(),
        post_id,
        count,
        hash.as_str(),
        stored.size,
        stored.mime,
        now_unix(),
    )
    .await?;
    state.counters.bump("post:image", 1);
    Ok(Json(json!({
        "id": image_id,
        "hash": hash.to_string(),
        "url": format!("/img/{hash}"),
        "size": stored.size,
        "mime": stored.mime,
        "count": count + 1,
    })))
}

/// 图片读取：内容寻址 → 长缓存。
///
/// 授权：默认公开（hash 不可猜，与 /avatar/{hash} 同一套判断）；
/// `blobs.private = 1` 时只允许所有者与管理员读取（为将来可能出现的保密图片预留）。
pub async fn serve_image(
    State(state): State<AppState>,
    Path(raw_hash): Path<String>,
    headers: HeaderMap,
) -> AppResult<Response> {
    let hash = BlobHash::parse(&raw_hash)?;
    if state.storage.stat(&hash).await?.is_none() {
        return Err(AppError::not_found("图片不存在"));
    }
    let viewer = session::current_user(&state, &headers).await.ok().flatten();
    let allowed = match repo::blob_visibility(state.db.pool(), hash.as_str()).await? {
        Some((owner, true)) => viewer
            .as_ref()
            .is_some_and(|user| user.is_staff() || Some(user.id) == owner),
        _ => true,
    };
    if !allowed {
        return Err(AppError::not_found("图片不存在"));
    }
    // 登记过的配图用登记表里的 mime；其余（发帖前上传、收款码等）从文件头嗅探
    let mime = match repo::find_post_image_by_hash(state.db.pool(), hash.as_str()).await? {
        Some(image) => image.mime.clone(),
        None => {
            let mut reader = state.storage.get_stream(&hash).await?;
            let mut head = vec![0u8; 32];
            let read = tokio::io::AsyncReadExt::read(&mut reader, &mut head)
                .await
                .unwrap_or(0);
            head.truncate(read);
            sniff_image_mime(&head)
                .ok_or_else(|| AppError::not_found("图片不存在"))?
                .to_string()
        }
    };
    if !state.config.server.serve_blobs_locally {
        // 按真实类型选内部目录：nginx 每个目录一个 default_type，浏览器才拿得到 image/* 而不是 octet-stream
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
            axum::http::StatusCode::OK,
            [(
                header::HeaderName::from_static("x-accel-redirect"),
                location.as_str(),
            )],
        )
            .into_response());
    }
    // 本地开发（serve_blobs_locally）：字节由应用补齐，方便本机与截图
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
    Ok(response)
}
