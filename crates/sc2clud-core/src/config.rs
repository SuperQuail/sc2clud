//! 配置装载。
//!
//! 布局沿用既有项目 HSCL 的「同级 data 目录」约定：
//!
//! - 配置文件：`<exe 同级>/sc2clud.toml`（可用 `SC2CLUD_CONFIG` 覆盖）
//! - 数据目录：`<exe 同级>/data`（可用 `SC2CLUD_DATA_DIR` 覆盖）
//! - 日志目录：`<data>/logs`，blob 目录：`<data>/blobs`，数据库：`<data>/sc2clud.sqlite3`
//!
//! 优先级：内置默认值 < 配置文件 < 环境变量。
//! 配置文件使用 `deny_unknown_fields`：写错键名会直接报错，而不是被静默忽略。

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::error::{Error, Result};

/// 密钥占位符：出现在配置里一律视为未配置。
pub const SECRET_PLACEHOLDER: &str = "change-me";

/// 单文件上限的默认值：本地存储 50 MB（对象存储后端可放宽到 2 GB）。
pub const DEFAULT_MAX_UPLOAD_BYTES: u64 = 50 * 1024 * 1024;

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub server: ServerConfig,
    pub paths: PathsConfig,
    pub secret: SecretConfig,
    pub limits: LimitsConfig,
    pub download: DownloadConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    /// 只监听回环地址：对外由 nginx 终止 TLS 并转发。
    pub bind: String,
    /// 对外可访问的站点根（用于拼绝对下载地址与日志）。
    pub base_url: String,
    /// 受保护 blob 的公开前缀；nginx 侧是 `internal` location。
    pub download_prefix: String,
    /// 站点名（页面标题用）。
    pub site_name: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: "127.0.0.1:8080".to_string(),
            base_url: "http://127.0.0.1:8080".to_string(),
            download_prefix: "/dl".to_string(),
            site_name: "SC2clud".to_string(),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PathsConfig {
    pub data_dir: PathBuf,
    /// 默认 `<data_dir>/blobs`。
    pub blobs_dir: Option<PathBuf>,
    /// 默认 `<data_dir>/logs`。
    pub log_dir: Option<PathBuf>,
}

impl Default for PathsConfig {
    fn default() -> Self {
        Self {
            data_dir: exe_dir().join("data"),
            blobs_dir: None,
            log_dir: None,
        }
    }
}

impl PathsConfig {
    /// blob 根目录（内容寻址存储的根）。
    pub fn blobs_dir(&self) -> PathBuf {
        self.blobs_dir
            .clone()
            .unwrap_or_else(|| self.data_dir.join("blobs"))
    }

    /// 上传中转目录（与最终 blob 同盘，保证 rename 是原子操作）。
    pub fn temp_dir(&self) -> PathBuf {
        self.blobs_dir().join("tmp")
    }

    pub fn log_dir(&self) -> PathBuf {
        self.log_dir
            .clone()
            .unwrap_or_else(|| self.data_dir.join("logs"))
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("sc2clud.sqlite3")
    }

