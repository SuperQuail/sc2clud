//! 下载链接签名（与 nginx `secure_link_md5` 对齐）。
//!
//! 硬性约束：**文件字节不经过应用进程**。应用只签发一条带 TTL 的签名 URL，
//! nginx 用 `secure_link` 自行校验签名与过期时间，然后 `sendfile` 直出磁盘。
//! 因此签名算法必须与 nginx 的表达式逐字节一致。
//!
//! nginx 侧（见 `deploy/nginx/sc2clud.conf`）：
//!
//! ```text
//! secure_link $arg_e,$arg_s;
//! secure_link_md5 "$secure_link_expires$uri$remote_addr <secret>";
//! ```
//!
//! 注意：stock nginx **只有 MD5**（无 SHA-256 变体），所谓 HMAC 是通过把密钥拼进被哈希
//! 表达式实现的带密钥 MAC。摘要按 base64url（无填充）编码。
//! 若将来需要真正的 HMAC-SHA256，可换用第三方模块 ngx_http_hmac_secure_link_module。

use std::time::Duration;

/// base64url 字母表（RFC 4648 §5，无填充）。
const B64URL: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/// base64url 编码，去掉 `=` 填充：nginx `secure_link` 按此解码 `$arg_s`。
pub fn base64url_nopad(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64URL[(n >> 18) as usize & 63] as char);
        out.push(B64URL[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(B64URL[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(B64URL[n as usize & 63] as char);
        }
    }
    out
}

/// 一条已签名的下载链接。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SignedLink {
    /// 受保护资源的 URI（nginx `internal` location 下的路径）。
    pub uri: String,
    /// 过期时刻（Unix 秒）。
    pub expires: i64,
    /// base64url 签名。
    pub sig: String,
}

impl SignedLink {
    /// 查询串：`e=<expires>&s=<sig>`（顺序固定，便于日志与排障）。
    pub fn query(&self) -> String {
        format!("e={}&s={}", self.expires, self.sig)
    }

    /// 完整路径：`/dl/ab/cd/<hash>?e=..&s=..`。
    pub fn to_path(&self) -> String {
        format!("{}?{}", self.uri, self.query())
    }
}

/// 下载签名器（进程内只持有一份密钥）。
#[derive(Clone)]
pub struct DownloadSigner {
    secret: String,
    bind_client_ip: bool,
}

impl DownloadSigner {
    /// `bind_client_ip` 必须与 nginx 表达式是否包含 `$remote_addr` 保持一致。
    pub fn new(secret: impl Into<String>, bind_client_ip: bool) -> Self {
        Self {
            secret: secret.into(),
            bind_client_ip,
        }
    }

    pub fn bind_client_ip(&self) -> bool {
        self.bind_client_ip
    }

    /// 被哈希的原始串：与 nginx 表达式一一对应（含分隔用的空格）。
    pub fn unsigned_input(&self, uri: &str, expires: i64, client_ip: Option<&str>) -> String {
        let ip = if self.bind_client_ip {
            client_ip.unwrap_or("")
        } else {
            ""
        };
        format!("{expires}{uri}{ip} {}", self.secret)
    }

    /// 签发签名（base64url 无填充）。
    pub fn signature(&self, uri: &str, expires: i64, client_ip: Option<&str>) -> String {
        use md5::{Digest, Md5};

        let input = self.unsigned_input(uri, expires, client_ip);
        let mut hasher = Md5::new();
        hasher.update(input.as_bytes());
        let digest = hasher.finalize();
        let mut raw = [0u8; 16];
        raw.copy_from_slice(&digest);
        base64url_nopad(&raw)
    }

    /// 按 TTL 签发一条下载链接。
    pub fn sign(&self, uri: &str, ttl: Duration, client_ip: Option<&str>) -> SignedLink {
        let expires = crate::now_unix() + ttl.as_secs() as i64;
        let sig = self.signature(uri, expires, client_ip);
        SignedLink {
            uri: uri.to_string(),
            expires,
            sig,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_matches_rfc4648_vector() {
        // MD5("") = d41d8cd98f00b204e9800998ecf8427e
        let raw = [
            0xd4, 0x1d, 0x8c, 0xd9, 0x8f, 0x00, 0xb2, 0x04, 0xe9, 0x80, 0x09, 0x98, 0xec, 0xf8,
            0x42, 0x7e,
        ];
        assert_eq!(base64url_nopad(&raw), "1B2M2Y8AsgTpgAmY7PhCfg");
    }

    #[test]
    fn base64url_handles_remainders() {
        assert_eq!(base64url_nopad(b""), "");
        assert_eq!(base64url_nopad(&[0xff]), "_w");
        assert_eq!(base64url_nopad(&[0xff, 0xff]), "__8");
    }

    #[test]
    fn unsigned_input_matches_nginx_expression() {
        let s = DownloadSigner::new("topsecret", true);
        assert_eq!(
            s.unsigned_input("/dl/ab/cd/x", 1_700_000_000, Some("203.0.113.7")),
            "1700000000/dl/ab/cd/x203.0.113.7 topsecret"
        );
    }

    #[test]
    fn ip_binding_can_be_disabled() {
        let s = DownloadSigner::new("topsecret", false);
        assert_eq!(
            s.unsigned_input("/dl/ab/cd/x", 1, Some("203.0.113.7")),
            "1/dl/ab/cd/x topsecret"
        );
        assert_eq!(
            s.signature("/a", 1, None),
            s.signature("/a", 1, Some("1.2.3.4"))
        );
    }

    #[test]
    fn signed_link_shape() {
        let s = DownloadSigner::new("k", false);
        let link = s.sign("/dl/aa/bb/cc", Duration::from_secs(60), None);
        assert!(link.to_path().starts_with("/dl/aa/bb/cc?e="));
        assert!(link.to_path().contains("&s="));
        assert!(link.expires >= crate::now_unix());
        assert!(!link.sig.contains('='));
    }

    #[test]
    fn signature_matches_independent_implementation() {
        // 期望值由 Windows CNG（.NET MD5 + Base64）独立算出，用交叉验证
        // 「表达式拼接 + MD5 + base64url」三步是否与 nginx 一致。
        let s = DownloadSigner::new("topsecret", true);
        assert_eq!(
            s.signature("/dl/ab/cd/x", 1_700_000_000, Some("203.0.113.7")),
            "TOkysTBQ5tTDwyAZ1d3fSA"
        );
        assert_eq!(
            s.signature("/dl/ab/cd/x", 1_700_000_000, None),
            "GgEiaNlw1RfWjpZO8RzZEA"
        );
    }

    #[test]
    fn signature_depends_on_expiry_and_uri() {
        let s = DownloadSigner::new("k", false);
        assert_ne!(s.signature("/a", 1, None), s.signature("/a", 2, None));
        assert_ne!(s.signature("/a", 1, None), s.signature("/b", 1, None));
    }
}
