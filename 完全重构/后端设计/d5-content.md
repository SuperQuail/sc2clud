# D5 内容域后端设计（图片 / 默认头像 / 收款码 / 下载 / 搜索 / 验证码）

> 归属模块：`internal/media`、`internal/release`、`internal/platform/search`、`internal/platform/image`、`internal/platform/captcha`。
> 优先级：`后端开工前拍板.md` > 本文 > `数据库设计-postgresql.md` > `论坛后端技术方案-v2.md`。
> 也就是说：**拍板文件动不了**（本文与它冲突的地方一律是本文错，照它改）；本文与另外两份旧文档冲突的地方，**以本文为准**，逐条列在 §12.1。
> 本文只裁决 D5 的内容（表结构、端点、算法、归属）；**别人的域一句话都不改**——需要回写旧文档的清单在 §12.2。
> 本文只做设计。**本轮不写 Go 代码、不改 go.mod、不生成 ent 代码、不动 internal/ent/schema/**。

## 0. 本域一句话

**图片是本站唯一的字节入口，搜索是本域唯一「错了也测不出来」的失败模式。**
前者靠内容寻址 + refcount + 三档可见性收口；后者靠「写入与查询共用同一个 Go 分词器 + 一条参数化的 SQL」收口。

---

## 1. 图片存储：`internal/platform/image`

### 1.1 磁盘布局与接口

    <root>/<ab>/<cd>/<sha256>        ab/cd = 摘要前 4 位十六进制
    <root>/tmp/<random>.part         写入中的临时文件（GC 会清超过 24h 的残件）
    <root>/placeholder/<reason>.png  权限不足的占位图（随二进制 embed，不进磁盘）

    // internal/platform/image/image.go
    package image

    var (
        ErrNotFound = errors.New("image: not found")
        ErrTooLarge = errors.New("image: too large")      // 超过 maxBytes
        ErrBadType  = errors.New("image: bad type")       // 魔数不在 PNG/JPEG/GIF/WebP 里（含 SVG）
        ErrDiskFull = errors.New("image: disk full")      // 预检不过 或 写入返回 ENOSPC
    )

    // 长度恒为 64 的十六进制 sha256（小写）。用来给「hash 长得对不对」一个类型。
    type Hash string

    type Store interface {
        // 边读边算 sha256，最多读 maxBytes 字节；超限返回 ErrTooLarge 且不落盘。
        // 内容已存在时直接返回（去重），不重写文件。
        Put(ctx context.Context, r io.Reader, maxBytes int64) (Hash, int64, error)
        Open(ctx context.Context, h Hash) (io.ReadCloser, error)
        Stat(ctx context.Context, h Hash) (int64, error)
        Delete(ctx context.Context, h Hash) error
        // 遍历磁盘上的 hash（image:gc 用它找「有文件没行」的孤儿）。
        Walk(ctx context.Context, fn func(Hash) error) error
    }

    // 唯一实现
    // internal/platform/image/localstore/localstore.go
    func New(root string, minFreeBytes int64) (*Store, error)

`Stat` 存在的唯一理由：`/img/{hash}` 的 `HEAD` 与「行在文件丢」的告警；`Walk` 存在的唯一理由是 image:gc 的第二半。**没有 `Exists`**——它在去重路径上省不掉一次打开，只会多一个要维护的方法。

### 1.2 Put 的准确流程（每条都有对应测试）

1. `tmp` 目录不存在则 `MkdirAll(root/tmp, 0o755)`；启动时 `New` 已经确认 root 可写（写一个探针文件再删）。
2. 预检磁盘：`freeBytes(root)` < `minFreeBytes` → `ErrDiskFull`（**不建临时文件**）。
   - `freeBytes` 用 `syscall.Statfs`，**放在 `localstore/free_unix.go`（`//go:build unix`）**，`free_other.go` 返回 `(0, nil)`：0 表示「这个平台不判」，于是 Windows 开发机上闸门自动关闭。旧站同款闸门（`sc2clud-core/src/capacity.rs`）也是这条语义：等于阈值放行、阈值 0 关闭。
3. `f, _ := os.CreateTemp(root/tmp, "*.part")`（随机名，避免并发写同一临时文件）。
4. `io.Copy` 的目标是 `io.MultiWriter(f, sha256.New())`，源头是 `io.LimitReader(r, maxBytes+1)`：
   - 复制完读到的字节数 `n == maxBytes+1` → 关闭 + 删临时文件 + `ErrTooLarge`；
   - 于是「边读边算 + 超限即停」是一次遍历，不会先落盘再判断。
5. `mime` 由**缓冲区头 512 字节**嗅探（见 §1.3）；不在四种之内 → 删临时文件 + `ErrBadType`。
6. `f.Sync()` → `f.Close()` → `os.Rename(tmp, final)`。
   - 目标已存在（`rename` 成功覆盖，但那是别人先写好的同一份内容）→ 无害；**同摘要内容必然逐字节相同**，覆盖与忽略等价，不需要先 `Stat` 再决定（省一次系统调用，也省掉 TOCTOU）。
   - 目标目录不存在 → `MkdirAll(filepath.Dir(final))` 一次（`ab`/`cd` 只有 65536 个组合，不做目录缓存）。
7. **fsync 父目录**（`ab/cd` 那一层）：只 fsync 文件不 fsync 目录时，掉电后可能出现「文件内容在、目录项不在」。这一步不写它，等于第 6 步的原子性只保证了一半。
8. 返回 `hash, n`，其中 `n ≤ maxBytes`。

**并发重放**（问题 2）：同一个 sha256 被两个请求同时 Put → 两个临时文件、两次 rename，后者覆盖前者（内容相同）；`images` 表的写入是 §2.3 的 upsert，refcount 加两次 —— 正确，因为「上传两次」就该算两次引用（第一次的 refcount 会由调用方在同一事务里解掉，见 §2.3 的分支）。**不需要锁**：没有会被撕裂的共享状态。

**失败后落点**（问题 3）：任何一步失败都删掉自己的临时文件，磁盘上不留残件、库里没有行 —— **不需要人手修复**，用户重试即可。唯一的例外是 `os.Remove` 自身失败（权限/句柄），此时临时文件留在 `tmp/`，由 image:gc 的「清超过 24h 的 `.part`」兜底。

### 1.3 魔数嗅探与尺寸解析（`image/imgsize`）

    // internal/platform/image/imgsize/imgsize.go
    package imgsize

    // 只认这四种。SVG 不在其中——它可以内嵌 <script>，浏览器按 XML 执行。
    func Sniff(head []byte) (mime string, ok bool)
    // 返回宽高；解析不出来返回错误（调用方按 media.bad_type 处理）。
    func Size(mime string, head []byte, tail func(int64, int) ([]byte, error), size int64) (w, h int, err error)

规范取值与判定（**判的是字节，不是 Content-Type、不是扩展名、不是文件名**）：

| mime | 判定字节 | 出现位置 | 尺寸来源 |
|---|---|---|---|
| image/png | `89 50 4E 47 0D 0A 1A 0A` | 0..8 | IHDR（偏移 16 起 8 字节大端，宽在前） |
| image/jpeg | `FF D8 FF` | 0..3 | 扫段：`FF C0/C1/C2/C3/C5/C6/C7/C9/CA/CB/CD/CE/CF` 的 SOFn 载荷 +1..+4 是高度与宽度；`FF D8` 与填充 `FF` 跳过；`FF D9`/`FF DA`(SOS) 之前没找到就报错 |
| image/gif | `GIF87a` / `GIF89a` | 0..6 | 逻辑屏幕描述符偏移 6 起 4 字节小端（宽、高），第 1 帧尺寸 |
| image/webp | `RIFF` + `WEBP` | 0..4 / 8..12 | 看 `VP8 `（有损）/ `VP8L`（无损）/ `VP8X`（扩展）三个 chunk，各自解析；VP8X 偏移 24 起 6 字节（24 位小端宽-1、高-1） |

- 前 30 字节之内就能定类型；JPEG 的 SOF 可能远在文件里（EXIF/ICC 在前），所以 `Size` 收一个 `tail(off, n)` 读回调，扫描时按需往前读，**不把 2MB 全读进内存**（其实上限 2MB 读进来也行，但那样 `Store.Put` 就得额外返回整块字节，接口变脏）。
- 解析不出尺寸 ⇒ 上传失败（`media.bad_type`，msg 里写清「这是哪种格式、但尺寸读不出来」）。**尺寸不许留 0**，否则 §2 的 `cover_width/height` 与前端 CLS 容器都拿不到值。

**SVG 的拒绝路径**：`Sniff` 返回 false，而且错误信息必须能被人读懂（前端直接展示）。三句话按优先级判：

    "<svg" / "<?xml" 出现在前 1024 字节（去掉 BOM 与空白后）→ "不支持 SVG 图片（SVG 可以内嵌脚本），请上传 PNG / JPEG / GIF / WebP"
    Content-Type 声称是图片但魔数不是          → "文件内容不是图片（可能改了扩展名），只接受 PNG / JPEG / GIF / WebP"
    其余                                        → "只接受 PNG / JPEG / GIF / WebP 图片"

### 1.4 分发：`GET /img/{hash}`

不是 `/api/v1` 前缀（前端固定拿 `/img/<hash>`，**前端方案** 行 21）。

    1. hash 长度不是 64 或非十六进制 → 400 media.bad_type（不是 404：这是格式错）
    2. 查 images 行（见 §3.1 的 SQL）：
       无行 → 404（历史上存在过的 hash 才会走到这里；裂图无所谓，因为它本来就不存在）
    3. 可见性判定（**判定顺序见 §3.4**）：
       放行 → 生产：X-Accel-Redirect 到 /_img/<ab>/<cd>/<hash>，响应体为空，带
                    Content-Type: <images.mime>、Cache-Control: public, max-age=31536000, immutable
              开发（image.serve_locally=true）：直接 io.Copy 字节，同样带头
       拒绝 → 200 + 占位图 PNG + Cache-Control: no-store + X-Img-Denied: 1
              **绝不返回 404**（禁止事项 22：<img> 只会画成裂图），**绝不带 immutable 缓存**
    4. 文件不在盘上（行在文件丢）→ 500 + 日志 Error（这是运维事故，不是用户错）

**Content-Type 必须由 Go 给，不靠 nginx 猜**：文件是无扩展名的 sha256。nginx 的 `default_type` 会把它们发成 `application/octet-stream`，浏览器就不显示图片了 —— 这正是旧站「按 MIME 分目录四条 internal location」要解决的问题。我们改用一个更省的办法（少 4 条 location、少一层目录）：

    location /_img/ { internal; alias /srv/forum/data/images/; types { } default_type application/octet-stream; }
    # types{} 清空 mime.types → nginx 不会覆盖上游给的 Content-Type；
    # 上游（Go）已经按 images.mime 给对了。

占位图的三档文案（服务端 embed 的固定 PNG，不是每次现画）：`level=1`「登录后可见」、`level=2`「仅本人可见」、其它权限不足「无权查看」。带宽上每次 ~2KB，可接受；**不做按 hash 缓存图片**（缓存什么内容都不能缓存「无权」这个结论）。

---

## 2. images 表与引用计数

### 2.1 数据表（可直接执行；手写迁移 `migrations/postgres/0002_media.sql`）

    -- sha256 十六进制。用 text + CHECK 而不是 char(64)：bpchar 有补空格比较与 length() 语义，
    -- 与「摘要就是 64 个字符」这件事不等价（**盲审-建模** 185）。
    CREATE TABLE images (
      hash        text PRIMARY KEY CHECK (hash ~ '^[0-9a-f]{64}$'),
      size        bigint      NOT NULL CHECK (size > 0),
      mime        text        NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/gif','image/webp')),
      width       int         NOT NULL CHECK (width  > 0),
      height      int         NOT NULL CHECK (height > 0),
      refcount    int         NOT NULL DEFAULT 1 CHECK (refcount >= 0),
      -- 枚举一律 text + CHECK（**数据库文档** §2 全局约定 6）：smallint 会让 §12 第 4 条「枚举值域自检」永远看不到它
      visibility  text        NOT NULL DEFAULT 'public' CHECK (visibility IN ('public','login','private')),
      owner_id    bigint      NULL REFERENCES users(id) ON DELETE SET NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now()
    );
    -- GC 扫描用；只索引归零的行（部分索引是常规武器，全局约定 15）
    CREATE INDEX idx_images_gc         ON images (updated_at) WHERE refcount = 0;
    -- 外键索引：PG 不自动建（全局约定 10）。SET NULL 也要扫这一列。
    CREATE INDEX idx_images_owner      ON images (owner_id);

    -- 默认头像池。refcount 恒为 0，靠 GC 的 NOT EXISTS 排除，见 §2.3 的 gc SQL。
    CREATE TABLE default_avatars (
      hash       text PRIMARY KEY REFERENCES images(hash) ON DELETE CASCADE,
      sort       int  NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- users 的两处加列（users 表本身归 D1/账号域，这里只登记 D5 依赖的改动）
    ALTER TABLE users ADD COLUMN default_avatar_hash text NULL REFERENCES images(hash) ON DELETE SET NULL;
    CREATE INDEX idx_users_default_avatar ON users (default_avatar_hash);

### 2.2 引用计数：加/减的**唯一时机表**

| 引用 | 加（+1，与引用行同一事务） | 减（−1，与引用行删除/替换同一事务） | 边界 |
|---|---|---|---|
| 帖子配图 | `POST /topics/{id}/images`：写 `topic_images` 前 upsert `images`（§2.3 SQL） | `DELETE /topics/{id}/images/{hash}`：删 `topic_images` 行后 `refcount-1` | 同一帖同一图**只能一行**（PK `(topic_id,image_hash)`），所以「加两次」不可能发生 |
| 头像 | `POST /me/avatar`：旧的 `avatar_hash` 非空则先 −1，再 upsert 新图 +1，最后写 `users.avatar_hash` | `DELETE /me/avatar`：置 NULL 并 −1 | 用户行**永不硬删**（会脏读：删用户时 `owner_id`/引用列 SET NULL，refcount 不会自动减 —— **这是已知缺口**，见 §12.3 未决 4） |
| 小图 | 同头像，作用于 `users.avatar_small_hash` | 同上 | `avatar_small_hash` 恒为 NULL 时一切照旧（我们不自建缩略图） |
| 收款码 | `POST /me/payment-channels`：upsert +1 + 写 `payment_channels` 行 | `DELETE /me/payment-channels/{id}`：删行后 −1 | 每用户 ≤5（§3.4）|
| 分区封面 | D1 的 `boards.cover_hash`（不属本域） | 同上 | 本域只提供 §4.2 的小接口给它们调 |
| 默认头像池 | **不加**（插入池时 refcount 保持 0） | **不减**（移出池只删 `default_avatars` 行） | 靠 GC 的 `NOT EXISTS` 保护，见下 |

**三条不变量**：

1. `refcount = 以它为引用行的行数`，默认头像池不算引用（它在 GC 里是排除项，不是计数项）。这条由 §11.3 的对账 SQL 兜底，不在运行时检查。
2. **减到 0 才可能被回收**；减的操作永远是 `refcount = refcount - 1`（不是写死值），并发下不会丢。
3. `refcount = 0` 的行**立刻保留**，盘上文件由 image:gc 删；也就是说「refcount 归零」到「文件消失」之间有一段窗口，期间 `/img/{hash}` 仍然能读出内容（行还在）。这是有意的：先删行会让正在进行中的读取失败。

### 2.3 真实 SQL（`internal/media/repo.go`，走 ent 的 `ExecContext`）

**A. 入库/去重（同 hash 二次上传）—— upsert 而不是「先查再插」**

    INSERT INTO images (hash, size, mime, width, height, refcount, visibility, owner_id, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, 1, $6, $7, now(), now())
    ON CONFLICT (hash) DO UPDATE
       SET refcount   = images.refcount + 1,
           updated_at = now()
    RETURNING refcount, visibility, owner_id, size, mime, width, height;
    -- 索引：hash 是主键 → 唯一索引查找，1 行。ON CONFLICT 只在唯一索引上做，不会 seq scan。

为什么必须 upsert（**盲审-建模** 98）：默认值 1 把「上传成功」和「被引用一次」混为一谈；两个用户上传同一张图时，第二次插入会撞主键（如果写成裸 INSERT），或把 refcount 留在 1（如果写成 DO NOTHING）——两种都错。

**B. 解引用 —— 一行，带下界**

    UPDATE images SET refcount = refcount - 1, updated_at = now()
     WHERE hash = $1 AND refcount > 0
    RETURNING refcount;
    -- 没有行返回 = 调用方算错了引用（日志 Error），不是用户错误：内部调用之间不加防御。

**C. image:gc（定时任务，每天一次；幂等）**

    -- ① 有行归零 → 删盘、删行；默认头像池里的不删
    SELECT hash, refcount FROM images i
     WHERE i.refcount = 0
       AND i.updated_at < now() - interval '1 hour'          -- 给「行已写、文件刚 rename」留窗口
       AND NOT EXISTS (SELECT 1 FROM default_avatars d WHERE d.hash = i.hash)
     ORDER BY i.updated_at
     LIMIT 500;
    -- 吃 idx_images_gc（部分索引，predicate 完全命中，索引里按 updated_at 排序 → 天然有序，无 sort 节点）

    DELETE FROM images WHERE hash = $1 AND refcount = 0;     -- 删盘成功后执行；盘删失败只记 Warn，下一轮重试

    -- ② 磁盘上有文件但没有行 → 孤儿（Put 成功但事务回滚、导入中途失败）
    --    由 Store.Walk 拿全量 hash，按 500 一批：
    SELECT hash FROM images WHERE hash = ANY($1::text[]);    -- 主键索引，每 hash 一次索引查找
    --    不在结果里的 → os.Remove；**只删 mtime 超过 24h 的**（避免删掉正在 Put 的文件）

**D. 默认头像池的读（唯一一次）**

    SELECT hash FROM default_avatars ORDER BY sort, hash;
    -- 表只有几十行、全表顺序扫是正确计划（不走索引才对）。启动时读一次进内存，
    -- 不在注册热路径上查库；池子变了要重启（管理员改池子后提示一次重启，见 §8.4）。

**E. 首图封面（列表/详情都要，见 §4.1）**

    SELECT ti.topic_id, ti.image_hash, i.width, i.height, i.mime
      FROM topic_images ti JOIN images i ON i.hash = ti.image_hash
     WHERE ti.topic_id = ANY($1::bigint[]) AND ti.sort = 0;
    -- 复合主键 (topic_id, image_hash) 不能直接服务 (topic_id, sort=0)：见 §4.1 的 uq 索引。
    -- 一批 topic id 一次查完（列表页 20 条 = 1 次往返），不做 N+1。

---

## 3. 三个上传端点与可见性

### 3.1 端点、限额、请求体上限

| 方法 | 路径 | 单文件上限 | 数量 | 请求体上限（MaxBytesReader） | 可见性 |
|---|---|---|---|---|---|
| POST | `/api/v1/me/avatar` | 64 KiB | 替换（1） | `64KiB + 4KiB` = 69632 | `public` |
| POST | `/api/v1/topics/{id}/images` | 2 MiB | 每帖 ≤ 9 | `2MiB + 4KiB` = 2101248 | `public` |
| POST | `/api/v1/me/payment-channels` | 512 KiB | 每用户 ≤ 5 | `512KiB + 4KiB` = 528384 | **`private`** |
| DELETE | `/api/v1/me/avatar` · `/api/v1/topics/{id}/images/{hash}` · `/api/v1/me/payment-channels/{id}` | — | — | 默认 1 MiB | — |

- 请求体**按路由设上限**，不是全局 1MB（**后端方案** §9.6）。请求体是 `multipart/form-data`，所以给文件上限留 4KiB 的边界与表单头余量；**服务端判的是 `Store.Put` 读到的真实字节数**，不是 `Content-Length`、不是 `part.Header`（客户端说什么都不算）。`MaxBytesReader` 只负责在客户端撒谎之前把连接掐断。
- 超上限 → `413 media.too_large`（`MaxBytesReader` 触发的读错误也映射到同一个码，见 §10）。
- 图片可以整块读进内存（上限 2MB）——这是设计边界，不是妥协（**后端方案** §10.2）。
- 上传限流 `media:upload:user:<id>` = 30 次 / 10 分钟（**后端方案** §9.4，用 `ratelimit`，Redis 故障时拒绝放行）。

### 3.2 三个端点的业务规则

**POST /me/avatar**
1. `auth.RequireLogin` + service 层 `authz` 兜底（登录即可，无权限点）；
2. 未激活/未验证写操作一律 403（`auth.email_unverified` / `auth.not_activated`，账号域判定，本域只调用）；
3. `Put` → 得 `hash,size`；`head` 字节给 `imgsize.Sniff/Size`；
4. 事务：§2.3-A upsert（`owner_id = actor.UserID`、`visibility='public'`）→ 若旧 `avatar_hash` 非空则 §2.3-B −1 → `UPDATE users SET avatar_hash=$1, avatar_small_hash=NULL`；
5. 201 `{ hash, url, width, height, size }`；**重复上传同一张图返回 200**（内容未变），不返回 201。

**DELETE /me/avatar**：事务内置 NULL 两列 + 旧 hash −1；204。

**POST /topics/{id}/images**
1. 权限点 `topic.create`（路由层声明 + service 兜底）；作者本人或持 `topic.delete.any`；
2. 主题必须 `visibility='normal'`；`kind` 不限（三类帖子都可配图）；
3. 数量闸门与插入**同一事务**，靠主题行锁串行化：

       SELECT id FROM topics WHERE public_id = $1 FOR UPDATE;      -- 行锁：(id) 主键查找
       SELECT count(*) FROM topic_images WHERE topic_id = $2;      -- uq 索引前缀，最多 9 行
       -- count >= 9 → 400 media.limit_reached（"每帖最多 9 张"）

   **为什么锁主题行**：两个并发请求各读 count=8，会双双插入得到 10 张。锁一行没有性能代价（同一个主题的配图本来就是串行的），比 `SERIALIZABLE` 或重试循环便宜得多。
4. `put` 在事务**外**（事务里禁止落盘，规则 5.4/14.6）；先把文件写完，再开事务做「锁 → 计数 → upsert images +1 → insert topic_images」。
   - 事务回滚时文件留在盘上、没有 images 行 → 由 image:gc 的孤儿扫描兜底（§2.3-C②），**不需要补偿逻辑**。
5. `sort` 取 `COALESCE(MAX(sort)+1, 0)`，落在 0..8。

**POST /me/payment-channels**
1. `label varchar(32)` 必填（空则用「收款码」），去控制字符；
2. 数量 ≤5，同样用 `SELECT id FROM users WHERE id=$1 FOR UPDATE` 串行化（比锁表简单，且用户行本来就要写别的列）；
3. visibility 写 `login`（老站那一档），**不接受请求里传 visibility**；真正管「能不能对外看到」的是作者侧的展示开关，判定在读路径上（§3.3）；
4. 事务：upsert +1 → insert 行；返回 201。

**DELETE /me/payment-channels/{id}**：`DELETE ... WHERE id=$1 AND user_id=$2 RETURNING image_hash`（**归属判定在 WHERE 里**，0 行 = 404）+ 同事务 −1。

### 3.3 收款码：档位是登录可见，闸是「按渠道显示」的展示开关（2026-10-14 第三轮拍板，本条已改）

老站的真缺陷（**功能清单** 12.9）：`add_payment_channel` 只写 `payment_channels`，`/img/{hash}` 只认 `post_images` 登记过的 hash → **收款码上传成功但一律 404，设置页与打赏弹窗都是裂图**。根因是「图片的读取路径」有第二份实现。

新设计里这个缺陷在结构上不可能发生：**只有一条读路径 `/img/{hash}`，它查的是 `images` 这一张表**；`payment_channels` 与 `topic_images` 一样只是引用行。收款码能不能被某个人看见，由 `images.visibility` 一列 + 一条**读路径上的调档规则**回答，不由「谁上传的」回答。

**本条已被 2026-10-14 第三轮拍板改写**（用户原话「必须显示，按渠道显示，参考老网站」/「L1 按照之前要求的方式做，不准偏移」，执行口径见 `进行中/08-拍板记录.md`）：

    // AddPaymentChannel：引用行写 VisibilityLogin（= 老站那一档），
    // canView（唯一一份判定）在**读路径上**调档：
    //   作者本人 / 超管      → 放行（设置页要预览自己的码）
    //   其余人（含**游客**）  → 看作者侧 user_donation_settings.show_channels：
    //                          开着放行、关着给占位图

三条理由，逐条对上老站实现：

1. **档位不是上传那一刻定死的**：老站（`site/crates/sc2clud-web/src/pages_profile.rs:93-94`）上传时写的是 `set_blob_visibility(..., 1)` = **登录可见**，而「要不要对外展示」由设置页的展示开关管（`pages_settings.rs:253-275`）。判定要在**读**这一侧做，否则「先上传码、之后再打开开关」这个常规顺序后面，访客拿到的仍然是占位图 —— 那正是打赏面板扫不出码的现象。
2. **扫码付款不需要账号**：打赏者与**游客**都必须真取到图（用户两次强调的验收线）。所以 `show_channels` 开着时不给 login 档留后门：读路径直接放行。
3. **关掉展示是真的关掉**：把档位写死成 `public`（2026-10-14 一次实现的做法）会让档位与开关脱钩 —— 作者关掉展示之后图仍然对全站可读，而渠道列表同时回空数组。档位与开关必须同生共死（`forum/internal/media/repo.go` 的 `channelImageWithDisplayOn`）。

**核验队列**照旧要能看到码：放行条件里带 `reward.verify`（§3.4 的两个管理员入口之一），不靠放宽可见性。

### 3.4 可见性判定（唯一一份；§2.2 是计数的时机表，别混）

    func canView(actor *authz.Actor, img ImageMeta) bool {
        switch img.Visibility {
        case VisibilityPublic:  return true
        // login：收款码那一档。**不是**「登录就可见」—— 作者本人 / 超管放行，其余人（含游客）
        // 由作者侧的 show_channels 展示开关决定（§3.3，2026-10-14 第三轮拍板）。
        case VisibilityLogin:   return img.OwnerID == actor.UserID || actor.IsSuper || channelDisplayed(img)
        // private：作者与管理员，外加**帖子配图那一条** —— 所属主题公开
        // （visibility='normal' AND review_state='approved'）之后对所有人放行。
        // 「未过审不外泄、过审后可见」靠这一条成立，帖子过审不需要重传图片，也没有谁去翻档。
        case VisibilityPrivate: return actor != nil && (actor.UserID == img.OwnerID || actor.IsSuper || actor.Perms.Has(authz.PermRewardVerify) || topicImageLive(img))
        }
        return false
    }

- `IsSuper` 短路与 `PermRewardVerify` 是「管理员」在这条路径上的两条入口（超管不一定持有 `reward.verify`）；
- 判定放 service，`/img/{hash}` 的 handler 只做「解析 hash → 调 service → 写响应」。

---

## 4. 帖子配图关联与「首图封面」

### 4.1 topic_images

    CREATE TABLE topic_images (
      topic_id   bigint NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
      image_hash text   NOT NULL REFERENCES images(hash) ON DELETE RESTRICT,
      sort       smallint NOT NULL DEFAULT 0 CHECK (sort BETWEEN 0 AND 8),
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (topic_id, image_hash)
    );
    -- 封面/顺序：部分索引顺便当 (topic_id, sort) 的唯一约束，两件事一个索引
    CREATE UNIQUE INDEX uq_topic_images_sort ON topic_images (topic_id, sort);
    -- 外键索引：复合主键的第二列不算「已索引」（自检 SQL 口径），CASCADE 删主题时会全表扫
    CREATE INDEX idx_topic_images_hash ON topic_images (image_hash);

- `sort BETWEEN 0 AND 8` 与「每帖 ≤9」是同一个事实的两种表达，一起写死。
- `uq_topic_images_sort` 让「同一帖子里两张图 sort 相同」不可能出现 —— 没有它，封面是哪张是**未定义**的。
- 列表页取封面的 SQL 见 §2.3-E：`(topic_id, sort=0)` 正好是 `uq_topic_images_sort` 的前缀 + 常量，等价于唯一索引上的等值查找（PG 能用部分条件做 index cond，不扫别的 sort）。

### 4.2 响应字段（D5 对外）

    // 帖子/主题详情、列表项里的图（**前端方案** 的 cover 与 **界面施工** §4.2 的 cover_width/height）
    cover:        "/img/<hash>" | null
    cover_width:  int | null      // 来自 images.width
    cover_height: int | null

    images: [{ hash, url, width, height, sort }]      // 详情页

- `cover_width/height` 必须给（**界面施工** §4.2）：不给前端就要靠 `naturalWidth` 兜底，多一次布局判定并撞 CLS 硬要求。
- 返回的是 `url` 字符串而不是裸 hash：前端只拿 `/img/<hash>`，不做拼接（**前端方案** 行 21、396）。

### 4.3 给其它域的引用小接口

默认头像与头像路径上的引用只有 `users` 两列 + `boards.cover_hash`（D1）+ `topic_images`（本域）。区别是「谁负责 ±1」：**引用行在谁的表里，谁负责在同一事务里调 ±1**。所以 `media.Service` 暴露两个方法给 D1/D2 用：

    // 供 boards / users 等表在自己事务里引用图片
    func (s *Service) IncRefTx(ctx context.Context, tx *ent.Tx, h image.Hash) error      // §2.3-A 的 upsert（不带 owner 覆盖）
    func (s *Service) DecRefTx(ctx context.Context, tx *ent.Tx, h image.Hash) error      // §2.3-B

**没有**「批量引用」「引用检查」之类的导出：现在只有两个调用方。

---

## 5. 下载（release）

### 5.1 数据表（手写迁移 `0003_release.sql`）

    CREATE TABLE releases (
      id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      public_id    uuid        NOT NULL UNIQUE,
      version      varchar(32) NOT NULL UNIQUE,          -- 全局唯一（见 §12.3 未决 3）
      channel      text        NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable','beta')),
      notes_md     text        NOT NULL DEFAULT '',
      notes_html   text        NOT NULL DEFAULT '',      -- goldmark + bluemonday，与帖子同一套
      published_at timestamptz NULL,
      status       text        NOT NULL DEFAULT 'draft'  CHECK (status IN ('draft','published','archived')),
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
    -- 「最新 stable」+「历史版本列表」共用一条：status/channel 等值 + published_at 倒序 + id 兜底
    CREATE INDEX idx_releases_latest ON releases (status, channel, published_at DESC, id DESC);

    CREATE TABLE release_assets (
      id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      public_id      uuid        NOT NULL UNIQUE,
      release_id     bigint      NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
      platform       varchar(16) NOT NULL,                -- windows / macos / linux
      arch           varchar(16) NOT NULL,                -- x86_64 / arm64
      url            text        NOT NULL CHECK (url ~ '^https?://'),   -- 只收 http(s)
      size           bigint      NOT NULL DEFAULT 0 CHECK (size >= 0),
      sha256         text        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
      download_count bigint      NOT NULL DEFAULT 0 CHECK (download_count >= 0),
      created_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX uq_release_assets_slot ON release_assets (release_id, platform, arch);
    CREATE INDEX idx_release_assets_release   ON release_assets (release_id);   -- 外键索引
    ALTER TABLE release_assets SET (autovacuum_vacuum_scale_factor = 0.02,
                                    autovacuum_vacuum_threshold    = 1000);     -- count 每 15s 更新（**盲审-运行** 73）
    ALTER TABLE releases       SET (autovacuum_vacuum_scale_factor = 0.02,
                                    autovacuum_vacuum_threshold    = 1000);

- `url` 的 CHECK 是**信任边界校验**（管理员录入的外部 URL），不是「内部防防御」：没有它，一条 `javascript:` 或 `file:` 的直链会变成开放重定向/协议走私。录入时 Go 侧再用 `url.Parse` 复核一次 scheme ∈ {http,https}，并拒绝带 userinfo 的 URL。
- `varchar(16)` 的 platform/arch 不做 CHECK 枚举：以后加平台不该改迁移（与 `boards` 表驱动的理由一致）。
- 表上**没有字节**：`url` 是外部直链，本站只做 302（AGENTS §8、后端方案第 11 章）。

### 5.2 302 转链与计数

    -- GET /api/v1/launcher/assets/{public_id}/go
    SELECT a.id, a.url, r.status
      FROM release_assets a JOIN releases r ON r.id = a.release_id
     WHERE a.public_id = $1;
    -- uq_release_assets_public（public_id UNIQUE）单行查找，再按 release_id 主键回查 releases：2 次索引查找。

    status <> 'published' → 404（草稿与归档不对外）
    counter.Add("release:asset:"+id, 1)        // 内存 map，key 用 bigint 的十进制串
    302 Location: a.url   +  Cache-Control: no-store

**计数绝不每请求 UPDATE**：`counter.Buffer` 内存累加，每 15 秒批量写回：

    UPDATE release_assets
       SET download_count = download_count + v.n
      FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::bigint[]) AS n) v
     WHERE release_assets.id = v.id;
    -- 主键索引，每行一次索引查找。回写后清空内存 map（先写库再清，见 §5.4 的失败语义）。
    -- counter 的写回 SQL 归 internal/release/tasks.go（业务表不是 platform 的事）。

**并发/重放**（问题 2）：同一个访客连点两次 = 两次 302、计数 +2。这是**想要的**（下载数就是点击数），不做幂等键。任务重试两次呢？写回不是任务，是进程内定时器 —— 进程崩溃丢的只是最近 ≤15 秒的增量（**后端方案** §7.5 已接受），不会把已写回的再加一遍（`UPDATE ... = download_count + n` 只在写回成功后清 map）。

### 5.3 读端点

    GET /api/v1/launcher/latest                 最新 published stable + 它的 assets[]
    SELECT r.id, r.public_id, r.version, r.channel, r.notes_html, r.published_at, r.created_at
      FROM releases r
     WHERE r.status = 'published' AND r.channel = 'stable'
     ORDER BY r.published_at DESC, r.id DESC
     LIMIT 1;
    -- 吃 idx_releases_latest 的前三列等值 + 第四列有序 → Index Scan，1 行（无 Sort 节点）。

    GET /api/v1/launcher/releases?channel=&limit=&cursor=     历史版本，游标分页
    SELECT r.id, r.public_id, r.version, r.channel, r.notes_md, r.notes_html, r.published_at, r.created_at
      FROM releases r
     WHERE r.status = 'published'
       AND ($1::text IS NULL OR r.channel = $1)
       AND (r.published_at, r.id) < ($2::timestamptz, $3::bigint)     -- $2/$3 为 NULL 时整条为 NULL → 不限界
     ORDER BY r.published_at DESC, r.id DESC
     LIMIT $4;
    -- 排序键三元组恒为 (published_at DESC, id DESC)，游标就是它的行序比较（**拍板** §5.1）。
    -- 吃 idx_releases_latest：status 等值 + channel 可选 + 后两列有序。channel 为 NULL 时是
    -- 「status 等值 + 后两列有序」的部分有序扫描，仍不需要 Sort。
    -- published_at 可能为 NULL（draft 变为 published 前）——这里 status='published' 一定非 NULL，
    -- 由 §5.4 的状态机保证，不需要 NULLS LAST（写了反而与索引不同序）。

每个 release 的 assets 一次查完（20 个版本 = 1 次往返）：

    SELECT release_id, public_id, platform, arch, url, size, sha256, download_count
      FROM release_assets WHERE release_id = ANY($1::bigint[]) ORDER BY platform, arch;
    -- idx_release_assets_release，每 release 一段连续扫描。

### 5.4 状态机（管理端，端点属管理域，规则属本域）

    draft ──publish──▶ published ──archive──▶ archived
      ▲                    │                    │
      └────unpublish───────┘◀────restore────────┘

- 只有 `published` 有非空 `published_at`（首次 publish 时写一次，之后不改；重新 publish 保留首次时间）。**这一条是 §5.3「published_at 一定非 NULL」的前提。**
- `draft → archived` 允许（录入错了直接归档）。
- `published ↔ archived` 都允许，两端都是幂等的：重复 publish 不改 `published_at`、重复 archive 不改状态 → 第二次是 no-op，返回 200 而不是 409。
- **版本号全局唯一**：两个平台同一个版本共用一行 release（assets 分平台）。已归档的版本号不能复用，改版本号就新建 release。
- 校验：`published` 要求至少 1 个 asset；`version` 形如 `\d+(\.\d+)*([-+][0-9A-Za-z.-]+)?`。

**失败落点**（问题 3）：改状态是单表单行 UPDATE，没有中间态。计数写回失败（DB 抖动）→ 内存 map **不清空**，下一轮（15 秒后）重试同一批；两次失败最多把增量重复累加（因为 `SET download_count = download_count + n` 是增量而非赋值）—— **会多计**，代价可接受（下载数是展示量，不是账）；换成「赋值」则会丢别人的增量，更糟。

---

## 6. 搜索（本域最容易写错的地方）

### 6.1 结论先给（三个必须定死的选择）

| 问题 | 结论 | 为什么不是另一个 |
|---|---|---|
| bigram 在哪切？ | **Go 侧切好再写库**（`internal/platform/search/search.go` 的 `Tokenize`），`topic_search.tokens` 是普通列 | PG 侧表达式（自定义 `IMMUTABLE` 函数或 `regexp_replace`）会把分词逻辑变成 SQL、要超级用户建函数、且在 Windows 开发机上无法单测；用 `pg_trgm` 的 `show_trgm` 又只给三元组。Go 侧切分是纯函数，能写表驱动测试逐字节断言 |
| tsvector 怎么来？ | **生成列** `GENERATED ALWAYS AS (setweight(to_tsvector('simple', title),'A') \|\| setweight(to_tsvector('simple', tokens),'B')) STORED` | 由应用写 `tsv` 会有第二份真源，必然与 tokens 漂移（**数据库文档** §5 的原文，保留） |
| 查询怎么构造？ | `tsv @@ plainto_tsquery('simple', $2)`，`$2` 是**同一个 `Tokenize` 的输出**，走参数占位符 | **禁止**把用户输入拼进 SQL 或拼成 `to_tsquery` 的语法串（`&`/`!`/`:` 会被当成运算符，那是注入面）。`plainto_tsquery` 把整串当纯文本，只做词法分析 |

### 6.2 词素集合 = **单字 + bigram**（review R-D5-1 的定案）

第一版设计只把 bigram 写进 `tokens`，单字查询另走一条 `tokens ILIKE '%大%'` 的兜底。**那是错的**（Lead review R-D5-1）：

- GIN 里匹配的是**词素相等**，不是子串。索引里只存 bigram，单字词素 `大` 永远不会出现在索引里 —— 这才是走不了索引的真正原因，与 pg_trgm 的「模式 ≥3 字符」门槛无关。**那条兜底不是兜底，是另一条永远不快的路**（`tokens` 列每行几 KB，1 万行顺扫几十毫秒，且随数据量线性恶化）。
- 修法：`Tokenize` **每个内容字符也单独输出一个词素**。`Tokenize("大吉大利")` → `大 大吉 吉 吉大 利 大利`。代价是词素数从 n 涨到约 2n（去重后略少）、GIN 大一点；换来的是**单字与多字走同一个 GIN、同一条查询路径**，ILIKE 那条整块删掉。

于是：`tokens` 列里同时有单字与 bigram，**索引侧与查询侧仍然是同一个函数**（这一点没有变，也不许变）。

### 6.3 两档查询：AND 精确、OR 兜底（review R-D5-2 的定案）

只做 AND 太严：查询 `第三章隐藏结局` → bigram `第三 三章 章隐 隐藏 藏结 结局`，要求 6 个词素全部命中，于是「第三章的隐藏结局」搜不到「第三章隐藏结局」、「隐藏结局」也搜不到它 —— 用户会直接认为「搜索是坏的」。定案是**两档、同一个索引、没有第二条数据路径**：

| 档 | 触发条件 | 语义 | tsquery 怎么来 |
|---|---|---|---|
| **档 1 精确** | 总是先跑 | `Tokenize(q)` 的全部词素 AND（与旧设计一致，命中即返回） | `plainto_tsquery('simple', $1)`，$1 = `Tokenize(q)` |
| **档 2 兜底** | **只在档 1 首页 0 行时**执行 | 只用**单字词素**做 OR，配 ts_rank 排序 | `to_tsquery('simple', $1)`，$1 = Go 现场拼的 `难|题` |

- 只在 0 行时降级：AND 命中时它的精度与排序都更好，一旦有结果就不要用 OR 去稀释它。
- **档 2 的 tsquery 串由 Go 拼，但拼的不是用户输入**：输入是 `Tokenize(q)` 里的**单字词素**，而出题器保证每个单字词素只含「内容字符」（`unicode.IsLetter`/`IsDigit`，不含空白、不含 tsquery 的元字符 `& | ! ( ) : * <`），Go 侧再用 `| ` 连接并**断言每个词素只含内容字符**（不在白名单内就整档跳过，返回空结果）。这是与 `plainto_tsquery` 同等级的安全构造：`$1` 仍然是**参数占位符**，不是拼进 SQL 的字符串。
- 为什么单字 OR 而不是「把 bigram 拆成单字再 OR」：bigram 拆出来的还是同一批单字；直接用 `Tokenize` 已经产出的单字词素，不需要第二个函数。
- 为什么不用 `phraseto_tsquery`：bigram 已经用滑窗把相邻性编码进去了，phraseto 是多余的；它也解决不了「丢一个字就命中不了」。
- 档 2 的排序仍然是 `ts_rank(...)`（同 §6.6 的游标方案，同一个 cursor 形状），但**档 1 与档 2 的游标不能混用**（rank 的分布不同），所以响应里带 `tier: "exact" | "loose"`，翻页时前端把上一页的 `tier` 一起带回来；服务端校验 tier 与自己算出来的一致，不一致就从头开始（宁可重复一页，也不给错序的结果）。
- 两档都 0 行 → 200 + `data: []`，前端说「换个关键词」。

**验收必须覆盖四种输入**（只测前三档等于没测）：

| 输入 | 期望 | 证明什么 |
|---|---|---|
| 单字 `难` | 命中含「难」的主题（走**档 1**：`Tokenize("难") = "难"`） | 单字也走 GIN，不是另一条路 |
| 两字 `大吉` | 命中 `大吉大利整合包` | bigram 命中（M8 验收项） |
| 长词整串 `隐藏结局` | 命中标题 `第三章隐藏结局` | 档 1 的 AND |
| 长词丢字 `隐藏的结局` | **仍命中**同一标题 | **档 2 生效的证据** |

### 6.4 分词器（`internal/platform/search`）

    // internal/platform/search/search.go
    package search

    // Tokenize 是索引与查询**唯一**的分词入口。同一个包、同一个函数，不存在第二份实现。
    // 输出：按出现顺序去重的「单字词素 + bigram」，用单个空格连接。
    //   Tokenize("中文搜索")     == "中 中文 文 文搜 搜 搜索 索"      // 单字 + bigram
    //   Tokenize("大吉大利")     == "大 大吉 吉 吉大 利 大利"
    //   Tokenize("Hello, 世界!") == "h he e el l ll lo 世 世界 界"   // 拉丁按码点切、先小写
    //   Tokenize("难")           == "难"                            // 单字查询也走同一个 GIN
    func Tokenize(s string) string

    // 只有这一个导出函数 + 一个上限常量。不导出切分器结构体、不给可选项
    // （**性能与容量** §5：可切换的双实现必然漂移）。
    const MaxTokens = 20000   // 超出即截断并记 Warn；留 tsvector 1MB 上限的余量

算法（逐步，**顺序即语义**）：

1. 去 BOM；全角 → 半角（`Ａ`→`a`？不：`Ａ`→`A` 之后再小写；全角空格 → 半角空格）；
2. `unicode.ToLower`；
3. 逐码点归类：
   - CJK 表意文字（U+3400–4DBF、U+4E00–9FFF、U+F900–FAFF、U+20000–2FA1F）、平假名/片假名（U+3040–30FF）→ **内容字符**；
   - `unicode.IsLetter` 或 `unicode.IsDigit` → **内容字符**（拉丁、西里尔、希腊字母都算）；
   - 其它（空白、标点、符号、emoji）→ **分隔符**（写成空格）；
4. 切成「连续内容字符的片段」；
5. 每个片段取长度 2 的滑窗（码点级，不是字节级）：`[a b c]` → `ab bc`；长度 <2 的片段丢弃；
6. 去重（保留首次出现顺序），超 `MaxTokens` 截断；
7. `strings.Join(tokens, " ")`。

**为什么「切成片段」而不是「整串滑窗」**：`中文 搜索` 整串滑窗会得到无意义的跨界 bigram（`文搜`）——那会让 AND 查询把两个不相邻的词判成命中。分段后才与「相邻两字」严格对应。

**为什么单字与两字词一定命中**（M8 验收项）：

- 两字：查询 `大吉` → `Tokenize` → `大 吉 大吉`；标题 `大吉大利` → `大 大吉 吉 吉大 利 大利`。两边都含 `大`/`吉`/`大吉` → `@@` 命中（档 1 的 AND 全部满足）。
- 单字：查询 `难` → `难`；任何含「难」的主题在 `tokens` 里都有 `难` 这个词素 → 命中。**不再需要 ILIKE 兜底**。
- 注意 `to_tsvector('simple', …)` 对 CJK 不做切分（没有空白/标点分隔时整串是一个「词」）——所以标题 `大吉大利` 在 **title 那一支**里是词素 `大吉大利`，与查询词素 `大吉` **不相等**；命中来自 `tokens` 那一支。**这就是「词素相等判定的支点必须落在 tokens 上」**，也是 `tokens` 非空是硬要求的原因。
- 两种解析行为（CJK 整串一个词 / 逐字切）都能得到同样的匹配结论：因为 `tokens` 里两种粒度的词素都有。

### 6.5 topic_search 表（手写迁移 `0004_search.sql`）

    CREATE TABLE topic_search (
      topic_id   bigint PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE,
      title      varchar(200) NOT NULL,
      body_text  text NOT NULL DEFAULT '',     -- 1 楼正文的纯文本（去 markdown），可重建
      tokens     text NOT NULL DEFAULT '',     -- Tokenize(title + ' ' + body_text)
      tsv        tsvector
                 GENERATED ALWAYS AS (
                   setweight(to_tsvector('simple', title),  'A') ||
                   setweight(to_tsvector('simple', tokens), 'B')
                 ) STORED,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_topic_search_tsv ON topic_search USING gin (tsv);
    -- **只有这一个 GIN**：单字与 bigram 都在 tokens 里，两种查询都走它。
    -- 没有 tokens 的 trgm 索引 —— R-D5-1 把 ILIKE 那条路整块删掉了（它永远走不了索引）。
    ALTER TABLE topic_search SET (autovacuum_vacuum_scale_factor = 0.02,
                                  autovacuum_vacuum_threshold    = 1000);

三项 PG 事实（决定上面 DDL 能不能落地）：

1. `to_tsvector(regconfig, text)` 与 `setweight(tsvector, "char")` 都是 `IMMUTABLE` → 可以进生成列；`tsvector || tsvector` 也是。
2. 生成列**只能**引本行列；`title`/`tokens` 都是本行列 → 合法。
3. 表达式里 `'A'`/`'B'` 要能隐式转成 `"char"`（PG 里这是 unknown→"char" 的赋值转换，合法）。

**写放大**（盲审-运行 107）：单字 + bigram 让 `tokens` 的字符数约为标题+正文的 **2 倍**（去重后略少），这是 R-D5-1 明确买下的代价（换「单字也走 GIN」）。一行里存 `title` + `body_text` + `tokens` + 生成列 `tsv`，外加两个 GIN。这是有意的：`body_text` 是重建 `tokens` 的必要输入（编辑标题时不能只改 title 那一支），`tokens` 是查询侧 AND 的支点，`tsv` 是索引。可省掉的只有 `body_text`（改成每次从 `posts.content_html` 重算纯文本），代价是每次重建都要读 1 楼正文、且「纯文本怎么抽」这件事会有第二处实现 —— **不省**。

### 6.6 完整搜索 SQL（internal/platform/search/pgsql/pgsql.go）

**档 1（精确，AND）—— 总是先跑**：

    -- 只通过 search.Searcher 暴露给业务；SQL 本体只在这个包里（**开发必读** §1 硬规则 8 的落地）
    SELECT t.id,
           t.public_id,
           t.title,
           ts_rank(s.tsv, plainto_tsquery('simple', $1)) AS rank
      FROM topic_search s
      JOIN topics t ON t.id = s.topic_id
     WHERE s.tsv @@ plainto_tsquery('simple', $1)
       AND t.visibility   = 'normal'
       AND t.review_state = 'approved'
       AND ($2::bigint IS NULL OR t.board_id = $2)                  -- 可选分区筛选
       AND (
             $3::real IS NULL                                        -- 第一页
             OR (ts_rank(s.tsv, plainto_tsquery('simple', $1)), t.id) < ($3::real, $4::bigint)
           )
     ORDER BY rank DESC, t.id DESC
     LIMIT $5;
    -- $1 = search.Tokenize(q)（单字 + bigram，空格分隔）
    -- $2 = board_id，$3/$4 = 游标（rank 的 float4、topic 内部 id），$5 = limit

**档 2（兜底，OR，只在档 1 首页 0 行时跑）**：

    SELECT t.id, t.public_id, t.title,
           ts_rank(s.tsv, to_tsquery('simple', $1)) AS rank
      FROM topic_search s
      JOIN topics t ON t.id = s.topic_id
     WHERE s.tsv @@ to_tsquery('simple', $1)
       AND t.visibility = 'normal' AND t.review_state = 'approved'
       AND ($2::bigint IS NULL OR t.board_id = $2)
       AND ($3::real IS NULL
            OR (ts_rank(s.tsv, to_tsquery('simple', $1)), t.id) < ($3::real, $4::bigint))
     ORDER BY rank DESC, t.id DESC
     LIMIT $5;
    -- $1 = Go 用 Tokenize(q) 里的**单字词素**以 "|" 连接（例如 "难|题"）。
    -- 拼接前逐词素断言「只含内容字符」（unicode.IsLetter/IsDigit），不在白名单内的词素整档跳过。
    -- $1 仍然是参数占位符：**没有把用户输入拼进 SQL**。

**参数与游标编码**：`ts_rank` 返回 `real`（float4）。游标 `k` 存 `math.Float32bits(rank)` 的十进制整数串（避开 NaN 与负零的表示歧义），`id` 存内部 bigint。二者进 `base64url(JSON{k,id})`（拍板 §5.1）。响应里另带 `tier`（`exact`/`loose`），翻页时必须原样带回；服务端发现自己算出的 tier 与请求里的不一致就从第一页重来（§6.3）。

**吃什么索引、为什么不会 seq scan**（问题 1 的答案）：

| 步骤 | 计划节点 | 行数预期 | 说明 |
|---|---|---|---|
| `s.tsv @@ plainto_tsquery('simple',$1)`（档 1）与 `to_tsquery`（档 2） | Bitmap Index Scan on `idx_topic_search_tsv`（GIN） | 档 1：命中主题数（两字词通常 1–100）；档 2：含任一字词素的主题数（常见字可能上千） | GIN 只回答「哪些行含这些词素」；档 1 的 AND 由 `plainto_tsquery` 的词素集合求交，档 2 的 OR 是词素并集（并集比交集大，这也是它只在档 1 空结果时才跑的原因） |
| 回表 `topic_search` | Bitmap Heap Scan | 同上 | 只取 `topic_id`/`tsv` |
| `JOIN topics t ON t.id = s.topic_id` | **Nested Loop + Index Scan on topics_pkey** | 每命中主题 1 行 | 关键：`topics` 侧**不允许**变成 `Seq Scan + Hash Join`。行数少时优化器一定选 NestLoop；命中全表时可能翻成 Hash Join —— 那时它本来就是「全表都相关」，不是缺陷。EXPLAIN 断言见 §11.1 |
| `t.visibility='normal' AND review_state='approved'` | Filter（NestLoop 内层） | 过滤后 ≤ 命中行 | 走主键取行后过滤。**这就是「越权披露」的堵口**（**盲审 D2**）：过滤发生在返回之前 |
| `ORDER BY rank DESC, t.id DESC` | **Sort（Top-N heapsort）** | 命中行数 | `ts_rank` 不是 IMMUTABLE → 建不了索引，所以每次翻页都要把候选集排一遍（review R-D5-3 已确认当前规模成立）。命中几百行是微秒级；**闸门见 §11.1 第 15/16 条**（命中 >1 万行告警、高频词 <200ms 硬断言） |
| `LIMIT $5` | Limit | 20 | Top-N heapsort 不需要物化全部结果 |

**为什么不在 `topic_search` 上冗余 `visibility/review_state`**：那是第二份状态，必然漂移（**数据库文档** §5 原文）。代价就是上面这次 JOIN 与 Filter —— 换来的是「隐藏/删除/待审内容永远搜不到」这条安全性质**只由一处数据决定**。

**结果补全**：`Searcher` 只返回 `(id, public_id, title, rank)`；`forum` 用列表查询按 id 批量补作者/计数（1 次往返），不在搜索 SQL 里 JOIN 一堆表。

### 6.7 索引任务的触发与幂等

**任务常量**：`queue.TypeSearchIndex = "search:index"`（已存在于 `queue/types.go` 的常量表）。

**触发点**（全部在 forum 域，本域提供能力）：

| 事件 | 动作 | 谁的代码 |
|---|---|---|
| 发主题（含 1 楼） | `EnqueueTx(unique_key="topic:"+id)` | forum（D3） |
| 改标题 / 改 1 楼正文 | 同上 | forum |
| 主题可见性或审核态变化（hide/delete/review/reject） | 同上 | forum |
| 删 1 楼 / 删主题 | 同上 | forum |
| 回填（重建全站索引） | `forum search:reindex` 子命令，分批入队 | 本域（S7 验收前跑一次） |

**为什么不是「发帖时同步写」**：写索引要读 1 楼正文 + 两次 tsvector + 两个 GIN 更新，是发帖事务里最重的一段；放进 `EnqueueTx` 只多一行 INSERT（与业务同事务，任务不会丢）。

**任务处理函数（幂等，任何一次重放结果相同）**：

    5. payload = {id: <topic bigint>}（最小形状，拍板 §5.7）
    6. SELECT t.title, t.visibility, t.review_state, p.content_html
         FROM topics t JOIN posts p ON p.topic_id = t.id AND p.floor = 1
        WHERE t.id = $1;
    7. 无行（主题已硬删/不存在）→ DELETE FROM topic_search WHERE topic_id=$1 ; return nil
    8. 状态不是 (normal, approved) → DELETE FROM topic_search WHERE topic_id=$1 ; return nil
       （**这就是「pending/rejected/hidden/deleted 搜不到」的写入侧保证**；查询侧 §6.6 再兜一次，
         两边都做是因为「软删后任务失败」不能变成泄漏）
    9. body_text = forum.PlainText(content_html)          （去标签 + 解实体 + 折叠空白）
    10. tokens    = search.Tokenize(title + " " + body_text)
    11. §6.8 的 upsert
    12. return nil（重放：同样的输入 → 同样的 tokens → 同一行，无副作用）

**unique_key 与去重**：`"topic:<id>"`。队列的 `uq_jobs_unique_key` 只在 `status IN ('pending','running')` 上唯一；冲突时**静默跳过**（`ON CONFLICT DO NOTHING`，**盲审 M5** 的定案），绝不让它回滚发帖事务。所以连发 10 次编辑 = 最多 1 个待执行任务 + 执行期间再排 1 个。

**失败与重试**：读主题失败/写库失败 → 返回原始错误 → 队列退避重试（10s×2^n，上限 1h，最多 5 次）→ dead。dead 意味着「这条主题搜不到」，由 `forum check` 的一条对账发现（§11.3-5）。

### 6.8 索引写入 SQL（`internal/platform/search/pgsql`）

    INSERT INTO topic_search (topic_id, title, body_text, tokens, updated_at)
    VALUES ($1, $2, $3, $4, now())
    ON CONFLICT (topic_id) DO UPDATE
       SET title = EXCLUDED.title, body_text = EXCLUDED.body_text,
           tokens = EXCLUDED.tokens, updated_at = now();
    -- topic_id 是主键 → 唯一索引查找；生成列 tsv 自动重算，两个 GIN 增量更新。
    -- 并发两个任务写同一主题：后到者覆盖，两边内容相同 → 结果一致（幂等）。

    DELETE FROM topic_search WHERE topic_id = $1;   -- 主键索引

### 6.9 搜索验收的四种输入（M8 验收项，必须能红）

**① 分词自证**（不碰数据库，纯函数）：

    go test ./internal/platform/search -run TestTokenize -v
    断言：Tokenize("难")     == "难"                              // 单字
         Tokenize("大吉")   == "大 吉 大吉"                        // 两字
         Tokenize("大吉大利") == "大 大吉 吉 吉大 利 大利"           // 单字 + bigram，按出现顺序去重
         Tokenize("")       == ""；Tokenize("a") == "a"
         对 200 条语料断言「连调两次逐字节相同」

**② 索引与查询同源**（集成测试，embedded-postgres）：造一条 topic（title="大吉大利整合包"）→ 跑一次 search:index 任务 → 断言 `SELECT tokens FROM topic_search WHERE topic_id=$1` 与 `Tokenize(title || ' ' || body_text)` **逐字节相同**，再断言档 1 的查询返回该 topic。**这一步能捕到「两边切法不一致」**：若写入侧与查询侧用了不同的分词器，查询返回 0 行 → 红。

**③ 四种输入（R-D5-2 要求四个都测，只测前三档等于没测）**：

| 输入 | 期望 | 走哪档 | 证明什么 |
|---|---|---|---|
| `难` | 命中含「难」的主题 | 档 1 | **单字也走 GIN**（R-D5-1 的修复生效；旧设计这里会走 ILIKE 顺扫） |
| `大吉` | 命中标题 `大吉大利整合包` | 档 1 | bigram 命中（M8 原文验收项） |
| `隐藏结局` | 命中标题 `第三章隐藏结局` | 档 1 | AND 精确档 |
| `隐藏的结局` | **仍命中**同一标题 | **档 2** | OR 兜底生效 —— 丢一个字不再「搜不到」 |

**④ 直接验 SQL**（psql/CI，绕过 Go，证明「不是 Go 侧的假绿」）：

    INSERT INTO topic_search (topic_id, title, tokens)
    VALUES (<id>, '大吉大利整合包', '大 大吉 吉 吉大 利 大利 整 整合 合 合包 包');

    SELECT count(*) FROM topic_search s JOIN topics t ON t.id = s.topic_id
     WHERE s.tsv @@ plainto_tsquery('simple', '大 吉 大吉')          -- 档 1，期望 1
       AND t.visibility = 'normal' AND t.review_state = 'approved';
    SELECT count(*) FROM topic_search s JOIN topics t ON t.id = s.topic_id
     WHERE s.tsv @@ plainto_tsquery('simple', '难')                  -- 单字，期望按夹具
       AND t.visibility = 'normal' AND t.review_state = 'approved';

**⑤ 可见性反例（必须红）**：把该 topic 置 `review_state='pending'` → 上面两条都必须是 0；置 `visibility='hidden'` → 同样 0；把 `topic_search` 行删掉（模拟任务失败后软删） → 仍是 0（查询侧的过滤兜底生效）。这是「搜索不能绕过可见性」的机器证明。

**命令行**（开发与运维排查用）：`forum search:tokenize "<文本>"` 打印词素与每个词素的码点数；`forum search:reindex` 分批重建。两个都不进 HTTP 路由。

### 6.10 用户搜索（`/api/v1/search?type=users`）

不属于搜索索引（不建第二张表）：

    SELECT id, public_id, username, nickname, avatar_hash
      FROM users
     WHERE status = 'active'
       AND (lower(username) LIKE lower($1) || '%' OR lower(nickname) LIKE lower($1) || '%')
     ORDER BY (lower(username) = lower($1)) DESC, lower(username)
     LIMIT 20;
    -- 前缀匹配：`|| '%'` 是**后缀通配**，可以走 btree（lower(username) 上的索引），
    -- 但 LIKE 只有在 C 排序规则或 text_pattern_ops 下才真走索引；本表只有几千行，
    -- 顺扫 + LIMIT 是正确计划（本表几千行）。**不为此加 pg_trgm 索引**：用户搜索走的是 username 前缀，
    -- 与 topic_search 的 tokens 无关，pg_trgm 帮不上（单字搜索已由 §6.2 收进同一个 GIN，不需要 trgm 了）。
    -- nickname 目前没有索引（盲审-建模 15：nickname 非唯一、允许重名）；等用户数上万再加
    -- lower(nickname) 的前缀索引，现在加就是没人用的索引。
    -- 重名标记：前端要显示「同名 N 人」，所以响应带 disambiguator = username（唯一）。

---

## 7. 验证码（internal/platform/captcha）

### 7.1 接口与实现

    // internal/platform/captcha/captcha.go
    package captcha

    var (
        ErrNotFound = errors.New("captcha: not found")   // 不存在 / 已过期 / 已被消费
        ErrWrong    = errors.New("captcha: wrong")
    )

    type Verifier interface {
        // 下发一道题：返回 id 与 PNG 字节。答案写进 kv，TTL 5 分钟。
        Issue(ctx context.Context) (id string, png []byte, err error)
        // 校验：**无论对错都立刻 Del**（一道题只有一次机会，防爆破）。
        Verify(ctx context.Context, id, answer string) error
    }

    // internal/platform/captcha/imagecaptcha/imagecaptcha.go
    func New(cache kv.Cache, clock clock.Clock) *Verifier   // 唯一实现

**为什么 Issue 不收 ip**（旧文档的签名是 Issue(ctx, ip)）：题目与 IP 无关。限流（auth:captcha:ip:）与失败计数（captcha:fail:ip:）都是 per-IP 的事，它们属于 auth 模块的调用点，不属于出题器。多一个没人用的参数就是让人以为「题目跟 IP 有关」。

**图像生成只用标准库**：image + image/png + crypto/rand。

| 项 | 定值 | 说明 |
|---|---|---|
| 字符集 | ABCDEFGHJKLMNPQRSTUVWXYZ23456789（32 个） | 去掉 I O 0 1（易混），全部大写 → 大小写不敏感 |
| 位数 | 4 | 32^4 ≈ 105 万组合 |
| 画布 | 80×28 px | 顶栏与弹窗里的展示尺寸够用 |
| 字形 | 内嵌 5×7 点阵 var glyphs [32][7]byte | **不引字体依赖**（golang.org/x/image 是新依赖，规则 7 禁止） |
| 干扰 | 每字符 ±2px 纵向抖动 + 8 个随机噪点 + 逐行水平偏移 | 「轻微扭曲」用逐行 x 偏移实现，不引入仿射变换 |
| 变体 | 只做 4 位字符（**不做算术题**） | 算术题要多一套答案生成与文案，收益（OCR 更难）对社区站没有意义 |

- 校验时答案做 ToUpper + 去首尾空白再比较。
- 存的是答案字节（答案是 4 个 ASCII 字符，直接当 []byte 存，不引入序列化）。
- key = "captcha:" + id；id = 16 字节随机 → base64url（22 字符，不可枚举）。**id 不复用、不递增**。
- 不存明文超过 TTL：TTL 由 kv.Set 保证（5 分钟）；Redis 不落盘（后端方案 §1.2），重启即全空 —— 用户重取一张即可。
- 答案**绝不回传前端**（响应里只有 id + 图片）。

### 7.2 三种模式与接线

    captcha.mode = off | on_failure | always      // 配置项，改值不改代码（S1 的 config.Captcha.Mode 已有）

    // auth 侧所有需要人机验证的入口（注册、登录、always 模式下的发帖）都走这一个函数
    func (s *auth.Service) checkCaptcha(ctx context.Context, ip string, in CaptchaInput) error {
        switch s.cfg.Captcha.Mode {
        case "off":
            return nil
        case "always":
            return s.verifyOrErr(ctx, in)
        case "on_failure":
            n, err := s.failures(ctx, ip)          // captcha:fail:<ip>
            if err != nil { return err }
            if n < failThreshold { return nil }
            return s.verifyOrErr(ctx, in)
        }
    }

| 模式 | 行为 | 落点 |
|---|---|---|
| off（默认） | 不要求验证码 | 注册有邮箱验证兜底、登录有限流兜底（后端方案 §9.5） |
| on_failure | 同一 IP 在 10 分钟内失败 ≥5 次后，后续请求必须带验证码 | **默认建议值**；被刷时不用改代码 |
| always | 注册、登录、发帖全部要求 | 应急；改配置 + 重启 |

- verifyOrErr：缺 id/answer → 400 auth.captcha_required；Verify 返回 ErrNotFound 或 ErrWrong → 400 auth.captcha_wrong（**不区分「过期」与「答错」**：用户的动作都是「换一张重试」，区分只会泄漏「这个 id 存在过」）。
- 失败计数 key：captcha:fail:<ip>，值 = 连续失败次数，TTL 10 分钟，**每次失败自增并续期**；**登录/注册成功时 Del**（「连续失败」的定义要求成功清零，否则一个正常用户偶尔打错也会被要求验证码）。
- 常量写死在 captcha 包，不进配置：failThreshold = 5、failWindow = 10 * time.Minute、answerTTL = 5 * time.Minute。**放配置里就会有人调成 100，等于关掉**。
- Redis 故障时：Issue 返回错误（前端显示「验证码服务不可用」）；Verify 返回 ErrNotFound → 校验不通过。**宁可拒绝登录，也不在故障时静默取消人机验证**（与后端方案 §7 限流的取向一致）。
- 校验失败后前端自己重取 GET /api/v1/captcha；**服务端不主动回传新题**（那会把图片字节塞进错误响应）。

### 7.3 GET /api/v1/captcha

    200 { "data": { "id": "<22 字符 base64url>", "image_base64": "<PNG 的 base64>" } }
    限流 auth:captcha:ip:<ip> = 10 次 / 小时（后端方案 §9.4）
    Cache-Control: no-store（题目不可缓存 —— 这是防重放的另一半）

---

## 8. 默认头像（default_avatars）

### 8.1 语义定案：**分配一次，存进 users 列，永不重算**

数据库文档 §4.4 写「无头像用户按 users.id % 池大小 取一张」，§10.2 又写「不要改成按 id 取模重算，否则头像会换」，旧站实现（site/crates/sc2clud-db/src/repo.rs:4112 ensure_default_avatar）是「ORDER BY RANDOM() LIMIT 1 抽一张写进 users.default_avatar_hash，分过就不再改」，而 users 表**根本没有存「分到哪张」的列** —— 三处互斥（盲审-建模 214）。

定案：**旧站语义胜出，落点补一列。**

    users.default_avatar_hash text NULL REFERENCES images(hash) ON DELETE SET NULL   -- §2.1 已加

| 什么时候写 | 值 |
|---|---|
| 注册时（第一次需要头像之前） | pool[fnv1a(public_id) % len(pool)] |
| 旧站导入时 | 直接搬旧库的 default_avatar_hash |
| 用户清掉自己的头像（DELETE /me/avatar） | **不回填**：列里一直有值，清掉的是 avatar_hash |
| 池子为空 | NULL，前端用内置兜底图（服务端不生成图） |

**为什么用 public_id 的 FNV-1a 而不是 id % N**：`id % N` 在池子大小变化时会把**所有人**的头像整体轮换（N 从 8 变 9，多数 id 的余数都变）。「存下来」本身已经保证不轮换，所以规则本身用哪个都行 —— 选 hash 是为了**同一批导入数据在不同环境重放时结果相同**（id 在不同环境可能不同，public_id 不会）。

**池子里的图 refcount = 0**，靠 §2.3-C 的 NOT EXISTS (default_avatars) 保命。**不给它们 +1**：refcount 的语义是「被业务行引用」，池子是目录不是引用；给了 +1 就再也没有任何操作会把它减回去，池子里的图将永远无法回收。

### 8.2 读出：一次查询拿全（列表页不 N+1）

    -- 单个用户（详情页、顶栏）
    SELECT COALESCE(u.avatar_hash, u.default_avatar_hash, '')                          AS avatar,
           COALESCE(u.avatar_small_hash, u.avatar_hash, u.default_avatar_hash, '')     AS avatar_small
      FROM users u WHERE u.id = $1;                          -- 主键索引

    -- 列表页 20 条一次拿完（帖子列表、回复列表、通知列表共用）
    SELECT u.id,
           COALESCE(u.avatar_hash, u.default_avatar_hash, '')                          AS avatar,
           COALESCE(u.avatar_small_hash, u.avatar_hash, u.default_avatar_hash, '')     AS avatar_small
      FROM users u WHERE u.id = ANY($1::bigint[]);           -- 主键索引，20 次索引查找

- 空串由**渲染层**换成内置兜底图 URL（一个函数，一处）；**不做生成列**：派生数据进表就是第二份真源。
- 两个待查列（avatar_hash / avatar_small_hash）的外键索引由账号域建（盲审-建模 30 列了这四条缺失），本域只登记依赖。
- avatar_small 我们**不自建缩略图**（头像本来就 ≤64KB、前端压好），列留着是为了迁移旧数据；恒为 NULL 时上面的 COALESCE 自动回落原图。

### 8.3 池子维护（管理端，权限点 site.setting，路由挂管理域）

    加入：Put 图片（visibility=public）→ §8.3 的 INSERT（refcount 显式为 0）→ INSERT default_avatars
    移除：DELETE FROM default_avatars WHERE hash=$1（**不碰 images**，文件由 GC 回收）
    排序：UPDATE default_avatars SET sort=$2 WHERE hash=$1

    -- 加入时的入库（**不复用 §2.3-A 的 upsert**：那个会把 refcount 写成 1）
    INSERT INTO images (hash, size, mime, width, height, refcount, visibility, owner_id, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, 0, 'public', NULL, now(), now())
    ON CONFLICT (hash) DO NOTHING;
    -- 已存在（同一张图也被某个用户当头像）时不改 refcount：那张图的引用计数是正常的，
    -- 池子只是额外指一下。于是「也在池里的用户头像」refcount>0 → 可正常回收；
    -- 「只在池里的」refcount=0 → 被 GC 的 NOT EXISTS 保护。

### 8.4 池子变更的生效方式

内存缓存（启动时读一次，§2.3-D）意味着**改池子后新注册用户拿到的还是旧池子**。当前设计：管理端写操作成功后调 pool.Reload()（一次 SELECT 几十行），不加锁、不重启。备选与代价见 §12.3 未决 6。

---

## 9. Go 接口（公开方法签名、路由、deps.go）

### 9.1 media

    // internal/media/service.go
    type Service struct { /* cfg, db, dbRead, store image.Store, users UserAvatar, clock, log */ }
    func NewService(cfg config.Image, db, dbRead *ent.Client, store image.Store,
                    users UserAvatar, clock clock.Clock) *Service

    type Media struct {
        Hash string; Size int64; Mime string
        Width, Height int
        Visibility string      // public / login / private
        OwnerID *int64
    }

    func (s *Service) UploadAvatar(ctx context.Context, actor *authz.Actor, in UploadAvatarInput) (*AvatarResult, error)
    func (s *Service) ClearAvatar(ctx context.Context, actor *authz.Actor) error
    func (s *Service) AttachTopicImage(ctx context.Context, actor *authz.Actor, in AttachTopicImageInput) (*AttachedImage, error)
    func (s *Service) DetachTopicImage(ctx context.Context, actor *authz.Actor, in DetachTopicImageInput) error
    func (s *Service) AddPaymentChannel(ctx context.Context, actor *authz.Actor, in AddPaymentChannelInput) (*PaymentChannel, error)
    func (s *Service) ListPaymentChannels(ctx context.Context, actor *authz.Actor, userPublicID string) ([]PaymentChannel, error)
    func (s *Service) DeletePaymentChannel(ctx context.Context, actor *authz.Actor, channelPublicID string) error

    // 分发：可见性判定在 service 里，handler 只写响应头
    type ImageResponse struct {
        Mime        string
        Size        int64
        Path        string        // 生产 X-Accel-Redirect 用的相对路径 "<ab>/<cd>/<hash>"
        Placeholder []byte        // 非空 = 权限不足：写它 + no-store
        Body        io.ReadCloser // 仅 image.serve_locally 时非空，handler 负责 Close
        Cache       bool          // true = immutable，false = no-store
    }
    func (s *Service) FetchImage(ctx context.Context, actor *authz.Actor, hash string) (*ImageResponse, error)

    // 供其它域在同一事务里引用/解引用（§4.3）：只有这两个
    func (s *Service) IncRefTx(ctx context.Context, tx *ent.Tx, h image.Hash) error
    func (s *Service) DecRefTx(ctx context.Context, tx *ent.Tx, h image.Hash) error

    // image:gc 任务处理函数（注册进 app/worker.go）
    func (s *Service) GCImages(ctx context.Context, payload []byte) error

