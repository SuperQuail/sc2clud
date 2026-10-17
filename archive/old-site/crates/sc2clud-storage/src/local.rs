//! 本地块存储后端（内容寻址）。
//!
//! 布局：`<root>/<ab>/<cd>/<blake3>`，两级分片把单目录文件数压到可控范围。
//! 写入路径严格恒定内存：固定 `chunk_bytes` 缓冲，边收边算哈希，
//! 先落 `tmp/` 再 `rename` 到最终路径（同盘 rename 是原子的，读者永远看不到半成品）。
//!
//! 下载不经过本进程：[`presign_url`] 只签发 nginx `secure_link` 可校验的短 TTL URL。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;
use sc2clud_core::sign::DownloadSigner;
use sc2clud_core::{BlobHash, Error, Result, STREAM_CHUNK_BYTES, StreamHasher, safety};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::{BlobReader, BlobStat, PresignedUrl, PutOutcome, StorageBackend};

/// 中转文件序号：保证同进程内临时文件名唯一（跨进程用 pid 区分）。
static TEMP_SEQ: AtomicU64 = AtomicU64::new(0);

pub struct LocalFs {
    root: PathBuf,
    signer: DownloadSigner,
    download_prefix: String,
    chunk_bytes: usize,
}

impl LocalFs {
    pub fn new(
        root: impl Into<PathBuf>,
        signer: DownloadSigner,
        download_prefix: impl Into<String>,
    ) -> Self {
        Self {
            root: root.into(),
            signer,
            download_prefix: download_prefix.into(),
            chunk_bytes: STREAM_CHUNK_BYTES,
        }
    }

    /// 覆盖流式缓冲大小（配置项 `limits.stream_chunk_bytes`）。
    pub fn with_chunk_bytes(mut self, chunk_bytes: usize) -> Self {
        self.chunk_bytes = chunk_bytes.clamp(4 * 1024, 4 * 1024 * 1024);
        self
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    /// 上传中转目录（生产环境应放在数据盘上，并由 tmpfiles 定期清理残留）。
    pub fn temp_dir(&self) -> PathBuf {
        self.root.join("tmp")
    }

    /// 内容寻址落盘路径。
    ///
    /// 哈希来自服务端自己算出的摘要，理论上不含用户可控字符；
    /// 仍然走一遍白名单校验——这是「所有写路径都必须过闸门」的纪律，不是多余的防御。
    pub fn blob_path(&self, hash: &BlobHash) -> Result<PathBuf> {
        safety::ensure_within(&self.root, &self.root.join(hash.relative_path()))
    }

    fn unique_temp_path(&self) -> PathBuf {
        let seq = TEMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        self.temp_dir()
            .join(format!("upload-{}-{seq}-{nanos}.part", std::process::id()))
    }
}

/// 目录项 fsync：保证 rename 之后的目录项在掉电后仍然可见（仅 Unix 有意义）。
#[cfg(unix)]
async fn sync_dir(dir: &Path) {
    if let Ok(handle) = tokio::fs::File::open(dir).await {
        let _ = handle.sync_all().await;
    }
}

#[cfg(not(unix))]
async fn sync_dir(_dir: &Path) {}

#[async_trait]
impl StorageBackend for LocalFs {
    fn name(&self) -> &'static str {
        "local-fs"
    }

