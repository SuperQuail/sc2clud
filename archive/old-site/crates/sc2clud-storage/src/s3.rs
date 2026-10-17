//! S3 兼容对象存储后端（默认不编译，见 `feature = "s3"`）。
//!
//! 目标场景：文件总量或出口流量触及单机上限时，**只切换实现，不改业务代码**。
//! 兼容 Cloudflare R2 / 阿里云 OSS / 腾讯云 COS / Garage / MinIO（都实现了 S3 SigV4）。
//!
//! 本文件目前只**固定接口形状**，让业务层从第一天起就按 trait 编程；
//! 真正实现需要补齐：SigV4 预签名、分片上传（multipart）、以及 `put_stream` 的流式 PUT。
//! 为避免在没有实际需求时引入 aws-sdk-s3 这类重量级依赖，这里保持零额外依赖。

use std::time::Duration;

use async_trait::async_trait;
use sc2clud_core::{BlobHash, Error, Result};

use crate::{BlobReader, BlobStat, PresignedUrl, PutOutcome, StorageBackend};

#[derive(Debug, Clone)]
pub struct S3Config {
    /// 形如 `https://<account>.r2.cloudflarestorage.com`。
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key_id: String,
    pub secret_access_key: String,
    /// 预签名 URL 的有效期上限由对象存储决定（R2 最长 7 天）。
    pub max_presign_ttl: Duration,
}

pub struct S3Backend {
    config: S3Config,
}

impl S3Backend {
    pub fn new(config: S3Config) -> Self {
        Self { config }
    }

    pub fn config(&self) -> &S3Config {
        &self.config
    }
}

const NOT_IMPLEMENTED: &str =
    "S3 后端尚未实现：切换存储时补 SigV4 与分片上传（见 docs/ARCHITECTURE.md §存储层）";

#[async_trait]
impl StorageBackend for S3Backend {
    fn name(&self) -> &'static str {
        "s3"
    }

    async fn put_stream(
        &self,
        _reader: BlobReader,
        _expected: Option<&BlobHash>,
    ) -> Result<PutOutcome> {
        Err(Error::Unsupported(NOT_IMPLEMENTED))
    }

    async fn get_stream(&self, _hash: &BlobHash) -> Result<BlobReader> {
        Err(Error::Unsupported(NOT_IMPLEMENTED))
    }

    async fn stat(&self, _hash: &BlobHash) -> Result<Option<BlobStat>> {
        Err(Error::Unsupported(NOT_IMPLEMENTED))
    }

    async fn delete(&self, _hash: &BlobHash) -> Result<()> {
        Err(Error::Unsupported(NOT_IMPLEMENTED))
    }

    async fn presign_url(
        &self,
        _hash: &BlobHash,
        _ttl: Duration,
        _client_ip: Option<&str>,
    ) -> Result<PresignedUrl> {
        Err(Error::Unsupported(NOT_IMPLEMENTED))
    }
}