**输入结构体**（internal/media/dto.go）：

    type UploadAvatarInput      struct { Body io.Reader; DeclaredSize int64 }
    type AttachTopicImageInput  struct { TopicPublicID string; Body io.Reader; DeclaredSize int64 }
    type DetachTopicImageInput  struct { TopicPublicID, Hash string }
    type AddPaymentChannelInput struct { Label string; Body io.Reader; DeclaredSize int64 }

DeclaredSize 只用于给 bytes.Buffer 预分配，**判限额永远用 Put 读到的字节数**。

### 9.2 release

    // internal/release/service.go
    func NewService(db, dbRead *ent.Client, counter *counter.Buffer, clock clock.Clock, log *slog.Logger) *Service

    func (s *Service) Latest(ctx context.Context, channel string) (*ReleaseDetail, error)
    func (s *Service) ListReleases(ctx context.Context, in ListReleasesInput) (*ReleasePage, error)
    func (s *Service) ResolveAsset(ctx context.Context, assetPublicID string) (string, error)  // 302 用；计数在这里加
    func (s *Service) UpsertRelease(ctx context.Context, actor *authz.Actor, in UpsertReleaseInput) (*ReleaseDetail, error)
    func (s *Service) SetReleaseStatus(ctx context.Context, actor *authz.Actor, in SetReleaseStatusInput) error
    func (s *Service) UpsertAsset(ctx context.Context, actor *authz.Actor, in UpsertAssetInput) (*Asset, error)
    func (s *Service) DeleteAsset(ctx context.Context, actor *authz.Actor, assetPublicID string) error
    func (s *Service) FlushDownloads(ctx context.Context) error   // counter 写回，§5.2

