//! 存储后端抽象。
//!
//! 硬性约束：**任何文件字节都不得进入应用进程的内存**（除固定的流式缓冲外）。
//! 因此本层的接口只提供流式读写与元数据操作，不提供「读进 Vec 再返回」的方法。
//!
//! 内容寻址：`<root>/<ab>/<cd>/<blake3>`，物理去重天然成立——同一份内容只会落一份盘。
//!
//! 两个实现：
//! - [`LocalFs`]：本地块存储，下载由 nginx `secure_link` + `sendfile` 直出；
//! - `S3Backend`（feature = "s3"）：Cloudflare R2 / OSS / COS / Garage / MinIO，
//!   预签名 URL 由对象存储自己校验，同样不经过应用进程。

mod local;
#[cfg(feature = "s3")]
mod s3;

use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use sc2clud_core::{BlobHash, Result};
use tokio::io::AsyncRead;

pub use local::LocalFs;
#[cfg(feature = "s3")]
pub use s3::S3Backend;

/// 读取流：调用方按块消费，恒定内存。
pub type BlobReader = Pin<Box<dyn AsyncRead + Send>>;

/// 共享存储后端句柄。
pub type SharedStorage = Arc<dyn StorageBackend>;

/// 对象的元数据。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BlobStat {
    pub hash: BlobHash,
    pub size: u64,
}

/// 一次写入的结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PutOutcome {
    pub stat: BlobStat,
    /// true 表示命中了已存在的同内容对象（秒传 / 去重），本次没有落新盘。
    pub deduplicated: bool,
}

/// 直接下发用的签名 URL。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PresignedUrl {
    /// LocalFs 返回**站点相对路径**（`/dl/ab/cd/<hash>?e=..&s=..`），
    /// 由 Web 层补上 `base_url`；S3 返回绝对 URL。
    pub url: String,
    pub expires_at: i64,
}

#[async_trait]
pub trait StorageBackend: Send + Sync + 'static {
    /// 后端名（用于日志与启动自检）。
    fn name(&self) -> &'static str;

    /// 流式写入：边收边算 blake3，全程恒定内存。
    ///
    /// `expected` 非空时做完整性校验，不匹配一律拒绝并清理临时文件。
    async fn put_stream(
        &self,
        reader: BlobReader,
        expected: Option<&BlobHash>,
    ) -> Result<PutOutcome>;

    /// 打开一个读取流。
    async fn get_stream(&self, hash: &BlobHash) -> Result<BlobReader>;

    /// 读取元数据；不存在返回 `Ok(None)`。
    async fn stat(&self, hash: &BlobHash) -> Result<Option<BlobStat>>;

    /// 删除对象；不存在视为成功（幂等）。
    async fn delete(&self, hash: &BlobHash) -> Result<()>;

    /// 就绪探针：默认不做事，本地后端会检查根目录是否可用。
    async fn health(&self) -> Result<()> {
        Ok(())
    }

    /// 签发一条带 TTL 的直接下发 URL（应用不搬运字节）。
    async fn presign_url(
        &self,
        hash: &BlobHash,
        ttl: Duration,
        client_ip: Option<&str>,
    ) -> Result<PresignedUrl>;
}
