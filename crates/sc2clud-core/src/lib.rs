//! SC2clud 领域核心层。
//!
//! 本层**不依赖** Web 框架、数据库驱动与具体存储实现，也不启动任何异步运行时：
//! 只提供纯逻辑（路径安全、配置、签名、限速、计数聚合），因此可以脱离网络与磁盘单元测试。
//!
//! 依赖方向（不可违反）：
//! `sc2clud-core` ← `sc2clud-storage` / `sc2clud-db` ← `sc2clud-web` ← `sc2clud-app`

pub mod config;
pub mod counter;
pub mod error;
pub mod hash;
pub mod ratelimit;
pub mod safety;
pub mod sign;

pub use error::{Error, Result};
pub use hash::{BlobHash, StreamHasher};

/// 流式处理的固定缓冲大小：64 KiB。
///
/// 恒定内存预算的关键常数：所有「边收边算」的路径都按这个粒度推进，
/// 任何情况下都不得把整个文件读进 `Vec<u8>`。
pub const STREAM_CHUNK_BYTES: usize = 64 * 1024;

/// 惰性分配的堆缓冲（避免每块都重新分配零填充内存）。
pub fn stream_buffer() -> Vec<u8> {
    Vec::with_capacity(STREAM_CHUNK_BYTES)
}

/// 当前 Unix 时间戳（秒）。
pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_buffer_is_lazy() {
        let buf = stream_buffer();
        assert_eq!(buf.len(), 0);
        assert!(buf.capacity() >= STREAM_CHUNK_BYTES);
    }

    #[test]
    fn now_unix_is_sane() {
        // 2020-01-01 之后、2100 年之前
        let now = now_unix();
        assert!(now > 1_577_836_800, "系统时钟异常：{now}");
        assert!(now < 4_102_444_800, "系统时钟异常：{now}");
    }
}