管理端权限点用既有的 site.setting（21.2 没有更细的权限点，**不新增**）。

### 9.3 search

    // internal/platform/search/search.go
    func Tokenize(s string) string
    const MaxTokens = 20000

    type Hit struct { TopicID int64; PublicID string; Title string; Rank float32 }
    type Query struct { Tokens string; BoardID *int64; CursorRank *float32; CursorID *int64; Limit int }
    type TopicDoc struct { TopicID int64; Title, BodyText, Tokens string }

    type Searcher         interface { SearchTopics(ctx context.Context, q Query) ([]Hit, error) }
    type FallbackSearcher interface { SearchTopicsBySubstring(ctx context.Context, sub string, boardID *int64, limit int) ([]Hit, error) }
    type Indexer          interface {
        UpsertTopic(ctx context.Context, doc TopicDoc) error
        DeleteTopic(ctx context.Context, topicID int64) error
    }

    // internal/platform/search/pgsql/pgsql.go  （原生 SQL 只在这个包与手写迁移里）
    func New(db *ent.Client) *Searcher

### 9.4 captcha

见 §7.1：Issue / Verify 两方法 + New(cache, clock)。

### 9.5 路由注册（internal/media/handler.go、internal/release/handler.go）

    // media（rg 是 /api/v1 组）
    rg.POST  ("/me/avatar",                       requireLogin, h.uploadAvatar)
    rg.DELETE("/me/avatar",                       requireLogin, h.clearAvatar)
    rg.POST  ("/topics/:id/images",               requireLogin, perm(authz.PermTopicCreate), h.attachTopicImage)
    rg.DELETE("/topics/:id/images/:hash",         requireLogin, h.detachTopicImage)
    rg.POST  ("/me/payment-channels",             requireLogin, h.addPaymentChannel)
    rg.GET   ("/me/payment-channels",             requireLogin, h.listMyPaymentChannels)
    rg.DELETE("/me/payment-channels/:id",         requireLogin, h.deletePaymentChannel)
    // 不在 /api/v1 下（§1.4），挂根路由组
    root.GET ("/img/:hash", h.serveImage)

    // release
    rg.GET("/launcher/latest",        h.latest)
    rg.GET("/launcher/releases",      h.listReleases)
    rg.GET("/launcher/assets/:id/go", h.goAsset)          // :id = asset 的 public_id
    // 管理端（路由组由管理域声明，handler 在本域）
    rg.POST  ("/admin/launcher/releases",       perm(authz.PermSiteSetting), h.upsertRelease)
    rg.PATCH ("/admin/launcher/releases/:id",   perm(authz.PermSiteSetting), h.setReleaseStatus)
    rg.POST  ("/admin/launcher/assets",         perm(authz.PermSiteSetting), h.upsertAsset)
    rg.DELETE("/admin/launcher/assets/:id",     perm(authz.PermSiteSetting), h.deleteAsset)
    // captcha 的 GET /captcha 挂在 auth 域的路由组（能力来自本域）
    // search 的 GET /search 挂在 forum 域的路由组（能力来自本域）

