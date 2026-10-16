-- ============================================================
-- 0003 启动器下载索引（**不托管文件**）
--
-- 设计约束：本站只做「发布索引 + 转链」，**不承载启动器产物的字节**。
-- 理由：本站是 10 Mbps 的单机小站，拉安装包会把出口带宽吃光；
--       参考启动器自身的更新实现，它本来就是按 release 列表取 asset 的直链，
--       因此把索引搬到站内、把直链指向真正的分发点（GitHub Releases / 对象存储 / 镜像）即可。
--
-- 好处：
--   * 站点侧零带宽消耗，只多一次 302 或一段 JSON；
--   * 直链可以随时换（换镜像、换对象存储）而不用改启动器里的地址；
--   * 下载计数、版本公告、预发行通道都能在站内做。
-- ============================================================

CREATE TABLE releases (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    version      TEXT    NOT NULL,
    channel      TEXT    NOT NULL DEFAULT 'stable',   -- stable | beta
    title        TEXT,
    notes        TEXT,
    is_published INTEGER NOT NULL DEFAULT 0,
    created_by   INTEGER,
    created_at   INTEGER NOT NULL,
    published_at INTEGER
);
CREATE UNIQUE INDEX idx_releases_version_channel ON releases(version, channel);

CREATE TABLE release_assets (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    release_id     INTEGER NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
    platform       TEXT    NOT NULL,                 -- windows | macos | linux
    arch           TEXT    NOT NULL DEFAULT 'x86_64',
    filename       TEXT    NOT NULL,
    url            TEXT    NOT NULL,                 -- 外部直链：本站只索引与转链
    size           INTEGER NOT NULL DEFAULT 0,
    sha256         TEXT,                             -- 校验值（可选，帮助用户核对）
    download_count INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL
);
CREATE INDEX idx_release_assets_release ON release_assets(release_id);
