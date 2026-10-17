//! 写热点聚合（写回缓冲）。
//!
//! SQLite 是单写者：浏览数、下载数这类高频计数如果每请求一条 UPDATE，
//! 会立刻退化成写锁排队。因此热度计数先进内存，再由后台任务按固定间隔
//! **批量**落库（刷盘实现见 `sc2clud-db::counters`，定时任务见 sc2clud-app）。

use std::collections::HashMap;
use std::sync::Mutex;

/// 进程内计数缓冲。
#[derive(Debug, Default)]
pub struct Counters {
    inner: Mutex<HashMap<String, i64>>,
}

impl Counters {
    pub fn new() -> Self {
        Self::default()
    }

    /// 累加一个计数键。**同步、无 I/O、不 await**：可以直接在请求路径里调用。
    pub fn bump(&self, key: impl Into<String>, delta: i64) {
        let mut guard = self.lock();
        *guard.entry(key.into()).or_insert(0) += delta;
    }

    /// 取走当前所有待落库增量并清空缓冲（刷盘任务每次调用一次）。
    pub fn drain(&self) -> Vec<(String, i64)> {
        let mut guard = self.lock();
        let mut out: Vec<(String, i64)> = guard.drain().collect();
        // 让刷盘顺序稳定：便于日志比对与排查。
        out.sort();
        out
    }

    /// 当前待落库的键数量。
    pub fn pending_keys(&self) -> usize {
        self.lock().len()
    }

    /// 当前待落库的增量绝对值之和。
    pub fn pending_total(&self) -> i64 {
        self.lock().values().map(|v| v.abs()).sum()
    }

    /// 中毒的锁也要能继续用：计数缓冲丢数据比 panic 更糟。
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, i64>> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// 合并同一键的多个增量（刷盘失败后重试时需要把旧增量并回来）。
pub fn merge_deltas(items: Vec<(String, i64)>) -> Vec<(String, i64)> {
    let mut merged: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    for (key, delta) in items {
        *merged.entry(key).or_insert(0) += delta;
    }
    merged.into_iter().filter(|(_, v)| *v != 0).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bump_accumulates_and_drain_clears() {
        let c = Counters::new();
        c.bump("post:1:views", 1);
        c.bump("post:1:views", 2);
        c.bump("file:9:downloads", 1);
        assert_eq!(c.pending_keys(), 2);
        assert_eq!(c.pending_total(), 4);
        assert_eq!(
            c.drain(),
            vec![
                ("file:9:downloads".to_string(), 1),
                ("post:1:views".to_string(), 3)
            ]
        );
        assert_eq!(c.pending_keys(), 0);
    }

    #[test]
    fn merge_deltas_sums_same_key() {
        let merged = merge_deltas(vec![
            ("a".to_string(), 1),
            ("b".to_string(), 2),
            ("a".to_string(), 3),
            ("c".to_string(), 0),
        ]);
        assert_eq!(merged, vec![("a".to_string(), 4), ("b".to_string(), 2)]);
    }

    #[test]
    fn concurrent_bumps_are_not_lost() {
        let c = std::sync::Arc::new(Counters::new());
        let mut handles = Vec::new();
        for _ in 0..4 {
            let c = std::sync::Arc::clone(&c);
            handles.push(std::thread::spawn(move || {
                for _ in 0..1000 {
                    c.bump("hot", 1);
                }
            }));
        }
        for h in handles {
            h.join().expect("join");
        }
        assert_eq!(c.drain(), vec![("hot".to_string(), 4000)]);
    }
}
