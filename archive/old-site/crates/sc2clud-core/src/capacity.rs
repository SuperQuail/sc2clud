//! 容量闸门。
//!
//! 上传是唯一会让磁盘增长的操作，因此在**每个写入入口**先问一句「还剩多少」：
//! 可用空间低于阈值就拒绝写入（而不是等磁盘写满，连日志和 SQLite 都写不进去）。
//!
//! 判定逻辑单独成函数、并接受「可用空间」作为参数，是为了能单测边界，
//! 而不必真的把磁盘填满——取真实可用空间是系统调用（见 storage 层）。

use crate::error::{Error, Result};

/// 写入前的空间闸门：可用空间低于阈值就拒绝。
///
/// 阈值来自 `limits.min_free_bytes`（默认 5 GiB，可用 `SC2CLUD_MIN_FREE_BYTES` 覆盖）。
pub fn ensure_free_space(free_bytes: u64, min_free_bytes: u64) -> Result<()> {
    if free_bytes < min_free_bytes {
        return Err(Error::StorageLow {
            free_mb: free_bytes / (1024 * 1024),
            threshold_mb: min_free_bytes / (1024 * 1024),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn rejects_when_below_threshold() {
        let err = ensure_free_space(4 * GIB, 5 * GIB).expect_err("低于阈值必须拒绝");
        assert_eq!(err.kind(), "storage_low");
        assert!(err.to_string().contains("可用空间不足"), "{err}");
    }

    #[test]
    fn allows_exactly_at_threshold() {
        // 边界：等于阈值放行（避免「差 1 字节就拒」的抖动）
        assert!(ensure_free_space(5 * GIB, 5 * GIB).is_ok());
        assert!(ensure_free_space(5 * GIB + 1, 5 * GIB).is_ok());
    }

    #[test]
    fn zero_threshold_disables_the_gate() {
        assert!(ensure_free_space(0, 0).is_ok());
    }
}