**请求体上限按路由设**（http.MaxBytesReader）：

| 路由 | 上限 | 取值 |
|---|---|---|
| POST /me/avatar | 64 KiB + 4 KiB | 69632 |
| POST /topics/:id/images | 2 MiB + 4 KiB | 2101248 |
| POST /me/payment-channels | 512 KiB + 4 KiB | 528384 |
| 其余路由 | 默认 | 1 MiB（不改全局默认，只是不覆盖） |

### 9.6 deps.go（本域用到别人的什么 —— 接口由使用方定义）

    // internal/media/deps.go
    type UserAvatar interface {
        // 在事务内替换用户的头像列，返回被替换掉的旧 hash（可能为 nil）
        SetAvatarTx(ctx context.Context, tx *ent.Tx, userID int64, h *image.Hash) (*image.Hash, error)
        // 批量取作者头像（列表页渲染）
        Avatars(ctx context.Context, userIDs []int64) (map[int64]string, error)
    }

    // internal/auth/deps.go（本域是提供方）
    type Captcha interface {
        Issue(ctx context.Context) (id string, png []byte, err error)
        Verify(ctx context.Context, id, answer string) error
    }
    // internal/forum/deps.go（本域是提供方）
    type TopicSearch interface {
        SearchTopics(ctx context.Context, q search.Query) ([]search.Hit, error)
        SearchTopicsBySubstring(ctx context.Context, sub string, boardID *int64, limit int) ([]search.Hit, error)
    }