    async fn put_stream(
        &self,
        mut reader: BlobReader,
        expected: Option<&BlobHash>,
    ) -> Result<PutOutcome> {
        tokio::fs::create_dir_all(self.temp_dir()).await?;
        let temp_path = self.unique_temp_path();

        let mut hasher = StreamHasher::new();
        let mut buffer = sc2clud_core::stream_buffer();
        buffer.resize(self.chunk_bytes, 0);
        let mut size: u64 = 0;
        let mut file = tokio::fs::File::create(&temp_path).await?;

        // 唯一的读循环：缓冲大小恒定，内存占用与文件大小无关。
        let written = async {
            loop {
                let n = reader.read(&mut buffer).await?;
                if n == 0 {
                    break;
                }
                hasher.update(&buffer[..n]);
                file.write_all(&buffer[..n]).await?;
                size += n as u64;
            }
            file.flush().await?;
            file.sync_all().await?;
            Ok::<u64, std::io::Error>(size)
        }
        .await;

        let size = match written {
            Ok(size) => size,
            Err(e) => {
                let _ = tokio::fs::remove_file(&temp_path).await;
                return Err(Error::Io(e));
            }
        };

        let hash = hasher.finalize();

        if let Some(expected) = expected
            && expected != &hash
        {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Err(Error::HashMismatch {
                expected: expected.to_string(),
                actual: hash.to_string(),
            });
        }

        let final_path = self.blob_path(&hash)?;
        let stat = BlobStat {
            hash: hash.clone(),
            size,
        };

        // 去重：同内容已存在则直接丢掉中转文件（秒传的落点）。
        if tokio::fs::try_exists(&final_path).await.unwrap_or(false) {
            let _ = tokio::fs::remove_file(&temp_path).await;
            return Ok(PutOutcome {
                stat,
                deduplicated: true,
            });
        }

        if let Some(parent) = final_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::rename(&temp_path, &final_path).await?;
        if let Some(parent) = final_path.parent() {
            sync_dir(parent).await;
        }

        Ok(PutOutcome {
            stat,
            deduplicated: false,
        })
    }

    async fn get_stream(&self, hash: &BlobHash) -> Result<BlobReader> {
        let path = self.blob_path(hash)?;
        match tokio::fs::File::open(&path).await {
            Ok(file) => Ok(Box::pin(file)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Err(Error::NotFound(format!("blob {hash} 不存在")))
            }
            Err(e) => Err(Error::Io(e)),
        }
    }

    async fn stat(&self, hash: &BlobHash) -> Result<Option<BlobStat>> {
        let path = self.blob_path(hash)?;
        match tokio::fs::metadata(&path).await {
            Ok(meta) => Ok(Some(BlobStat {
                hash: hash.clone(),
                size: meta.len(),
            })),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(Error::Io(e)),
        }
    }