    /// 启动时创建数据目录；系统级目录（如 `/srv`）由部署脚本负责创建与授权。
    pub fn ensure_dirs(&self) -> Result<()> {
        for dir in [
            self.data_dir.clone(),
            self.blobs_dir(),
            self.temp_dir(),
            self.log_dir(),
        ] {
            std::fs::create_dir_all(&dir)
                .map_err(|e| Error::Config(format!("无法创建目录 {}：{e}", dir.display())))?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SecretConfig {
    /// 下载签名密钥：**必须**与 nginx `secure_link_md5` 表达式里的密钥逐字节相同。
    pub download_secret: String,
}

impl SecretConfig {
    pub fn is_configured(&self) -> bool {
        let s = self.download_secret.trim();
        !s.is_empty() && s != SECRET_PLACEHOLDER
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LimitsConfig {
    /// 单文件上限。
    pub max_upload_bytes: u64,
    /// 单用户上传限速（字节/秒）。
    pub upload_bytes_per_sec: u64,
    /// 全站并发上传上限（2 核上的安全值）。
    pub max_concurrent_uploads: u32,
    /// 流式缓冲大小：恒定内存的关键常数，禁止调大到 MB 级。
    pub stream_chunk_bytes: usize,
    /// 请求体上限，应略大于 `max_upload_bytes`。
    pub max_request_body_bytes: u64,
}

impl Default for LimitsConfig {
    fn default() -> Self {
        Self {
            max_upload_bytes: DEFAULT_MAX_UPLOAD_BYTES,
            upload_bytes_per_sec: 256 * 1024,
            max_concurrent_uploads: 5,
            stream_chunk_bytes: crate::STREAM_CHUNK_BYTES,
            max_request_body_bytes: DEFAULT_MAX_UPLOAD_BYTES + 2 * 1024 * 1024,
        }
    }
}

/// 下载下发方式。两种都满足硬约束「文件字节不经过应用进程」，区别只在谁来校验授权。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadMode {
    /// 应用 302 到带签名的 URL，由 nginx `secure_link` 自行校验签名与过期时间。
    /// 需要 nginx 编译了 `--with-http_secure_link_module`（官方包有，宝塔自编译常常没有）。
    #[default]
    SecureLink,
    /// 应用返回 `X-Accel-Redirect`，nginx 从 `internal` location 直接 sendfile。
    /// 任何 nginx 都支持；授权由应用在请求时判定。
    XAccel,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DownloadConfig {
    /// 下发方式；部署脚本会按 nginx 是否带 secure_link 模块自动写入。
    pub mode: DownloadMode,
    /// 签名 URL 的 TTL（秒）：短 TTL 抗重放与盗链。
    pub url_ttl_secs: u64,
    /// 是否把客户端 IP 绑进签名；必须与 nginx 表达式是否含 `$remote_addr` 一致。
    pub bind_client_ip: bool,
    /// `x_accel` 模式下 nginx 内部 location 的前缀（对应 `internal` + `alias`）。
    pub internal_prefix: String,
}

impl Default for DownloadConfig {
    fn default() -> Self {
        Self {
            mode: DownloadMode::default(),
            url_ttl_secs: 300,
            bind_client_ip: true,
            internal_prefix: "/_blob".to_string(),
        }
    }
}

/// 可执行文件所在目录；取不到时退回当前工作目录。
fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

impl Config {
    /// 默认配置文件路径：`<exe 同级>/sc2clud.toml`，可用 `SC2CLUD_CONFIG` 覆盖。
    pub fn default_config_path() -> PathBuf {
        if let Some(p) = std::env::var_os("SC2CLUD_CONFIG") {
            return PathBuf::from(p);
        }
        exe_dir().join("sc2clud.toml")
    }

    /// 装载并自检：默认值 <- 配置文件 <- 环境变量。
    pub fn load() -> Result<Self> {
        let path = Self::default_config_path();
        let mut cfg = Self::load_from(Some(&path))?;
        cfg.apply_env();
        cfg.validate()?;
        Ok(cfg)
    }

    /// 只从文件装载（不读环境变量、不校验），便于测试与 `config check` 子命令。
    pub fn load_from(path: Option<&Path>) -> Result<Self> {
        let Some(path) = path else {
            return Ok(Self::default());
        };
        match std::fs::read_to_string(path) {
            Ok(text) => toml::from_str(&text)
                .map_err(|e| Error::Config(format!("解析 {} 失败：{e}", path.display()))),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(Error::Config(format!("读取 {} 失败：{e}", path.display()))),
        }
    }

    /// 环境变量覆盖：部署时把密钥放在 systemd 的 `EnvironmentFile` 里，而不是配置文件。
    pub fn apply_env(&mut self) {
        if let Some(v) = env_var("SC2CLUD_BIND") {
            self.server.bind = v;
        }
        if let Some(v) = env_var("SC2CLUD_BASE_URL") {
            self.server.base_url = v;
        }
        if let Some(v) = env_var("SC2CLUD_DOWNLOAD_PREFIX") {
            self.server.download_prefix = v;
        }
        if let Some(v) = env_var("SC2CLUD_DATA_DIR") {
            self.paths.data_dir = PathBuf::from(v);
        }
        if let Some(v) = env_var("SC2CLUD_DOWNLOAD_SECRET") {
            self.secret.download_secret = v;
        }
        if let Some(v) = env_var("SC2CLUD_URL_TTL_SECS").and_then(|s| s.parse().ok()) {
            self.download.url_ttl_secs = v;
        }
        // 部署脚本按 nginx 能力写入：secure_link / x_accel
        if let Some(v) = env_var("SC2CLUD_DOWNLOAD_MODE") {
            self.download.mode = match v.to_ascii_lowercase().as_str() {
                "secure_link" => DownloadMode::SecureLink,
                "x_accel" => DownloadMode::XAccel,
                other => {
                    tracing::warn!(value = other, "未知的 SC2CLUD_DOWNLOAD_MODE，已忽略");
                    self.download.mode
                }
            };
        }
        if let Some(v) = env_var("SC2CLUD_INTERNAL_PREFIX") {
            self.download.internal_prefix = v;
        }
        if let Some(v) = env_var("SC2CLUD_MAX_UPLOAD_BYTES").and_then(|s| s.parse().ok()) {
            self.limits.max_upload_bytes = v;
        }
    }

    pub fn bind_addr(&self) -> Result<SocketAddr> {
        self.server
            .bind
            .parse()
            .map_err(|e| Error::Config(format!("监听地址非法 {:?}：{e}", self.server.bind)))
    }

    /// 启动前自检：宁可起不来，也不要带着不安全的默认值对外服务。
    pub fn validate(&self) -> Result<()> {
        if !self.secret.is_configured() {
            return Err(Error::Config(
                "下载签名密钥未配置：请设置 SC2CLUD_DOWNLOAD_SECRET（openssl rand -hex 32），\
                 并保证与 nginx secure_link_md5 表达式中的密钥完全一致"
                    .to_string(),
            ));
        }
        self.bind_addr()?;
        let l = &self.limits;
        if l.max_upload_bytes == 0 || l.max_upload_bytes > 2 * 1024 * 1024 * 1024 {
            return Err(Error::Config(format!(
                "max_upload_bytes 越界：{}",
                l.max_upload_bytes
            )));
        }
        if l.max_request_body_bytes < l.max_upload_bytes {
            return Err(Error::Config(
                "max_request_body_bytes 不能小于 max_upload_bytes".to_string(),
            ));
        }
        if l.upload_bytes_per_sec == 0 || l.max_concurrent_uploads == 0 {
            return Err(Error::Config("上传限速与并发上限必须大于 0".to_string()));
        }
        if !(4 * 1024..=4 * 1024 * 1024).contains(&l.stream_chunk_bytes) {
            return Err(Error::Config(format!(
                "stream_chunk_bytes 应在 4 KiB..4 MiB 之间（当前 {}）",
                l.stream_chunk_bytes
            )));
        }
        if !(10..=86_400).contains(&self.download.url_ttl_secs) {
            return Err(Error::Config(format!(
                "download.url_ttl_secs 应在 10..86400 秒之间（当前 {}）",
                self.download.url_ttl_secs
            )));
        }
        let internal = &self.download.internal_prefix;
        if !internal.starts_with('/') || internal.ends_with('/') || internal.len() < 2 {
            return Err(Error::Config(format!(
                "download.internal_prefix 必须形如 /_blob（当前 {internal:?}）"
            )));
        }
        let prefix = &self.server.download_prefix;
        if !prefix.starts_with('/') || prefix.ends_with('/') || prefix.len() < 2 {
            return Err(Error::Config(format!(
                "download_prefix 必须形如 /dl（当前 {prefix:?}）"
            )));
        }
        Ok(())
    }
}

/// 读取一个非空环境变量（空白视为未设置）。
fn env_var(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane() {
        let cfg = Config::default();
        assert_eq!(cfg.server.bind, "127.0.0.1:8080");
        assert_eq!(cfg.limits.max_upload_bytes, 50 * 1024 * 1024);
        assert_eq!(cfg.limits.upload_bytes_per_sec, 256 * 1024);
        assert_eq!(cfg.limits.max_concurrent_uploads, 5);
        assert_eq!(cfg.limits.stream_chunk_bytes, crate::STREAM_CHUNK_BYTES);
        assert!(cfg.download.bind_client_ip);
        assert_eq!(cfg.download.mode, DownloadMode::SecureLink);
        assert_eq!(cfg.download.internal_prefix, "/_blob");
        assert!(!cfg.secret.is_configured(), "默认密钥必须是未配置状态");
        assert!(cfg.bind_addr().is_ok());
    }

    #[test]
    fn partial_toml_keeps_other_defaults() {
        let cfg: Config = toml::from_str("[server]\nbind = \"127.0.0.1:9000\"\n").expect("ok");
        assert_eq!(cfg.server.bind, "127.0.0.1:9000");
        assert_eq!(cfg.server.download_prefix, "/dl");
        assert_eq!(cfg.limits.max_upload_bytes, DEFAULT_MAX_UPLOAD_BYTES);
    }

    #[test]
    fn unknown_key_is_rejected() {
        let err = toml::from_str::<Config>("[server]\nprot = 1\n").unwrap_err();
        assert!(err.to_string().contains("prot"), "报错应指出键名：{err}");
    }

    #[test]
    fn derived_paths_follow_data_dir() {
        let cfg: Config =
            toml::from_str("[paths]\ndata_dir = \"/srv/sc2clud/data\"\n").expect("ok");
        assert!(
            cfg.paths.blobs_dir().ends_with("data/blobs")
                || cfg.paths.blobs_dir().ends_with("data\\blobs")
        );
        assert!(
            cfg.paths.temp_dir().ends_with("blobs/tmp")
                || cfg.paths.temp_dir().ends_with("blobs\\tmp")
        );
        assert!(
            cfg.paths
                .db_path()
                .to_string_lossy()
                .contains("sc2clud.sqlite3")
        );
    }

    #[test]
    fn validate_requires_secret() {
        let cfg = Config::default();
        let err = cfg.validate().expect_err("缺密钥必须拒绝启动");
        assert!(err.to_string().contains("SC2CLUD_DOWNLOAD_SECRET"), "{err}");

        let mut ok = Config::default();
        ok.secret.download_secret = "real-secret".to_string();
        ok.validate().expect("配好密钥后应通过");
    }

    #[test]
    fn validate_rejects_placeholder_and_bad_ranges() {
        let mut cfg = Config::default();
        cfg.secret.download_secret = SECRET_PLACEHOLDER.to_string();
        assert!(cfg.validate().is_err(), "占位密钥必须判为未配置");

        cfg.secret.download_secret = "ok".to_string();
        cfg.download.url_ttl_secs = 5;
        assert!(cfg.validate().is_err());
        cfg.download.url_ttl_secs = 300;
        cfg.server.download_prefix = "dl/".to_string();
        assert!(cfg.validate().is_err());
        cfg.server.download_prefix = "/dl".to_string();
        cfg.limits.stream_chunk_bytes = 8 * 1024 * 1024;
        assert!(cfg.validate().is_err());
        cfg.limits.stream_chunk_bytes = crate::STREAM_CHUNK_BYTES;
        cfg.download.internal_prefix = "_blob".to_string();
        assert!(cfg.validate().is_err(), "内部前缀必须以 / 开头");
        cfg.download.internal_prefix = "/_blob".to_string();
        cfg.validate().expect("修正后应通过");
    }

    #[test]
    fn missing_file_falls_back_to_defaults() {
        let cfg = Config::load_from(Some(Path::new("definitely-not-here.toml"))).expect("ok");
        assert_eq!(cfg.server.bind, "127.0.0.1:8080");
        let cfg = Config::load_from(None).expect("ok");
        assert_eq!(cfg.server.bind, "127.0.0.1:8080");
    }

    #[test]
    fn env_overrides_win() {
        // 2024 edition 下 set_var 是 unsafe（多线程环境不安全），单测里独占进程可接受。
        unsafe {
            std::env::set_var("SC2CLUD_DOWNLOAD_SECRET", "env-secret");
            std::env::set_var("SC2CLUD_DATA_DIR", "/tmp/sc2clud-test");
            std::env::set_var("SC2CLUD_BIND", "127.0.0.1:9999");
        }
        let mut cfg = Config::default();
        cfg.apply_env();
        unsafe {
            std::env::remove_var("SC2CLUD_DOWNLOAD_SECRET");
            std::env::remove_var("SC2CLUD_DATA_DIR");
            std::env::remove_var("SC2CLUD_BIND");
        }
        assert_eq!(cfg.secret.download_secret, "env-secret");
        assert!(cfg.secret.is_configured());
        assert_eq!(cfg.paths.data_dir, PathBuf::from("/tmp/sc2clud-test"));
        assert_eq!(cfg.server.bind, "127.0.0.1:9999");
    }
}