Go 的隐式接口让 app 层直接传 *captcha.Verifier / *pgsql.Searcher 即可，两边都不必 import 对方。

### 9.7 任务与定时器的归属

| 名称 | 处理函数放哪 | 常量 | 注册点 |
|---|---|---|---|
| image:gc | internal/media/tasks.go（Service.GCImages） | queue.TypeImageGC（已有） | app/worker.go |
| search:index | internal/forum/tasks.go，调 search.Indexer | queue.TypeSearchIndex（已有） | app/worker.go（forum 注册） |
| 下载计数写回（每 15 秒） | internal/release/repo.go 的 flush SQL，由 release.Service.FlushDownloads 调 | — | app/cron.go 或 counter.Buffer.Run 的分派表 |
| 全部计数器写回 | counter.Buffer.Run(ctx)，按 key 前缀分派到各域的 flush 函数 | — | app/run.go（已有） |

---

## 10. 错误码

**尽量不新增**：§21.4 已经有的码直接用，只补两条本域确实需要、总表里没有的。

| code | 状态 | 场景 | 来源 |
|---|---|---|---|
| media.too_large | 413 | 单文件超上限（64K/2M/512K）；MaxBytesReader 触发的读错误也映射到它 | §21.4 已有 |
| media.bad_type | 400 | 魔数不在四种内（**含 SVG**）；hash 格式非法；尺寸解析失败 | §21.4 已有 |
| media.disk_full | 507 | 预检磁盘不足，或写入返回 ENOSPC | §21.4 已有 |
| media.limit_reached | 400 | 每帖 >9 张、每用户 >5 张收款码 | **新增**（不用 409：这是配额不是冲突） |
| media.not_found | 404 | /img/{hash} 无行；DELETE 的图不属于该主题 | **新增**（不造 media.forbidden：权限不足走占位图，不是错误） |
| auth.captcha_required / auth.captcha_wrong | 400 | §7.2 | §21.4 已有 |
| common.rate_limited | 429 | 上传限流、取验证码限流（带 Retry-After） | §21.4 已有 |
| common.not_found | 404 | launcher asset 不存在或不是 published | §21.4 已有 |