    async fn delete(&self, hash: &BlobHash) -> Result<()> {
        let path = self.blob_path(hash)?;
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(Error::Io(e)),
        }
    }

    async fn available_bytes(&self) -> Result<u64> {
        fs4::available_space(&self.root)
            .map_err(|e| Error::Storage(format!("读取 {} 可用空间失败：{e}", self.root.display())))
    }

    async fn health(&self) -> Result<()> {
        let meta = tokio::fs::metadata(&self.root).await.map_err(|e| {
            Error::Storage(format!("blob 根目录 {} 不可用：{e}", self.root.display()))
        })?;
        if !meta.is_dir() {
            return Err(Error::Storage(format!(
                "blob 根路径 {} 不是目录",
                self.root.display()
            )));
        }
        Ok(())
    }

    async fn presign_url(
        &self,
        hash: &BlobHash,
        ttl: Duration,
        client_ip: Option<&str>,
    ) -> Result<PresignedUrl> {
        let prefix = self.download_prefix.trim_end_matches('/');
        let uri = format!("{prefix}/{}", hash.relative_path());
        let link = self.signer.sign(&uri, ttl, client_ip);
        Ok(PresignedUrl {
            url: link.to_path(),
            expires_at: link.expires,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sc2clud_core::hash::hash_bytes;
    use std::io::Cursor;

    fn fixture() -> (tempfile::TempDir, LocalFs) {
        let dir = tempfile::tempdir().expect("tempdir");
        let signer = DownloadSigner::new("test-secret", true);
        let backend = LocalFs::new(dir.path().join("blobs"), signer, "/dl");
        (dir, backend)
    }

    fn reader(data: &[u8]) -> BlobReader {
        Box::pin(Cursor::new(data.to_vec()))
    }

    async fn read_all(mut stream: BlobReader) -> Vec<u8> {
        let mut out = Vec::new();
        stream.read_to_end(&mut out).await.expect("read");
        out
    }

    fn count_files(dir: &Path) -> usize {
        let mut total = 0;
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    total += count_files(&path);
                } else {
                    total += 1;
                }
            }
        }
        total
    }

    #[tokio::test]
    async fn put_then_get_round_trips_across_chunks() {
        let (_dir, backend) = fixture();
        // 4 个 chunk 以上，确保读循环与哈希增量都真的被走到
        let payload: Vec<u8> = (0..300 * 1024).map(|i| (i % 251) as u8).collect();
        let outcome = backend
            .put_stream(reader(&payload), None)
            .await
            .expect("put");

        assert_eq!(outcome.stat.size, payload.len() as u64);
        assert!(!outcome.deduplicated);
        assert_eq!(outcome.stat.hash, hash_bytes(&payload));

        let back = read_all(backend.get_stream(&outcome.stat.hash).await.expect("get")).await;
        assert_eq!(back, payload);
        assert_eq!(
            backend
                .stat(&outcome.stat.hash)
                .await
                .expect("stat")
                .expect("some")
                .size,
            payload.len() as u64
        );
    }

    #[tokio::test]
    async fn same_content_is_stored_once() {
        let (dir, backend) = fixture();
        let payload = b"duplicate me".to_vec();

        let first = backend
            .put_stream(reader(&payload), None)
            .await
            .expect("first");
        let second = backend
            .put_stream(reader(&payload), None)
            .await
            .expect("second");

        assert!(!first.deduplicated);
        assert!(second.deduplicated, "同内容第二次写入必须命中已有对象");
        assert_eq!(first.stat.hash, second.stat.hash);
        assert_eq!(count_files(&dir.path().join("blobs")), 1, "只应落一份盘");
    }

    #[tokio::test]
    async fn declared_hash_mismatch_is_rejected_and_temp_cleaned() {
        let (_dir, backend) = fixture();
        let declared = hash_bytes(b"what the client claimed");

        let err = backend
            .put_stream(reader(b"actual bytes"), Some(&declared))
            .await
            .expect_err("哈希不符必须拒绝");
        assert!(matches!(err, Error::HashMismatch { .. }), "{err:?}");

        assert!(backend.stat(&declared).await.expect("stat").is_none());
        assert!(
            backend
                .stat(&hash_bytes(b"actual bytes"))
                .await
                .expect("stat")
                .is_none()
        );

        let mut entries = tokio::fs::read_dir(backend.temp_dir())
            .await
            .expect("tmp dir");
        assert!(
            entries.next_entry().await.expect("entry").is_none(),
            "被拒绝的上传不得留下中转文件"
        );
    }

    #[tokio::test]
    async fn declared_hash_match_is_accepted() {
        let (_dir, backend) = fixture();
        let payload = b"trust but verify";
        let declared = hash_bytes(payload);
        let outcome = backend
            .put_stream(reader(payload), Some(&declared))
            .await
            .expect("put");
        assert_eq!(outcome.stat.hash, declared);
    }

    #[tokio::test]
    async fn delete_is_idempotent() {
        let (_dir, backend) = fixture();
        let outcome = backend.put_stream(reader(b"bye"), None).await.expect("put");
        backend.delete(&outcome.stat.hash).await.expect("delete");
        backend
            .delete(&outcome.stat.hash)
            .await
            .expect("再次删除也应成功");
        assert!(
            backend
                .stat(&outcome.stat.hash)
                .await
                .expect("stat")
                .is_none()
        );
    }

    #[tokio::test]
    async fn missing_blob_reports_not_found() {
        let (_dir, backend) = fixture();
        let err = backend
            .get_stream(&hash_bytes(b"never uploaded"))
            .await
            .err()
            .expect("缺失对象必须报错");
        assert_eq!(err.kind(), "not_found");
    }

    #[tokio::test]
    async fn presign_returns_signed_download_path() {
        let (_dir, backend) = fixture();
        let hash = hash_bytes(b"shared file");
        let signed = backend
            .presign_url(&hash, Duration::from_secs(60), Some("203.0.113.7"))
            .await
            .expect("presign");

        assert!(signed.url.starts_with("/dl/"), "{}", signed.url);
        assert!(signed.url.contains("?e="), "{}", signed.url);
        assert!(signed.url.contains("&s="), "{}", signed.url);
        assert!(signed.url.contains(&hash.relative_path()), "{}", signed.url);
        assert!(signed.expires_at >= sc2clud_core::now_unix());
    }

    #[test]
    fn blob_path_is_always_inside_root() {
        let (_dir, backend) = fixture();
        let hash = hash_bytes(b"anything");
        let path = backend.blob_path(&hash).expect("在根目录内");
        assert!(path.starts_with(backend.root()));
        assert!(path.ends_with(hash.as_str()));
    }
}
