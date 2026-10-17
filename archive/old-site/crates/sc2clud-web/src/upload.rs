//! 流式上传：恒定内存 + 应用层限速 + 并发闸门。
//!
//! 为什么限速必须在这里做：nginx 有 `limit_rate`（下载），但**没有上传限速指令**。
//! 为什么不用「读进内存再落盘」：单文件 50 MB × 5 并发 = 250 MB 常驻，直接吃掉 2 GB 的八分之一。
//!
//! 结构：
//!
//! ```text
//! 请求体流 ──pump（限速 + 体积上限）──▶ 有界 channel ──▶ StreamReader ──▶ StorageBackend::put_stream
//! ```
//!
//! channel 容量固定，因此内存上限 ≈ 容量 × 块大小，与文件大小无关。
//! 上游出错时把 `Err(io::Error)` 作为最后一项送进 channel：存储层读到的是错误而不是 EOF，
//! 因此**截断的内容永远不会被提交**（中转文件会被清理）。

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures_util::StreamExt;
use sc2clud_core::Error as DomainError;
use sc2clud_core::ratelimit::TokenBucket;
use tokio::sync::{OwnedSemaphorePermit, Semaphore, mpsc};

use crate::error::AppError;

/// channel 深度：3 × 64 KiB ≈ 192 KiB 在途缓冲。
pub const DEFAULT_QUEUE_DEPTH: usize = 3;

/// 令牌桶表的上限：超过就整体重建（粗粒度但内存有界；分桶键是用户或 IP）。
const MAX_BUCKETS: usize = 4096;

pub struct UploadGate {
    permits: Arc<Semaphore>,
    buckets: Mutex<HashMap<String, TokenBucket>>,
    rate: u64,
    burst: u64,
}

impl UploadGate {
    pub fn new(max_concurrent: u32, rate_bytes_per_sec: u64, burst_bytes: u64) -> Arc<Self> {
        Arc::new(Self {
            permits: Arc::new(Semaphore::new(max_concurrent.max(1) as usize)),
            buckets: Mutex::new(HashMap::new()),
            rate: rate_bytes_per_sec,
            burst: burst_bytes,
        })
    }

    pub fn max_concurrent(&self) -> usize {
        self.permits.available_permits()
    }

    /// 取一个上传并发许可。
    ///
    /// 满了**立刻失败**而不是排队：让慢速客户端占着连接等待，会同时浪费内存与带宽。
    pub fn try_acquire(self: &Arc<Self>) -> Option<OwnedSemaphorePermit> {
        Arc::clone(&self.permits).try_acquire_owned().ok()
    }

    /// 本块发送前需要等待的时长（按主体分桶：登录后传 user id，未登录传 IP）。
    pub fn pace(&self, subject: &str, bytes: u64) -> Duration {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap_or_else(|e| e.into_inner());
        if buckets.len() >= MAX_BUCKETS && !buckets.contains_key(subject) {
            buckets.clear();
        }
        let rate = self.rate;
        let burst = self.burst;
        let bucket = buckets
            .entry(subject.to_string())
            .or_insert_with(|| TokenBucket::new(rate, burst));
        bucket.acquire(bytes, now)
    }
}

/// 把请求体泵进受保护通道：先算体积上限，再按令牌桶节流。
///
/// 返回实际接收的字节数；出错时通道里已被放入 `Err`，下游会据此放弃并清理。
pub async fn pump_body<S>(
    mut body: S,
    tx: mpsc::Sender<Result<Bytes, std::io::Error>>,
    gate: Arc<UploadGate>,
    subject: String,
    max_bytes: u64,
) -> Result<u64, AppError>
where
    S: futures_util::Stream<Item = Result<Bytes, axum::Error>> + Unpin,
{
    let mut total: u64 = 0;
    while let Some(chunk) = body.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(e) => {
                let detail = e.to_string();
                let _ = tx.send(Err(std::io::Error::other(detail.clone()))).await;
                return Err(AppError::internal(format!("读取请求体失败：{detail}")));
            }
        };
        if chunk.is_empty() {
            continue;
        }

        total += chunk.len() as u64;
        if total > max_bytes {
            let msg = format!("超出单文件上限（{} 字节）", max_bytes);
            let _ = tx.send(Err(std::io::Error::other(msg.clone()))).await;
            return Err(AppError::Domain(DomainError::QuotaExceeded(msg)));
        }

        let wait = gate.pace(&subject, chunk.len() as u64);
        if !wait.is_zero() {
            tokio::time::sleep(wait).await;
        }

        if tx.send(Ok(chunk)).await.is_err() {
            // 下游已经放弃（例如存储报错），不再继续读请求体。
            break;
        }
    }
    Ok(total)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::stream;

    #[tokio::test]
    async fn pump_forwards_chunks_in_order() {
        let gate = UploadGate::new(1, 1024 * 1024, 1024 * 1024);
        let (tx, mut rx) = mpsc::channel(DEFAULT_QUEUE_DEPTH);
        let chunks: Vec<Result<Bytes, axum::Error>> = vec![
            Ok(Bytes::from_static(b"abc")),
            Ok(Bytes::from_static(b"def")),
        ];
        let received = pump_body(
            stream::iter(chunks),
            tx.clone(),
            Arc::clone(&gate),
            "test".to_string(),
            1024,
        )
        .await
        .expect("pump");
        drop(tx);

        assert_eq!(received, 6);
        let mut collected = Vec::new();
        while let Some(item) = rx.recv().await {
            collected.extend_from_slice(&item.expect("chunk"));
        }
        assert_eq!(collected, b"abcdef");
    }

    #[tokio::test]
    async fn pump_rejects_oversized_body_with_error_in_channel() {
        let gate = UploadGate::new(1, 1024 * 1024, 1024 * 1024);
        let (tx, mut rx) = mpsc::channel(DEFAULT_QUEUE_DEPTH);
        let chunks: Vec<Result<Bytes, axum::Error>> = vec![
            Ok(Bytes::from_static(b"0123456789")),
            Ok(Bytes::from_static(b"0123456789")),
        ];
        let err = pump_body(
            stream::iter(chunks),
            tx,
            Arc::clone(&gate),
            "test".to_string(),
            15,
        )
        .await
        .expect_err("超限必须失败");
        assert_eq!(err.parts().0, axum::http::StatusCode::PAYLOAD_TOO_LARGE);

        // 通道里的最后一项必须是 Err：下游据此放弃，不会把截断内容当成功。
        let mut last_is_err = false;
        while let Some(item) = rx.recv().await {
            last_is_err = item.is_err();
        }
        assert!(last_is_err, "超限时必须把错误交给下游");
    }

    #[tokio::test]
    async fn gate_limits_concurrency() {
        let gate = UploadGate::new(1, 1024, 1024);
        let first = gate.try_acquire().expect("第一个许可");
        assert!(
            gate.try_acquire().is_none(),
            "并发上限为 1 时第二个必须失败"
        );
        drop(first);
        assert!(gate.try_acquire().is_some(), "释放后应能再次获取");
    }

    #[tokio::test]
    async fn pace_paces_after_burst() {
        let gate = UploadGate::new(1, 1024, 1024);
        assert!(gate.pace("a", 1024).is_zero(), "首块应落在 burst 内");
        assert!(!gate.pace("a", 1024).is_zero(), "burst 用尽后必须等待");
        assert!(gate.pace("b", 1024).is_zero(), "不同主体各用各的桶");
    }
}