**两处刻意不报错**：搜索查不到（两档都 0 行）→ 200 + data: []（不是 404）；单字搜索 → 是**正常路径**（§6.2 起单字与多字共用同一条索引与查询），不报「查询太短」。

---

## 11. 测试清单（每条写清断言什么）

### 11.1 存储与 SQL（真 PG + 真文件系统）

| # | 用例 | 断言 |
|---|---|---|
| 1 | localstore.Put 超限 | 返回 ErrTooLarge；tmp/ 里不留文件；images 表无新行 |
| 2 | localstore.Put 两次同内容 | 磁盘上只有一个文件；两次返回同一 hash；size 相同 |
| 3 | localstore.Put 非图片（文本、SVG、空字节） | 返回 ErrBadType；**SVG 的 msg 里含「不支持 SVG」** |
| 4 | localstore.Put 磁盘闸门 | minFreeBytes 设成 1<<62 → 返回 ErrDiskFull，且**连临时文件都不建** |
| 5 | imgsize.Size 四种格式 | PNG/JPEG（EXIF 在前）/GIF/WebP（VP8、VP8L、VP8X）各解析出正确宽高；截断文件返回错误 |
| 6 | images upsert 三次 | 1 行、refcount=3、mime/size/width/height 不被后来的值改写 |
| 7 | 解引用下界 | refcount=1 减两次 → 第二次 0 行受影响且不报错 |
| 8 | 计数与引用行同事务 | 事务回滚后 refcount 不变（用 WithTx 注入错误） |
| 9 | image:gc 三态 | refcount=0 且超 1h → 文件+行都删；在 default_avatars 里 → 都不删；只过 10 分钟 → 都不删 |
| 10 | 孤儿文件 | 手动造 <root>/ab/cd/<hash>（无行）→ 24h 前的被删、刚建的留 |
| 11 | EXPLAIN：GC 选择 | 计划含 idx_images_gc，无 Seq Scan on images |
| 12 | EXPLAIN：搜索（档 1 与档 2 各一次） | 计划含 Bitmap Index Scan on idx_topic_search_tsv；**无 Seq Scan on topics**（1 万行夹具；<1000 行豁免） |
| 13 | **单字查询也走 GIN** | `难` 作为查询时 EXPLAIN 计划里出现 idx_topic_search_tsv，**不得出现 Seq Scan on topic_search**（R-D5-1 的回归测试） |
| 14 | EXPLAIN：release 两个查询 | 走 idx_releases_latest，**无 Sort 节点** |
| 15 | EXPLAIN：计数写回 | 走 release_assets_pkey |
| 16 | **搜索闸门（告警）** | `EXPLAIN ANALYZE` 搜索查询：`Bitmap Heap Scan` 的 actual rows > 10000 时 `forum check` 告警（review R-D5-3） |
| 17 | **搜索闸门（硬断言）** | CI 里对一个高频词搜索，断言执行时间 **< 200ms**（review R-D5-3）；超阈值时的动作是「改设计（物化分数列）或改闸门」，**不是** 悄悄放宽 |

