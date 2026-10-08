//! HTTP 层：axum 路由 + askama 服务端渲染 + 流式上传与签名下载。
//!
//! 硬约束回顾（见 docs/TECH_STACK.md）：
//! - 文件字节不进入应用进程：上传是流式转发，下载是 302 到 nginx 直出；
//! - 应用常驻内存 ≤ 150 MB：所有缓冲都是有界常数，不随文件大小增长；
//! - 页面默认服务端渲染，前端只做局部增强。

pub mod error;
pub mod pages_auth;
pub mod routes;
pub mod session;
pub mod templates;
pub mod upload;

use std::sync::Arc;

use axum::{Router, middleware};
use sc2clud_core::config::Config;
use sc2clud_core::counter::Counters;
use sc2clud_db::Db;
use sc2clud_storage::SharedStorage;
use tower_http::catch_panic::CatchPanicLayer;
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::services::ServeDir;

use crate::upload::UploadGate;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: Db,
    pub storage: SharedStorage,
    /// 写热点聚合缓冲（浏览数、下载数），由后台任务批量落库。
    pub counters: Arc<Counters>,
    pub upload_gate: Arc<UploadGate>,
    /// 脚手架阶段的归属用户 id（见 `repo::ensure_bootstrap_user`）。
    pub demo_owner_id: i64,
}

impl AppState {
    pub fn new(
        config: Config,
        db: Db,
        storage: SharedStorage,
        counters: Arc<Counters>,
        demo_owner_id: i64,
    ) -> Self {
        let upload_gate = UploadGate::new(
            config.limits.max_concurrent_uploads,
            config.limits.upload_bytes_per_sec,
            // 突发额度给到 1 秒的速率：首块不必等待，之后的块按速率节流。
            config.limits.upload_bytes_per_sec.max(64 * 1024),
        );
        Self {
            config: Arc::new(config),
            db,
            storage,
            counters,
            upload_gate,
            demo_owner_id,
        }
    }
}

/// 开发期静态资源目录。
///
/// 生产环境由 nginx 直出 `/static`（brotli 预压缩 + sendfile 零拷贝），
/// 这里的映射只是让 `cargo run` 单跑时页面也能用；路径在编译期固化，
/// 因此发布构建不会去猜运行目录。
fn static_dir() -> std::path::PathBuf {
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("static")
}

/// 组装完整路由。
///
/// 层次顺序（外 → 内）：访问日志 → panic 兜底 → 请求体上限 → 路由。
/// 请求体上限与上传体积上限同源（`limits.max_request_body_bytes`），避免两处配置打架。
pub fn router(state: AppState) -> Router {
    let max_body = state.config.limits.max_request_body_bytes as usize;
    Router::new()
        .nest_service("/static", ServeDir::new(static_dir()))
        .merge(routes::pages())
        .merge(routes::api_read())
        .merge(routes::api_upload())
        .fallback(routes::not_found)
        .layer(RequestBodyLimitLayer::new(max_body))
        .layer(CatchPanicLayer::new())
        .layer(middleware::from_fn(routes::access_log))
        .with_state(state)
}
