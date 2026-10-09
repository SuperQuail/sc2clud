//! SC2clud 可执行入口。
//!
//! 子命令：
//!
//! - `sc2clud serve`（默认）：启动 HTTP 服务；
//! - `sc2clud check`：只做配置与依赖自检（部署脚本与 CI 用），不起监听；
//! - `sc2clud version` / `sc2clud help`。
//!
//! 刻意不引 clap：只有三个子命令，标准库够用，少一个编译期依赖。

#![deny(unsafe_code)]

use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use sc2clud_core::config::Config;
use sc2clud_core::counter::{Counters, merge_deltas};
use sc2clud_core::sign::DownloadSigner;
use sc2clud_db::{Db, repo};
use sc2clud_storage::{LocalFs, SharedStorage};
use sc2clud_web::{AppState, router};
use tokio::net::TcpListener;

/// 计数聚合的刷盘间隔：写热点批量落库（SQLite 单写者，禁止每请求 UPDATE）。
const COUNTER_FLUSH_INTERVAL: Duration = Duration::from_secs(10);

/// 刷盘失败后的重试缓冲上限（键数）；超过就丢弃并留痕，避免内存无限增长。
const COUNTER_RETRY_LIMIT: usize = 10_000;

#[tokio::main]
async fn main() -> Result<()> {
    let command = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "serve".to_string());
    match command.as_str() {
        "serve" | "run" => serve().await,
        "check" => check().await,
        "set-password" => set_password().await,
        "create-admin" => create_admin().await,
        "version" | "-V" | "--version" => {
            println!("sc2clud {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        "help" | "-h" | "--help" => {
            print_help();
            Ok(())
        }
        other => {
            eprintln!("未知子命令：{other}\n");
            print_help();
            std::process::exit(2);
        }
    }
}

fn print_help() {
    println!(
        "sc2clud {}\n\
         用法：\n\
           sc2clud serve     启动 HTTP 服务（默认）\n\
           sc2clud check     配置与依赖自检，不监听端口\n\
           sc2clud set-password <用户名> <新密码>   重置密码（忘记管理员密码时用）\n\
sc2clud create-admin <登录名> <显示名> <密码>   创建/提升超级管理员\n\
           sc2clud version   打印版本\n\n\
         配置：<exe 同级>/sc2clud.toml，环境变量优先（见 .env.example）",
        env!("CARGO_PKG_VERSION")
    );
}

/// 启动前的自检：配置合法、目录可写、数据库可迁移、blob 根可用。
async fn check() -> Result<()> {
    let config = Config::load().context("装载配置失败")?;
    config.paths.ensure_dirs().context("创建数据目录失败")?;

    let db_path = config.paths.db_path();
    let db = Db::connect(&db_path).await.context("打开数据库失败")?;
    db.migrate().await.context("执行迁移失败")?;
    db.ping().await.context("数据库探活失败")?;

    let signer = DownloadSigner::new(
        config.secret.download_secret.clone(),
        config.download.bind_client_ip,
    );
    let storage: SharedStorage = Arc::new(
        LocalFs::new(
            config.paths.blobs_dir(),
            signer,
            config.server.download_prefix.clone(),
        )
        .with_chunk_bytes(config.limits.stream_chunk_bytes),
    );
    storage.health().await.context("存储根目录不可用")?;

    println!("配置检查通过：");
    println!("  监听        {}", config.server.bind);
    println!("  站点根      {}", config.server.base_url);
    println!("  数据目录    {}", config.paths.data_dir.display());
    println!("  blob 根     {}", config.paths.blobs_dir().display());
    println!("  数据库      {}", db_path.display());
    println!("  存储后端    {}", storage.name());
    println!("  单文件上限  {} 字节", config.limits.max_upload_bytes);
    println!(
        "  上传限速    {} 字节/秒",
        config.limits.upload_bytes_per_sec
    );
    println!("  并发上传    {}", config.limits.max_concurrent_uploads);
    println!("  流式缓冲    {} 字节", config.limits.stream_chunk_bytes);
    println!("  下载 TTL    {} 秒", config.download.url_ttl_secs);
    db.close().await;
    Ok(())
}

