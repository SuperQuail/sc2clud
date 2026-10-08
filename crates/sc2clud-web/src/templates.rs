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
    /// 已登录用户名（游客为 None）。
    pub user_label: Option<String>,
    pub user_role_label: String,
    /// 已激活：可以发帖。
    pub can_post: bool,
    /// 已登录但未激活。
    pub needs_activation: bool,
    /// 分区导航：当前选中项 + 各分区。
    pub sections: Vec<SectionOption>,
    /// 「全部」是否处于选中态（没有指定分区时）。
    pub sections_all_active: bool,
    /// 帖子流（已按查看者过滤：审核中的只有作者与管理员可见）。
    pub posts: Vec<FeedView>,
    pub visible_posts: i64,
    /// 当前用户是否管理员及以上（决定导航里是否出现「管理」）。
    pub is_staff: bool,
    /// 网盘区块是否可见（当前仅网站管理员及以上）。
    pub netdisk_visible: bool,
    /// **只显示自己的文件**——别人的文件不进首页。
    pub my_files: Vec<FileView>,
    /// 登录后才给的文件统计。
    pub my_file_stats: Option<MyFileStats>,
    pub max_upload_human: String,
}

/// 首页帖子卡片。
pub struct FeedView {
    pub id: i64,
    pub title: String,
    pub preview: String,
    /// 封面图（该帖第一张图）；卡片用它铺底。
    pub cover_hash: Option<String>,
    pub kind: String,
    pub kind_label: String,
    pub section: String,
    pub section_label: String,
    /// 仅当不该公开时才有值（审核中/被拒，且查看者有资格看到）。
    pub state: String,
    pub state_label: String,
    pub author: String,
    pub author_role_label: String,
    pub created_at: String,
    pub image_count: i64,
    pub is_mine: bool,
}

/// 自己的网盘统计（游客与未登录者看不到）。
pub struct MyFileStats {
    pub files: i64,
    pub bytes_human: String,
    pub downloads: i64,
}

#[derive(Template)]
#[template(path = "file.html")]
pub struct FilePageTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
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
    /// discussion | resource | repost，缺省为讨论。
    #[serde(default)]
    pub kind: Option<String>,
}

// ------------------------------------------------------------ 展示辅助

/// 帖子详情页。
#[derive(Template)]
#[template(path = "post.html")]
pub struct PostPageTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    /// CSRF 令牌（表单隐藏字段）；用 String 以免模板结构体借用调用方的局部变量。
    pub csrf: String,
    pub post: PostDetailView,
    /// 配图（原图或压缩图，按 position 顺序）。
    pub images: Vec<ImageView>,
    /// 下载来源（资源帖；仅这些帖子有）。
    pub sources: Vec<SourceView>,
    /// 是否值得显示「资源来源」区块（有来源，或本来就是资源帖）。
    pub show_sources: bool,
    pub comments: Vec<CommentView>,
    /// 已登录且已激活才能回复（回复不带图）。
    pub can_reply: bool,
    pub is_staff: bool,
}

/// 帖子正文视图。
pub struct PostDetailView {
    pub id: i64,
    pub title: String,
    pub section: String,
    pub section_label: String,
    pub body: String,
    pub kind: String,
    pub kind_label: String,
    pub state: String,
    pub state_label: String,
    pub review_note: Option<String>,
    pub author: String,
    pub author_role_label: String,
    pub created_at: String,
    pub image_count: i64,
    pub is_mine: bool,
}

/// 下载来源视图（资源帖专用）。
pub struct SourceView {
    pub provider: String,
    pub provider_label: String,
    pub label: Option<String>,
    pub url: String,
    pub extract_code: Option<String>,
    /// GitHub 来源：给出镜像候选（原链排第一，最快的由前端实测后置顶）。
    pub mirrors: Vec<MirrorView>,
}

/// GitHub 镜像候选。
pub struct MirrorView {
    pub label: String,
    pub url: String,
    pub is_original: bool,
}

/// 配图视图。
pub struct ImageView {
    pub href: String,
}

/// 回复视图。
pub struct CommentView {
    pub author: String,
    pub body: String,
    pub created_at: String,
}

/// 发帖页。
#[derive(Template)]
#[template(path = "new.html")]
pub struct NewPostTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub csrf: String,
    pub error: Option<String>,
    pub kinds: Vec<KindOption>,
    pub sections: Vec<SectionOption>,
    pub providers: Vec<ProviderOption>,
    pub title: &'a str,
    pub body: &'a str,
    /// 三个下载来源槽位（资源帖用；留空即忽略）。
    pub source_slots: Vec<SourceSlot>,
}

/// 发帖页的分区选项。
pub struct SectionOption {
    pub value: String,
    pub label: String,
    pub checked: bool,
}

/// 发帖页的来源下拉项。
pub struct ProviderOption {
    pub value: String,
    pub label: String,
}

/// 发帖页的一个来源槽位。
pub struct SourceSlot {
    pub index: usize,
    pub url: String,
    pub code: String,
    pub provider: String,
}

/// 管理员面板。
#[derive(Template)]
#[template(path = "admin.html")]
pub struct AdminTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub csrf: String,
    /// 当前管理员是否超级管理员（决定能否改等级/显示名）。
    pub is_super: bool,
    pub require_activation: bool,
    /// (值, 显示名)
    pub roles: Vec<(String, String)>,
    pub users: Vec<AdminUserView>,
}

/// 管理员面板里的用户行。
pub struct AdminUserView {
    pub id: i64,
    pub handle: String,
    pub display_name: String,
    pub role: String,
    pub role_label: String,
    pub activated: bool,
    pub created_at: String,
    pub is_self: bool,
}

/// 后台用户行（管理员页）。

/// 发帖类型选项。
pub struct KindOption {
    pub value: String,
    pub label: String,
    pub hint: String,
    pub checked: bool,
}

/// 登录页。
#[derive(Template)]
#[template(path = "login.html")]
pub struct LoginTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub error: Option<String>,
    pub account: &'a str,
}

/// 注册页。
#[derive(Template)]
#[template(path = "register.html")]
pub struct RegisterTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    /// 站点当前是否要求管理员手动激活（决定页面文案）。
    pub needs_activation: bool,
    pub error: Option<String>,
    pub handle: &'a str,
    pub display_name: &'a str,
    pub email: &'a str,
}

/// 统一的模板渲染出口：渲染失败只记日志、回 500。
pub fn render<T: Template>(template: T) -> axum::response::Response {
    use axum::response::IntoResponse;
    match template.render() {
        Ok(html) => (
            [(axum::http::header::CONTENT_TYPE, "text/html; charset=utf-8")],
            html,
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error = %e, "模板渲染失败");
            crate::error::AppError::internal(format!("模板渲染失败：{e}")).into_response()
        }
    }
}

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
