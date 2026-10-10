//! HTTP 层：axum 路由 + askama 服务端渲染 + 流式上传与签名下载。
//!
//! 硬约束回顾（见 docs/TECH_STACK.md）：
//! - 文件字节不进入应用进程：上传是流式转发，下载是 302 到 nginx 直出；
//! - 应用常驻内存 ≤ 150 MB：所有缓冲都是有界常数，不随文件大小增长；
//! - 页面默认服务端渲染，前端只做局部增强。

pub mod ai;
pub mod error;
pub mod pages_admin;
pub mod pages_auth;
pub mod pages_debug;
pub mod pages_messages;
pub mod pages_posts;
pub mod pages_profile;
pub mod pages_search;
pub mod pages_settings;
pub mod pages_social;
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

/// 一条新私信事件（SSE 广播用；本进程内一对一投递，不做跨实例）。
#[derive(Clone, Debug)]
pub struct MessageEvent {
    /// 收信人 user id。
    pub to_user: i64,
    /// 发信人的 handle（收信方据此判断属于哪个会话）。
    pub from_handle: String,
    pub id: i64,
    pub body: String,
}

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
    /// 新私信广播（SSE 用）：有接收者时立刻推送，没有就是普通丢弃。
    pub events: tokio::sync::broadcast::Sender<MessageEvent>,
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
        // 256 条缓冲：够吸收一次突发；接收端跟不上时会 Lagged，前端有轮询兜底
        let (events, _) = tokio::sync::broadcast::channel(256);
        Self {
            config: Arc::new(config),
            db,
            storage,
            counters,
            upload_gate,
            demo_owner_id,
            events,
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
    // 调试页只在开关打开时**注册路由**：关着时 /debug 与不存在的路径没有区别。
    let debug = if state.config.server.debug_pages {
        Router::new().route("/debug", axum::routing::get(pages_debug::page))
    } else {
        Router::new()
    };
    let max_body = state.config.limits.max_request_body_bytes as usize;
    Router::new()
        .nest_service("/static", ServeDir::new(static_dir()))
        .merge(debug)
        .merge(routes::pages())
        .merge(routes::api_read())
        .merge(routes::api_upload())
        .fallback(routes::not_found)
        .layer(RequestBodyLimitLayer::new(max_body))
        .layer(CatchPanicLayer::new())
        .layer(middleware::from_fn(routes::access_log))
        .with_state(state)
}