### 11.2 并发与幂等（这四条是本域最容易出错的地方）

| # | 用例 | 断言 |
|---|---|---|
| 18 | 两个 goroutine 同时传同一张图 | 盘上一个文件、refcount=2、两边的响应 hash 相同 |
| 19 | 同一 topic 并发传第 9 张 | 一成一败（400 media.limit_reached），最终 count(*)=9 |
| 20 | 同一用户并发加第 5 张收款码 | 一行成功一行 400，最终 5 行 |
| 21 | search:index 任务重放 3 次 | topic_search 只有 1 行，tokens 逐字节相同；发 10 次编辑只留 ≤2 个未完成任务（unique_key 去重） |
| 22 | 计数写回失败后重试 | 内存增量不清空；重试成功后 download_count 正确；**失败两次会多计（明确断言这个已知行为）** |
| 23 | **两档查询的行为** | 四种输入（单字 / 两字 / 长词整串 / 长词丢字）分别断言命中；长词丢字那条必须走档 2（断言响应 tier="loose"）；档 1 有结果时**不得**跑档 2（用 SQL 计数器断言只发了一次查询） |
| 24 | **tier 与游标** | 翻页时把 tier 原样带回 → 第二页正确；故意把 tier 改成另一档 → 服务端从第一页重来（不返回错序结果） |
| 25 | release 重复 publish | published_at 不变（clock.Fake 推进时间后对比两次读到的值）；state 不变 |

### 11.3 权限与可见性

| # | 用例 | 断言 |
|---|---|---|
| 26 | 三档可见性 × 三种身份 | public 对谁都直出；login 对游客占位图 + no-store；private 对所有者与 reward.verify 持有者直出、对他人占位图 + no-store。**任何一格都不是 404** |
| 27 | 未登录调七个写/读端点 | 全部 401（/img 与 launcher 读端点除外） |
| 28 | 无 topic.create 调 POST /topics/{id}/images | 403（路由层与 service 层各一次，证明两层都在） |
| 29 | 非作者 DELETE 别人的配图 | 404 且不泄漏「这个 hash 存在过」 |
| 30 | 路由遍历测试 | 七个需登录路由都声明了权限点（后端方案 §9.8 的既有测试覆盖本域） |

### 11.4 自检（进 forum check 与 CI，每条都要能红）

| # | 检查 | 期望 |
|---|---|---|
| 31 | 外键索引自检（数据库文档 §12 第 1 条）在本域四表上 | 0 行（topic_images.image_hash、payment_channels 两列、release_assets.release_id、images.owner_id、default_avatars.hash 都要有） |
| 32 | 枚举值域自检 | images.mime / images.visibility / releases.channel / releases.status 的 CHECK 值域 == Go 常量集合 |
| 33 | 图片引用一致（**含默认头像豁免**） | 0 行：refcount ≠ 三张引用表的实际引用数，且 hash 不在 default_avatars 里 |
| 34 | 磁盘 ↔ 行对账 | images 行数 == 磁盘文件数（残件与孤儿分别报数） |
| 35 | 搜索索引覆盖 | 0 行：normal+approved 的主题在 topic_search 里都有行 |
| 36 | tokens 覆盖 | 0 行：topic_search.tokens = ''（标题与正文都非空时）；另断言「标题里的每个内容字符都出现在该行的 tokens 里」（防止分词器被改成只出 bigram，那会让单字查询静默失效） |

