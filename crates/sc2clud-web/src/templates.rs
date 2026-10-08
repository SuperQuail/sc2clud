//! askama 模板模型与对外 DTO。
//!
//! 服务端渲染是默认路径：1.25 MB/s 的链路上，前端 bundle 体积直接等于用户等待时间。
//! 交互密集模块（上传进度等）才局部挂载前端岛，见 `web/`。

use askama::Template;
use serde::{Deserialize, Serialize};

// ------------------------------------------------------------ 页面模板

#[derive(Template)]
#[template(path = "index.html")]
pub struct IndexTemplate<'a> {
    pub site_name: &'a str,
    pub posts: Vec<PostView>,
    pub files: Vec<FileView>,
    pub total_posts: i64,
    pub total_files: i64,
    pub total_downloads: i64,
    pub total_bytes_human: String,
    pub max_upload_human: String,
}

#[derive(Template)]
#[template(path = "file.html")]
pub struct FilePageTemplate<'a> {
    pub site_name: &'a str,
    pub file: FileView,
    pub owner_handle: String,
    pub download_href: String,
}

#[derive(Template)]
#[template(path = "error.html")]
pub struct ErrorTemplate<'a> {
    pub status: u16,
    pub code: &'a str,
    pub message: &'a str,
}

pub struct PostView {
    pub id: i64,
    pub title: String,
    pub preview: String,
    pub created_at: String,
}

#[derive(Clone)]
pub struct FileView {
    pub id: i64,
    pub name: String,
    pub size_human: String,
    pub mime: String,
    pub download_count: i64,
    pub created_at: String,
}

impl FileView {
    pub fn from_row(row: &sc2clud_db::FileRow) -> Self {
        Self {
            id: row.id,
            name: row.name.clone(),
            size_human: human_bytes(row.size.max(0) as u64),
            mime: row.mime.clone(),
            download_count: row.download_count,
            created_at: format_date(row.created_at),
        }
    }

    /// 下载页/联合查询用（含上传者）。
    pub fn from_owner_row(row: &sc2clud_db::FileWithOwnerRow) -> Self {
        Self {
            id: row.id,
            name: row.name.clone(),
            size_human: human_bytes(row.size.max(0) as u64),
            mime: row.mime.clone(),
            download_count: row.download_count,
            created_at: format_date(row.created_at),
        }
    }
}

// ------------------------------------------------------------ API DTO

#[derive(Debug, Serialize)]
pub struct FileDto {
    pub id: i64,
    pub name: String,
    pub size: i64,
    pub hash: String,
    pub mime: String,
    /// true = 命中已有内容（秒传 / 去重），本次没有传输字节。
    pub deduplicated: bool,
    pub download_url: String,
}

/// 秒传声明：客户端先报哈希，命中则 0 字节传输。
#[derive(Debug, Deserialize)]
pub struct ClaimRequest {
    pub name: String,
    pub hash: String,
    pub size: i64,
    #[serde(default)]
    pub mime: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UploadQuery {
    pub name: String,
    /// 可选：声明哈希，服务端比对不符即拒绝。
    #[serde(default)]
    pub hash: Option<String>,
    #[serde(default)]
    pub mime: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PostDto {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub created_at: i64,
}

#[derive(Debug, Deserialize)]
pub struct PostCreateRequest {
    pub title: String,
    pub body: String,
}

// ------------------------------------------------------------ 展示辅助

/// 人类可读体积（1024 进制，保留一位小数）。
pub fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    if bytes < 1024 {
        return format!("{bytes} B");
    }
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    format!("{value:.1} {}", UNITS[unit])
}

/// Unix 秒 → `YYYY-MM-DD`（不引日期库：只需要一个稳定的展示格式）。
pub fn format_date(unix_seconds: i64) -> String {
    let days = unix_seconds.div_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Howard Hinnant 的 civil_from_days：把「1970-01-01 起的天数」换成公历年月日。
fn civil_from_days(days_since_epoch: i64) -> (i64, u32, u32) {
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn human_bytes_scales() {
        assert_eq!(human_bytes(0), "0 B");
        assert_eq!(human_bytes(1023), "1023 B");
        assert_eq!(human_bytes(1024), "1.0 KiB");
        assert_eq!(human_bytes(50 * 1024 * 1024), "50.0 MiB");
    }

    #[test]
    fn format_date_known_days() {
        assert_eq!(format_date(0), "1970-01-01");
        assert_eq!(format_date(1_700_000_000), "2023-11-14");
        assert_eq!(format_date(86_399), "1970-01-01");
        assert_eq!(format_date(86_400), "1970-01-02");
    }
}
