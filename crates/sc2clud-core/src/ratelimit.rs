//! 应用层限速。
//!
//! 下载限速交给 nginx（`limit_rate_after` / `limit_rate`，零应用 CPU）。
//! 但**上传限速 stock nginx 没有对应指令**，只能在应用层做——这是本项目唯一
//! 必须自己实现的限速点：单用户 256 KB/s，全站并发上传 ≤ 5 条。

use std::time::{Duration, Instant};

/// 令牌桶：容量 `burst`，按 `rate` 匀速回填。
#[derive(Debug)]
pub struct TokenBucket {
    rate: f64,
    burst: f64,
    tokens: f64,
    last: Instant,
}

impl TokenBucket {
    /// 速率下限 1 B/s：避免 0 速率导致除零与无限等待。
    pub fn new(rate_bytes_per_sec: u64, burst_bytes: u64) -> Self {
        let rate = (rate_bytes_per_sec as f64).max(1.0);
        let burst = (burst_bytes as f64).max(1.0);
        Self {
            rate,
            burst,
            tokens: burst,
            last: Instant::now(),
        }
    }

    pub fn rate_bytes_per_sec(&self) -> u64 {
        self.rate as u64
    }

    /// 申请 `n` 字节的发送许可。
    ///
    /// 返回**调用方应当先等待的时长**：进入下一块之前 `sleep` 这段时间
    /// 即可把平均速率压在 `rate` 以内（返回 `Duration::ZERO` 表示无需等待）。
    pub fn acquire(&mut self, n: u64, now: Instant) -> Duration {
        self.refill(now);
        let need = n as f64;
        if self.tokens >= need {
            self.tokens -= need;
            return Duration::ZERO;
        }
        let deficit = need - self.tokens;
        self.tokens = 0.0;
        Duration::from_secs_f64(deficit / self.rate)
    }

    /// 当前可用令牌数（已按时间回填）。
    pub fn available(&mut self, now: Instant) -> u64 {
        self.refill(now);
        self.tokens as u64
    }

    fn refill(&mut self, now: Instant) {
        let elapsed = now.saturating_duration_since(self.last).as_secs_f64();
        if elapsed <= 0.0 {
            return;
        }
        self.last = now;
        self.tokens = (self.tokens + elapsed * self.rate).min(self.burst);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const KB: u64 = 1024;

    #[test]
    fn burst_is_available_immediately() {
        let now = Instant::now();
        let mut bucket = TokenBucket::new(256 * KB, 512 * KB);
        assert_eq!(bucket.acquire(512 * KB, now), Duration::ZERO);
        assert!(bucket.acquire(1, now) > Duration::ZERO);
    }

    #[test]
    fn deficit_is_paced_by_rate() {
        let start = Instant::now();
        let mut bucket = TokenBucket::new(256 * KB, 64 * KB);
        assert_eq!(bucket.acquire(64 * KB, start), Duration::ZERO);
        // 桶已空：再要 256 KB 需要整 1 秒
        let wait = bucket.acquire(256 * KB, start);
        assert!(wait >= Duration::from_millis(900), "等待过短：{wait:?}");
        assert!(wait <= Duration::from_millis(1100), "等待过长：{wait:?}");
    }

    #[test]
    fn refill_is_capped_by_burst() {
        let start = Instant::now();
        let mut bucket = TokenBucket::new(256 * KB, 64 * KB);
        assert_eq!(bucket.available(start + Duration::from_secs(60)), 64 * KB);
    }

    #[test]
    fn zero_rate_does_not_panic() {
        let now = Instant::now();
        let mut bucket = TokenBucket::new(0, 0);
        let wait = bucket.acquire(1024, now);
        assert!(wait.as_secs() <= 1024);
    }
}