### 11.5 端到端（S7 验收脚本）

    - 同一张图上传两次（换文件名）→ images 只 +1、磁盘只多一个文件、refcount=2
    - 2MB+1 字节的 PNG → 413；改扩展名的 .txt → 400 media.bad_type；SVG → 400 且提示可读
    - 配图 → 删除 → 一个 GC 周期后磁盘文件消失
    - 搜索四种输入：单字「难」、两字「大吉」、长词整串「隐藏结局」、长词丢字「隐藏的结局」都命中；
        再跑 §6.9 ⑤ 的三条可见性反例（必须红）
    - 302：curl -i 看到 302 + Location；等一个写回周期后 download_count +1；连点 10 次 +10
    - 清除头像后拿到 default_avatar_hash，刷新 5 次不变（证明没有每次重算）
    - captcha: off 模式不带验证码可登录；on_failure 连错 5 次后必须带；always 下缺参数 → auth.captcha_required
    - 同一道验证码用两次：第二次 → auth.captcha_wrong（证明 Del 生效）

---

## 12. 文档冲突与未决

### 12.1 本域裁决（与旧文档冲突，本文为准）

| # | 旧文档怎么写 | 本文怎么定 | 为什么 |
|---|---|---|---|
| 1 | 数据库 §4.4「无头像用户按 users.id % 池大小 取一张」 | users.default_avatar_hash 一列，**注册时选一次并落库，永不重算** | 数据库 §10.2 与旧站实现（repo.rs:4112）都是「分一次固定」，且旧表本来就有一列；照 §4.4 写会让池子大小变化时全体换头像（盲审-建模 214） |
| 2 | 数据库 §4.4「images.visibility smallint ck in (0,1,2)」 | text + CHECK ('public','login','private') | 全局约定 6（枚举一律 text + CHECK）；smallint 会让「枚举值域自检」永远看不到这一列（盲审-建模 181） |
| 3 | 数据库 §4.4「hash char(64)」及各引用列 | text + CHECK (hash ~ '^[0-9a-f]{64}$') | bpchar 有补空格比较与 length() 语义，与「摘要就是 64 个字符」不等价（盲审-建模 185） |
| 4 | 数据库 §4.4「payment_channels 可见性 = 1（登录可见）」 | **login**（= 老站那一档），闸在作者侧的 show_channels：开则登录用户与游客都取得到、关则占位图 | 2026-10-14 第三轮拍板「必须显示，按渠道显示，参考老网站」推翻了本文原先的 private 定案（§3.3 已改写）；写死 public 会让档位与开关脱钩，也是被否掉的方案 |
| 5 | 后端方案 §21.2「POST /api/v1/posts/{id}/images（每帖 ≤9）」 | POST /api/v1/topics/{id}/images | topic_images 的键是 topic_id，「每帖 ≤9」与「按楼层解引用」在数据模型上不成立（盲审-建模 17）；配图属于主题不属于楼层 |
| 6 | 后端方案 §21.2「GET /launcher/assets/{id}/go」（{id} 未指明） | {id} = asset 的 public_id | 对外 ID 只出现 public_id（拍板 §5.6）；表里本来就有 public_id 列 |
| 7 | 施工计划 S7「topic_search + **gse 预分词** + search:index」 | bigram（search.Tokenize），gse 不再出现 | 性能与容量 §2.1/§5 已删 gse；S7 那句是残留 |
| 8 | 后端方案 §10.6「按 MIME 分目录 /_img/png/…」 | 不分目录，**Content-Type 由 Go 给**，nginx types {} 不覆盖 | 存储布局（<root>/<ab>/<cd>/<hash>）不含 mime；少四条 internal location、少一层目录 |
| 9 | 后端方案 §10.5「level 0/1/2」 | 文本三值枚举；private 的放行者含 reward.verify | 数字枚举与全局约定 6 冲突；核验人必须看不到就没人能核验（界面施工 §5.6） |
| 10 | 数据库 §4.4「images 索引只有 idx_images_gc」 | 补 idx_images_owner（外键索引） | PG 不自动建外键索引（全局约定 10、盲审-建模 30） |
| 11 | 数据库 §5「topic_search 另有 gin(title gin_trgm_ops) 给标题模糊匹配」 | **只有 gin(tsv) 一个 GIN**；词素集合 = **单字 + bigram** | 标题模糊匹配没人要（前端搜索框拼的是分词结果），trgm 索引也没人用得上；单字搜索改走同一个 GIN（review R-D5-1） |
| 12 | （本设计第一版）单字查询走 `tokens ILIKE '%X%'` 兜底 | **删掉**，单字与多字共用档 1 查询 | GIN 是词素相等不是子串；索引里没有单字词素就永远走不了索引，且随数据量线性恶化（review R-D5-1） |
| 13 | （本设计第一版）搜索只有 AND 一档 | **两档**：档 1 AND（plainto_tsquery）、档 2 单字 OR（to_tsquery，参数化），档 2 只在档 1 首页 0 行时跑 | bigram 全 AND 太严，「搜了没结果」会变成常见投诉（review R-D5-2） |

### 12.2 需要回写旧文档的清单（本轮不改旧文档）

- [ ] 数据库 §4.4：images 列类型（text+CHECK）、visibility 文本三值、补 idx_images_owner；topic_images 补 `(topic_id, sort)` 唯一索引与 sort 范围；~~payment_channels 可见性改 private~~ **可见性 = login + 作者侧 show_channels 闸（第三轮拍板，§3.3）**；**加 `users.default_avatar_hash` 一列 + 索引**
- [ ] 数据库 §3 表清单：本域四张表的外键索引列出来
- [ ] 数据库 §5：topic_search 只留 `gin(tsv)` 一个索引（去掉标题 trgm）；补「词素 = 单字 + bigram」「写入与查询共用同一个 Go Tokenize」两句
- [ ] 数据库 §12：第 8 条「图片引用一致」换成 §11.4-33 的可红 SQL（含默认头像豁免，否则永远红）
- [ ] 后端方案 §10.2 / §21.2：帖子配图端点改 /topics/{id}/images；§10.6 的 MIME 分目录删掉
- [ ] 后端方案 §17 M8 与施工计划 S7：gse 预分词 → bigram
- [ ] 后端方案 §7.6：补 §6.7 的触发点表（创建/改标题/改 1 楼/改可见性与审核态/删除）
- [ ] 后端方案 §21.4：补 media.limit_reached、media.not_found 两个码
- [ ] 后端方案 §21.2：launcher 的 {id} 注明是 public_id

### 12.3 未决问题（每条给两种选择与代价，不自己拍板）

| # | 问题 | 选项与代价 | 需要谁拍 |
|---|---|---|---|
| 1 | ~~**收款码对访客不可见**（§3.3 的取舍）~~ **已拍板（2026-10-14 第三轮）** | 用户选「必须显示，按渠道显示，参考老网站」：档位 = login（老站那一档），读路径上看作者侧的 `show_channels`（开着 → 登录用户与游客都取得到；关着 → 占位图）。A/B/C 三选项作废，§3.3 已按此改写 | 已定 |
| 2 | **内置兜底头像**（池子为空时） | A 一张固定 URL 的静态图（头像 URL 出现第三种形状，前端要分支）；B 启动时把 embed 的图 Put 进 images 并入池（URL 形状统一，代价是「启动要写库」）。倾向 B | Lead（涉及启动是否允许写库） |
| 3 | **releases.version 全局唯一** | A 全局唯一（现状，一个版本一行，平台差异在 assets）；B 改成 UNIQUE (channel, version)（stable/beta 可有同名版本，代价是定位唯一版本必须带 channel） | Lead |
| 4 | **硬删用户导致的 refcount 泄漏** | A 接受，靠 §11.4-33 的对账发现并人工修；B 给 users 加 BEFORE DELETE 触发器减引用（引入本设计全程避免的触发器，全局约定 12 明确不建） | Lead |
| 5 | **是否保留 pg_trgm 扩展**（数据库 G3） | A 保留（现状，但**本域已经不再需要它**：单字搜索走同一个 GIN，用户搜索走 username 前缀）；B 删掉扩展（少一个扩展与一个没人用的索引；代价：以后要做「标题模糊匹配」要重新加）。**本域倾向 B，但它同时影响数据库文档的第一个迁移**，所以留给人拍 | Lead |
| 6 | **档 2（OR 兜底）的降级策略** | A 现状：只在档 1 **首页 0 行**时降级（后果：第 2 页才发现没有更多精确结果时不会降级 —— 用户看到的是「正好一页」）；B 每页都判「这一页 0 行就降级」（翻页逻辑复杂、可能把两档结果混在一页里）。倾向 A | Lead |
| 7 | **档 2 的排序口径** | A 现状：`ts_rank`（命中词素越多越靠前）；B 按 `last_reply_at`（时间新靠前，与列表页一致，但完全不体现相关度）。倾向 A | 产品 |
| 8 | **默认头像池变更的生效方式** | A 写操作后 Reload（现状，一次 SELECT 几十行）；B 要求重启；C 每次注册查一次库 | Lead |
| 9 | **image.serve_locally 的默认值** | 生产必须 false、开发必须 true；若代码里给 false，本地起服务所有图都是占位/失败。需要定它在 config.example.yaml 的位置，以及 forum check 是否要警告「prod + serve_locally=true」 | Lead |
| 10 | **上传侧要不要字节限速与并发闸门**（功能清单 9.2，老站有） | A 只做次数限流 + 单文件上限（10 个并发 2MB 上传 = 20MB 瞬时内存）；B 加进程内并发信号量（多一个常量与一处 select，2 vCPU 上收益有限） | Lead（内存预算） |
| 11 | **PlainText(html) 归谁** | A D3 forum 提供（它已有 markdown 渲染与清洗，摘要 excerpt 也需要同一个函数）；B D5 在 platform/search 里写一份（会出现第二份 HTML→文本实现）。倾向 A | Lead |
| 12 | **topic_search 要不要进 ent schema 实体** | A 进（表清单与迁移一致，但业务代码不走 ent 读写它）；B 只存在于手写迁移（S1 的「空表跑迁移 vs ent snapshot」一致性检查会多出这张表） | Lead |

---

## 13. 四个问题（逐条回答）

1. **数据量上来还走索引吗？** 见 §6.6 的计划表与 §11.1 第 11–17 条的 EXPLAIN 与闸门：搜索走 GIN + topics 主键 NestLoop；GC 走部分索引 idx_images_gc；封面走 uq_topic_images_sort 的前缀 + 常量；release 两个列表查询走 idx_releases_latest 且**无 Sort 节点**；计数写回走主键。唯一已知会退化的两处：**单字搜索**（trgm 对 1 字符模式无效 → 顺扫，见未决 5）与**命中全表的查询**（查 `的` 这种字，命中全表本来就该全表相关）。
2. **并发重放会怎样？** 同图两次上传 → refcount +2、盘上一份文件（去重）；两张图抢第 9 个位置 → 主题行锁串行化，一成一败；索引任务连发 10 次 → unique_key 去重 + upsert 幂等，结果逐字节一致；转链连点 → 计数如实 +N（下载数就是点击数，不做幂等键）；计数写回失败重试 → 增量重复累加（多计，明确写出）；重复 publish → published_at 与状态都不变；同一道验证码用两次 → 第二次 ErrNotFound（已 Del）。
3. **失败之后数据停在什么状态？** 落盘失败：无行、无文件（临时文件由 24h 残件清理）。落盘成功但事务回滚：盘上孤儿文件 + 无行 → GC 的 Walk 分支回收。引用计数与引用行恒在同一事务，不存在「有引用行没计数」。索引任务进 dead：主题搜不到 → §11.4-35 的对账发现。计数写回失败：内存增量保留，15 秒后重试。验证码服务故障：登录被拒（明确选择宁可拒绝不放行）。**全部不需要人手修复**；唯一例外是未决 4 的硬删用户泄漏（需要人工或对账）。
4. **不写会少什么？** 逐条追到调用点或事故：Stat → /img 的 HEAD 与「行在文件丢」告警；批量封面 SQL → 列表页 20 次 N+1；MaxTokens → tsvector 1MB 上限报错；fsync 父目录 → 掉电后目录项丢失；主题行锁 → 每帖 9 张的并发越界；unique_key → 连发 10 次编辑排 10 个重复任务；公开头像豁免 → 池子里的图被 GC 删掉（用户头像变裂图）。**已经删掉的**：Exists（省不掉一次打开）、图片专用 LRU、缩略图队列、第二种搜索实现、**ILIKE 单字兜底（R-D5-1）**、tokens 的 trgm 索引、算术题变体、按 hash 缓存占位图、乐观重试循环、UNIQUE(channel, version)（未决 3）、给默认头像 ±1 的引用计数。