/// 重置某个账号的密码，并确保它处于激活状态。
///
/// 创建或提升一个**超级管理员**账号（幂等）：
/// 不存在就建，已存在就提升为 super、激活并改显示名与密码。
async fn create_admin() -> Result<()> {
    let mut args = std::env::args().skip(2);
    let usage = "用法：sc2clud create-admin <登录名> <显示名> <密码>";
    let handle = args.next().context(usage)?;
    let display_name = args.next().context(usage)?;
    let password = args.next().context(usage)?;

    let handle =
        sc2clud_core::auth::validate_handle(&handle).map_err(|e| anyhow::anyhow!("{e}"))?;
    let display_name = sc2clud_core::auth::validate_display_name(&display_name)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    // validate_password 只做校验（返回 ()），密码按原样使用。
    sc2clud_core::auth::validate_password(&password).map_err(|e| anyhow::anyhow!("{e}"))?;

    let config = Config::load().context("装载配置失败")?;
    config.paths.ensure_dirs().context("创建数据目录失败")?;
    let db = Db::connect(&config.paths.db_path())
        .await
        .context("打开数据库失败")?;
    db.migrate().await.context("执行迁移失败")?;

    let now = sc2clud_core::now_unix();
    let user_id = repo::ensure_super_admin(db.pool(), &handle, 1 << 30, now)
        .await
        .context("创建管理员失败")?;
    let hash = sc2clud_core::auth::hash_password(&password).map_err(|e| anyhow::anyhow!("{e}"))?;
    repo::set_user_password(db.pool(), user_id, &hash)
        .await
        .context("写入密码失败")?;
    repo::set_display_name(db.pool(), user_id, &display_name)
        .await
        .context("写入显示名失败")?;
    repo::record_audit(
        db.pool(),
        Some(user_id),
        "user.create_admin",
        Some(&format!("user:{user_id}")),
        Some("命令行创建/提升超级管理员"),
        now,
    )
    .await
    .context("写审计日志失败")?;

    println!("超级管理员就绪：{handle}（显示名 {display_name}，id={user_id}）");
    Ok(())
}

/// 这是**运维工具**：忘记管理员密码时用，需要在服务器上（有数据目录权限）执行。
async fn set_password() -> Result<()> {
    let mut args = std::env::args().skip(2);
    let usage = "用法：sc2clud set-password <用户名> <新密码>";
    let handle = args.next().context(usage)?;
    let password = args.next().context(usage)?;

    let config = Config::load().context("装载配置失败")?;
    config.paths.ensure_dirs().context("创建数据目录失败")?;
    let db = Db::connect(&config.paths.db_path())
        .await
        .context("打开数据库失败")?;
    db.migrate().await.context("执行迁移失败")?;

    let Some(user) = repo::find_user_by_handle(db.pool(), &handle)
        .await
        .context("查询用户失败")?
    else {
        anyhow::bail!("找不到用户名 {handle}");
    };
    let hash = sc2clud_core::auth::hash_password(&password).map_err(|e| anyhow::anyhow!("{e}"))?;
    repo::set_user_password(db.pool(), user.id, &hash)
        .await
        .context("写入密码失败")?;

    // 能登录才有意义：顺手激活（幂等）。
    let now = sc2clud_core::now_unix();
    let _ = repo::set_user_activated(db.pool(), user.id, true, user.id, now).await;
    repo::record_audit(
        db.pool(),
        None,
        "user.set_password",
        Some(&format!("user:{}", user.id)),
        Some("命令行重置密码"),
        now,
    )
    .await
    .ok();

    println!("已重置 {handle} 的密码，并确保账号处于激活状态");
    db.close().await;
    Ok(())
}

