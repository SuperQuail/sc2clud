//! 内容寻址哈希（blake3）。
//!
//! 去重、秒传与完整性校验共用同一套摘要。blake3 是单核 GB/s 量级：
//! 在 2 vCPU 的机器上 CPU 长期空闲，磁盘与带宽才是瓶颈，哈希不构成开销。

use crate::error::{Error, Result};

/// 十六进制小写 blake3 摘要（固定 64 字符）。
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct BlobHash(String);

impl BlobHash {
    /// 解析客户端上报或数据库读出的摘要；大小写不敏感，其余一律拒绝。
    pub fn parse(raw: &str) -> Result<Self> {
        let s = raw.trim().to_ascii_lowercase();
        if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
            let shown: String = raw.chars().take(80).collect();
            return Err(Error::InvalidInput(format!(
                "blake3 摘要必须是 64 位十六进制，收到 {shown:?}"
            )));
        }
        Ok(Self(s))
    }

    /// 由 32 字节原始摘要构造。
    pub fn from_bytes(digest: &[u8; 32]) -> Self {
        Self(hex(digest))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 两级分片（前 2 + 后 2 位十六进制），把单目录文件数压到可控范围。
    pub fn shard(&self) -> (&str, &str) {
        (&self.0[0..2], &self.0[2..4])
    }

    /// 相对路径：`ab/cd/<hash>`。
    pub fn relative_path(&self) -> String {
        let (a, b) = self.shard();
        format!("{a}/{b}/{}", self.0)
    }
}

impl std::fmt::Display for BlobHash {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// 一次性哈希：只用于小对象（配置指纹、短文本），大文件一律走流式哈希。
pub fn hash_bytes(bytes: &[u8]) -> BlobHash {
    BlobHash::from_bytes(blake3::hash(bytes).as_bytes())
}

/// 流式哈希器：边收边算，内存占用与对象大小无关。
///
/// storage 层通过它计算摘要，因此 **blake3 只出现在 core 内部**：
/// 换哈希算法时只改这一个文件。
#[derive(Clone, Debug)]
pub struct StreamHasher(blake3::Hasher);

impl StreamHasher {
    pub fn new() -> Self {
        Self(blake3::Hasher::new())
    }

    pub fn update(&mut self, chunk: &[u8]) {
        self.0.update(chunk);
    }

    pub fn finalize(self) -> BlobHash {
        BlobHash::from_bytes(self.0.finalize().as_bytes())
    }
}

impl Default for StreamHasher {
    fn default() -> Self {
        Self::new()
    }
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_blake3_vector() {
        assert_eq!(
            hash_bytes(b"").as_str(),
            "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262"
        );
    }

    #[test]
    fn parse_rejects_bad_input() {
        assert!(BlobHash::parse("deadbeef").is_err());
        assert!(BlobHash::parse(&"z".repeat(64)).is_err());
        assert!(BlobHash::parse(&"A".repeat(64)).is_ok());
    }

    #[test]
    fn shard_layout() {
        let h = BlobHash::parse(&"0123456789abcdef".repeat(4)).expect("ok");
        assert_eq!(h.shard(), ("01", "23"));
        assert!(h.relative_path().starts_with("01/23/0123"));
    }

    #[test]
    fn stream_hasher_matches_one_shot() {
        let payload = b"streaming and one-shot must agree";
        let mut hasher = StreamHasher::new();
        for chunk in payload.chunks(7) {
            hasher.update(chunk);
        }
        assert_eq!(hasher.finalize(), hash_bytes(payload));
    }
}
