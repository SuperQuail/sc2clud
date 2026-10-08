# 架构

## 1. 组件与调用方向

```text
客户端 ──TLS──▶ nginx ──┬── /static/*      直接 sendfile 发预压缩产物（零应用 CPU）
                        ├── /dl/*          secure_link 校验签名 → sendfile 直出 blob
                        └── 其余           proxy_pass → sc2clud (axum, 127.0.0.1:8080)
                                            │
                                            ├─ SQLite (WAL)  元数据/会话/计数
                                            └─ data/blobs/   内容寻址文件
```

依赖方向（不可违反）：`core` ← `storage` / `db` ← `web` ← `app`。

## 2. 上传路径（恒定内存）

```text
请求体流 ──pump（体积上限 + 令牌桶节流）──▶ 有界 channel(3) ──▶ StreamReader ──▶ put_stream
                                                                    │
                                        tmp/xxx.part ──blake3──▶ 校验 ──rename──▶ blobs/ab/cd/<hash>
```

- 缓冲上限 = `stream_chunk_bytes`(64 KiB) × (1 + channel 深度 3) ≈ 256 KiB，**与文件大小无关**。
- 上游出错时把 `Err(io::Error)` 作为最后一项送入通道：存储层读到的是错误而不是 EOF，
  因此**截断的内容永远不会被提交**（中转文件被清理）。这一点由冒烟测试的第 6 组用例守着。
- 同盘 `rename` 是原子的：读者永远看不到半成品；文件 `sync_all` 后落盘，Unix 上再 fsync 目录项。

## 3. 下载路径（应用 CPU 为 0）

1. 应用查一次 DB（`files` join `users`），用服务端密钥签一条短 TTL URL：`/dl/ab/cd/<hash>?e=<expires>&s=<sig>`；
2. 应用返回 **302**，同时把下载计数写进内存聚合（不落库）；
3. 客户端请求 `/dl/...`，nginx 用 `secure_link` 校验签名与过期时间，通过后 `sendfile` 直出磁盘。

签名算法必须与 nginx 表达式逐字节一致：

```text
nginx: secure_link_md5 "$secure_link_expires$uri$remote_addr <secret>";
应用:  md5("{expires}{uri}{client_ip} {secret}") → base64url（无填充）
```

冒烟测试用 **Windows CNG / openssl 独立复算**同一表达式，逐字节比对签名——
两侧任何一侧被改动而另一侧没跟，测试就会红。

## 4. 存储抽象

```rust
trait StorageBackend {
    fn name(&self) -> &'static str;
    async fn put_stream(&self, reader, expected_hash) -> Result<PutOutcome>;
    async fn get_stream(&self, hash) -> Result<BlobReader>;
    async fn stat(&self, hash) -> Result<Option<BlobStat>>;
    async fn delete(&self, hash) -> Result<()>;
    async fn presign_url(&self, hash, ttl, client_ip) -> Result<PresignedUrl>;
    async fn health(&self) -> Result<()>;
}
```

- `LocalFs`：`<root>/<ab>/<cd>/<blake3>`，去重天然成立；`presign_url` 返回站点相对路径（由 Web 层补 `base_url`）。
- `S3Backend`（`feature = "s3"`）：接口形状已固定，实现留待切换存储时补齐（R2 / OSS / COS / Garage / MinIO）。

## 5. 数据模型要点

| 表 | 作用 | 关键点 |
| --- | --- | --- |
| `blobs` | 盘上一份内容 | `hash` 主键 + `refcount` |
| `files` | 用户可见的文件名 | 多行可指向同一 `blob_hash`（去重/秒传）；软删除 |
| `users` | 账号与配额 | `quota_bytes` / `used_bytes` |
| `sessions` | 会话 | 存 token 摘要 + `csrf_token`（鉴权落地时使用） |
| `upload_sessions` | 分片续传 | `received_chunks` 为 JSON 数组 |
| `counters` | 写回缓冲落点 | 由后台任务每 10 秒批量累加 |
| `posts` / `comments` / `notifications` | 社区内容 | 均软删除 |

**回收规则**：删除文件记录 → `blobs.refcount -= 1`；归零才真正删盘。
冒烟测试验证了「删一个引用内容保留、全删才回收」。

## 6. 写热点与计数

SQLite 单写者意味着每请求一条 `UPDATE` 会立刻退化成写锁排队。因此：

```text
请求路径: counters.bump(key, 1)            ← 同步、无 I/O、不 await
后台任务: 每 10s drain() → 合并同键 → 一个事务批量 upsert
刷盘失败: 增量进重试缓冲（上限 10_000 键，超限丢弃并留痕）
进程退出: 优雅停机会再刷一次
```

## 7. 安全

- **路径闸门**：所有落盘路径拼接后过 `safety::ensure_within` 白名单校验；用户文件名先过 `safe_file_name`
  （拒绝 `..`、分隔符、控制字符、Windows 保留名）。
- **秒传不可信客户端**：只以服务端 `storage.stat` 的结果为准，声明体积不符即 409。
- **下载防盗链**：短 TTL + 绑定客户端 IP（`download.bind_client_ip`），签名与 IP 同时校验。
- **上传限速**：令牌桶按主体分桶（当前是 IP，接入登录后换 user id）+ 全站并发闸门（默认 5）。
- **错误不外泄**：`Storage` / `Database` / `Io` 一律回 500 + 泛化文案，细节只进日志。
- **待补**：会话 Cookie（HttpOnly + SameSite）+ CSRF 校验 + argon2 口令哈希（表结构已就绪）。