/// 启动 HTTP 服务。
async fn serve() -> Result<()> {
    let config = Config::load().context("装载配置失败")?;
    config.paths.ensure_dirs().context("创建数据目录失败")?;

    // 日志守卫必须活到进程结束：提前 drop 会丢掉最后一批缓冲日志。
    let _log_guard = init_tracing(&config).context("初始化日志失败")?;

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        site = %config.server.site_name,
        bind = %config.server.bind,
        data_dir = %config.paths.data_dir.display(),
        "启动 SC2clud"
    );

    let db = Db::connect(&config.paths.db_path())
        .await
        .context("打开数据库失败")?;
    db.migrate().await.context("执行迁移失败")?;

    // 统一域名管理：站点根域名自动登记，链接解析/以后发信都从这里取名单
    if let Some(domain) = sc2clud_core::community::normalize_domain(&config.server.base_url) {
        let _ = sc2clud_db::repo::add_site_domain(
            db.pool(),
            &domain,
            "站点根（自动登记）",
            sc2clud_core::now_unix(),
        )
        .await;
    }

    let now = sc2clud_core::now_unix();
    // 脚手架阶段的归属用户：接入登录后由会话解析替换（见 repo::ensure_bootstrap_user）。
    let owner_id = repo::ensure_super_admin(db.pool(), "demo", 1 << 30, now)
        .await
        .context("准备引导管理员失败")?;

    let signer = DownloadSigner::new(
        config.secret.download_secret.clone(),
        config.download.bind_client_ip,
    );
    let storage: SharedStorage = Arc::new(
        LocalFs::new(
            config.paths.blobs_dir(),
            signer,
            config.server.download_prefix.clone(),
        )
        .with_chunk_bytes(config.limits.stream_chunk_bytes),
    );
    tracing::info!(
        backend = storage.name(),
        root = %config.paths.blobs_dir().display(),
        "存储后端就绪"
    );

    let counters = Arc::new(Counters::new());
    spawn_counter_flush(db.clone(), Arc::clone(&counters));

    let state = AppState::new(
        config.clone(),
        db.clone(),
        storage,
        Arc::clone(&counters),
        owner_id,
    );
    let app = router(state);

    let addr = config.bind_addr()?;
    let listener = TcpListener::bind(addr)
        .await
        .with_context(|| format!("监听 {addr} 失败"))?;
    tracing::info!(%addr, "开始监听（只监听回环，TLS 与限流由 nginx 承担）");

    let service = app.into_make_service_with_connect_info::<std::net::SocketAddr>();
    axum::serve(listener, service)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .context("HTTP 服务异常退出")?;

    // 收尾：把内存里剩余的计数增量刷一次，避免丢在进程退出里。
    let drained = counters.drain();
    if !drained.is_empty() {
        match repo::flush_counters(db.pool(), &drained).await {
            Ok(()) => tracing::info!(keys = drained.len(), "退出前计数已落库"),
            Err(e) => tracing::error!(error = %e, "退出前刷盘失败"),
        }
    }
    db.close().await;
    tracing::info!("已优雅退出");
    Ok(())
}

/// 初始化日志：stdout 给人看，当日文件给机器看。
///
/// 用 `tracing_appender::non_blocking`：写入是有界通道 + 后台线程批量刷盘，
/// 请求路径里绝不会因为日志而 fsync。
fn init_tracing(config: &Config) -> Result<tracing_appender::non_blocking::WorkerGuard> {
    use tracing_subscriber::EnvFilter;
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;

    let log_dir = config.paths.log_dir();
    std::fs::create_dir_all(&log_dir)
        .with_context(|| format!("创建日志目录 {} 失败", log_dir.display()))?;

    let appender = tracing_appender::rolling::daily(&log_dir, "sc2clud.log");
    let (file_writer, guard) = tracing_appender::non_blocking(appender);

    let filter = EnvFilter::try_from_env("SC2CLUD_LOG").unwrap_or_else(|_| EnvFilter::new("info"));
    let stdout_layer = tracing_subscriber::fmt::layer().with_target(false);
    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(file_writer)
        .with_ansi(false);

    tracing_subscriber::registry()
        .with(filter)
        .with(stdout_layer)
        .with(file_layer)
        .init();

    Ok(guard)
}

/// 计数刷盘任务：把内存聚合的写热点批量落库。
fn spawn_counter_flush(db: Db, counters: Arc<Counters>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(COUNTER_FLUSH_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut retry: Vec<(String, i64)> = Vec::new();

        loop {
            ticker.tick().await;
            let mut batch = counters.drain();
            if !retry.is_empty() {
                batch.append(&mut retry);
            }
            if batch.is_empty() {
                continue;
            }

            let merged = merge_deltas(batch);
            match repo::flush_counters(db.pool(), &merged).await {
                Ok(()) => tracing::debug!(keys = merged.len(), "计数已落库"),
                Err(e) => {
                    tracing::error!(error = %e, pending = merged.len(), "计数落库失败，转入重试缓冲");
                    retry = merged;
                    if retry.len() > COUNTER_RETRY_LIMIT {
                        tracing::error!(dropped = retry.len(), "重试缓冲超过上限，丢弃一批计数");
                        retry.clear();
                    }
                }
            }
        }
    });
}

/// 优雅停机：Ctrl-C 或 SIGTERM（systemd 停止时发的就是 SIGTERM）。
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(e) => tracing::warn!(error = %e, "无法注册 SIGTERM 处理器"),
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("收到退出信号，开始优雅停机");
}
