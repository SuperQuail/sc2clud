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
    pub search_query: String,
    pub active_section: String,
    pub is_search: bool,
    pub popular: bool,
    pub show_discovery: bool,
    pub feed_title: String,
    pub featured: Option<FeedView>,
    pub page: i64,
    pub previous_page: Option<String>,
    pub next_page: Option<String>,
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
    /// 最新一条系统公告（首页顶部横幅）。
    pub announcement: Option<(String, String)>,
    /// 帖子流（已按查看者过滤：审核中的只有作者与管理员可见）。
    pub posts: Vec<FeedView>,
    pub visible_posts: i64,
    /// 当前用户是否管理员及以上（决定导航里是否出现「管理」）。
    pub is_staff: bool,
    /// 顶栏下拉里的退出表单要带 CSRF（游客为空串）。
    pub csrf: String,
    /// 当前用户的头像摘要（顶栏用）。
    pub my_avatar: Option<String>,
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
    /// 作者头像摘要（NULL = 首字母兜底）。
    pub avatar: Option<String>,
    /// 回复数（列表视图统计条）。
    pub comment_count: i64,
    pub like_count: i64,
    pub bookmark_count: i64,
    /// 已归档（不再展示，但作者/管理员可直链打开）。
    pub archived: bool,
    /// 「多久以前」（列表视图统计条）。
    pub time_ago: String,
    /// 作者登录名（卡片作者栏跳主页用）。
    pub author_handle: String,
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
    /// 管理入口是否可见。
    pub is_staff: bool,
    /// 顶栏下拉里的退出表单要带 CSRF。
    pub csrf: String,
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
    /// 左侧分区导航（快捷进入其它分区）。
    pub sections: Vec<SectionOption>,
    /// 当前查看者能否与作者互动（登录、已激活、且不是作者本人）。
    pub can_interact: bool,
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
    /// 作者是否开了打赏展示（开了才出那个大按钮）。
    pub donation_visible: bool,
    /// 预览用的界面样式编号（1/2/3，生产恒为 2 —— 已评审通过的「分组下拉」）。
    pub ui_variant: u8,
    /// 赞助弹窗样式（1 左右分栏 / 2 顶部标签 / 3 卡片网格）。
    pub donate_variant: u8,
    /// 赞助前提示样式（1 红顶卡 / 2 红标题横条 / 3 红圆图标卡）。
    pub notice_variant: u8,
    /// 打赏渠道（弹窗左栏用；没有渠道时为空，前端不显示入口）。
    pub donation_channels: Vec<DonationChannelView>,
    /// 打赏前必须点「确定」的那段醒目提示（作者/渠道默认都没配则为 None）。
    pub donation_notice: Option<String>,
}

/// 头衔切换列表里的一项。
#[derive(Debug, Clone)]
pub struct TitleChoice {
    pub id: i64,
    pub name: String,
    pub color: String,
    pub equipped: bool,
}

/// 消息中心（B 站式：左分类 / 中列表 / 右消息流）。
#[derive(Template)]
#[template(path = "inbox.html")]
pub struct InboxTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub is_staff: bool,
    pub csrf: String,
    /// 分类：dm / likes / system。
    pub tab: String,
    pub conversations: Vec<InboxConversationView>,
    /// 当前选中会话对方 handle（私信用）。
    pub selected: String,
    pub other_display: String,
    pub other_avatar: Option<String>,
    pub thread: Vec<InboxMessageView>,
    /// 未读数（左栏徽标）。
    pub like_unread: i64,
    pub system_unread: i64,
    pub dm_unread: i64,
    /// 收到的赞 / 系统通知列表（按 tab 取其一）。
    pub notices: Vec<InboxNoticeView>,
    /// 当前选中的通知。
    pub selected_notice: Option<InboxNoticeView>,
}

/// 消息中心的一条通知（收到的赞 / 系统通知）。
#[derive(Debug, Clone)]
pub struct InboxNoticeView {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub link: String,
    pub date: String,
    pub unread: bool,
    pub active: bool,
}

/// 消息中心的会话项。
#[derive(Debug, Clone)]
pub struct InboxConversationView {
    pub handle: String,
    pub display_name: String,
    pub avatar: Option<String>,
    pub last_body: String,
    pub date: String,
    pub active: bool,
}

/// 消息中心的通知项。
#[derive(Debug, Clone)]
pub struct InboxNotificationView {
    pub title: String,
    pub body: String,
    pub link: String,
    pub date: String,
    pub unread: bool,
}

/// 消息流里的一条。
#[derive(Debug, Clone)]
pub struct InboxMessageView {
    pub mine: bool,
    pub body: String,
    pub date: String,
    /// 时间分隔条：与上一条不是同一天时显示（B 站那种居中日期行）。
    pub show_date: bool,
}

/// 搜索页（B 站式：搜索框 + 分类标签 + 结果）。
#[derive(Template)]
#[template(path = "search.html")]
pub struct SearchPageTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub is_staff: bool,
    pub csrf: String,
    pub q: String,
    pub tab: String,
    /// 版式编号：1 一行标签栏 / 2 两行筛选 + 右侧相关用户 / 3 左侧筛选栏（预览用，生产恒 1）。
    pub search_variant: u8,
    pub posts: Vec<PostHitView>,
    pub users: Vec<UserHitView>,
    pub post_count: i64,
    pub user_count: i64,
}

/// 搜索命中的帖子（结果行）。
#[derive(Debug, Clone)]
pub struct PostHitView {
    pub id: i64,
    pub title: String,
    pub cover_hash: Option<String>,
    pub section_label: String,
    pub author: String,
    pub date: String,
    pub comment_count: i64,
}

/// 搜索命中的用户卡片。
#[derive(Debug, Clone)]
pub struct UserHitView {
    pub handle: String,
    pub display_name: String,
    pub avatar: Option<String>,
    pub role_label: String,
    pub bio: String,
    pub post_count: i64,
}

/// 用户名后面的头衔徽章。
#[derive(Debug, Clone)]
pub struct TitleBadgeView {
    pub name: String,
    /// 头衔自带的颜色（`#rrggbb`），为空则用主题色。
    pub color: String,
}

/// 打赏弹窗里的一个渠道。
#[derive(Debug, Clone)]
pub struct DonationChannelView {
    pub id: i64,
    pub channel: String,
    pub label: String,
    pub image_hash: String,
}

/// 帖子正文视图。
pub struct PostDetailView {
    pub id: i64,
    pub avatar: Option<String>,
    /// 作者的登录名（右栏「主页 / 私信」跳转用）。
    pub author_handle: String,
    /// 回复数（右栏数据卡）。
    pub comment_count: i64,
    pub title: String,
    pub section: String,
    pub section_label: String,
    pub body: String,
    pub kind: String,
    pub kind_label: String,
    pub state: String,
    pub state_label: String,
    pub review_note: Option<String>,
    /// 当前查看者是否已点赞 / 收藏，以及计数。
    pub archived: bool,
    /// 当前查看者能否编辑（作者本人或管理员及以上）。
    pub can_edit: bool,
    pub liked: bool,
    pub bookmarked: bool,
    pub like_count: i64,
    pub bookmark_count: i64,
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
    pub avatar: Option<String>,
    pub body: String,
    pub created_at: String,
}

/// 发帖页。
#[derive(Template)]
#[template(path = "new.html")]
pub struct NewPostTemplate<'a> {
    pub is_staff: bool,
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
    /// 分区封面（管理员设置过才有）。
    pub cover: Option<String>,
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
    /// 自定义显示名（可留空）。
    pub label: String,
}

/// 编辑帖子（作者本人或管理员）。
#[derive(Template)]
#[template(path = "edit.html")]
pub struct EditPostTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub is_staff: bool,
    pub csrf: String,
    pub id: i64,
    pub error: Option<String>,
    pub state_label: String,
    pub review_note: Option<String>,
    pub kinds: Vec<KindOption>,
    pub sections: Vec<SectionOption>,
    pub providers: Vec<ProviderOption>,
    /// 已有的配图（编辑页展示、可排序、可删除）。
    pub images: Vec<EditImageView>,
    pub image_count: i64,
    /// 已有的下载来源（**必须回填**：编辑保存会整体重写来源，漏了就全丢了）。
    pub sources: Vec<SourceSlot>,
    // 用 String 而不是借用：模板结构体要能独立于调用方的局部变量返回
    pub title: String,
    pub body: String,
}

/// 编辑用户（管理面板里点铅笔进来）。
#[derive(Template)]
#[template(path = "admin_user.html")]
pub struct AdminUserEditTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub is_staff: bool,
    pub csrf: String,
    pub user: AdminUserView,
    pub roles: Vec<(String, String)>,
    /// 只有超级管理员能改等级与显示名。
    pub is_super: bool,
}

/// 编辑页里的一张配图：带 id 与顺序，可前移/后移/删除。
pub struct EditImageView {
    pub id: i64,
    pub href: String,
    /// 从 1 开始的展示序号。
    pub number: usize,
    pub is_first: bool,
    pub is_last: bool,
}

/// 数据备份页（仅超级管理员）。
#[derive(Template)]
#[template(path = "backup.html")]
pub struct BackupTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub is_staff: bool,
    pub csrf: String,
    pub files: Vec<BackupFileView>,
    pub dir: String,
}

/// 一个备份文件。
pub struct BackupFileView {
    pub name: String,
    pub size: String,
    pub modified: String,
}

/// 我的收藏。
#[derive(Template)]
#[template(path = "bookmarks.html")]
pub struct BookmarksTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub is_staff: bool,
    pub csrf: String,
    pub items: Vec<BookmarkView>,
}

/// 收藏条目。
pub struct BookmarkView {
    pub id: i64,
    pub title: String,
    pub section_label: String,
    pub when: String,
}

/// 通知中心。
#[derive(Template)]
#[template(path = "notifications.html")]
pub struct NotificationsTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub is_staff: bool,
    pub csrf: String,
    pub items: Vec<NotificationView>,
}

/// 一条通知。
pub struct NotificationView {
    pub kind: String,
    pub title: String,
    pub body: String,
    pub link: Option<String>,
    pub when: String,
    pub unread: bool,
}

/// 系统公告页。
#[derive(Template)]
#[template(path = "announcements.html")]
pub struct AnnouncementsTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub is_staff: bool,
    pub csrf: String,
    pub items: Vec<AnnouncementView>,
}

/// 一条公告。
pub struct AnnouncementView {
    pub title: String,
    pub body: String,
    pub when: String,
}

/// 私信收件箱。
#[derive(Template)]
#[template(path = "messages.html")]
pub struct MessagesTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub is_staff: bool,
    pub csrf: String,
    pub conversations: Vec<ConversationView>,
}

/// 会话列表一行。
pub struct ConversationView {
    pub handle: String,
    pub display_name: String,
    pub avatar: Option<String>,
    pub preview: String,
    pub when: String,
    pub from_me: bool,
    pub unread: i64,
}

/// 一个会话。
#[derive(Template)]
#[template(path = "thread.html")]
pub struct ThreadTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub is_staff: bool,
    pub csrf: String,
    pub handle: String,
    pub display_name: String,
    pub avatar: Option<String>,
    pub messages: Vec<MessageView>,
    pub blocked: bool,
}

/// 一条私信。
pub struct MessageView {
    pub mine: bool,
    pub body: String,
    pub when: String,
    pub read: bool,
}

/// 黑名单一行（账户设置里展示）。
pub struct BlockView {
    pub handle: String,
    pub display_name: String,
    pub avatar: Option<String>,
    pub when: String,
}

/// 账户设置页（左侧分栏 + 右侧内容，形态参考雨云的账户设置）。
#[derive(Template)]
#[template(path = "settings.html")]
pub struct SettingsTemplate<'a> {
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub is_staff: bool,
    pub csrf: String,
    pub handle: String,
    pub display_name: String,
    pub role_label: String,
    pub avatar: Option<String>,
    pub joined_at: String,
    pub audit: Vec<DebugAuditView>,
    pub blocks: Vec<BlockView>,
    pub notice: Option<String>,
    pub error: Option<String>,
    /// 认证开发者及以上才能开打赏（与上传收款码同一权限）。
    /// 个人简介（200 字上限；改动走审核，当前自动放行）。
    pub bio: String,
    pub can_donate: bool,
    pub donation_visible: bool,
    pub donation_notice_visible: bool,
    pub donation_notice_text: String,
    pub donation_channels: Vec<DonationChannelView>,
}

/// 用户主页。
#[derive(Template)]
#[template(path = "profile.html")]
pub struct ProfileTemplate<'a> {
    pub is_staff: bool,
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub csrf: String,
    pub handle: String,
    pub display_name: String,
    pub role_label: String,
    pub avatar: Option<String>,
    pub joined_at: String,
    pub is_self: bool,
    /// 当前查看者是否已拉黑 TA。
    pub blocked: bool,
    /// 是否登录（决定能否私信 / 拉黑）。
    pub can_interact: bool,
    /// 本人或管理员才看得到「换头像」。
    pub can_edit_avatar: bool,
    pub posts: Vec<FeedView>,
    pub accepted: i64,
    /// 打赏弹窗/提示的样式编号（主页没有预览开关，生产值即已评审通过的那套）。
    pub donate_variant: u8,
    pub notice_variant: u8,
    /// 佩戴的头衔（名字后面渲染）；没戴就是 None。
    pub title: Option<TitleBadgeView>,
    /// 头衔样式编号（1 胶囊 / 2 徽章 / 3 渐变下划线），生产用 1。
    pub title_variant: u8,
    /// 本人或管理员可以点简介就地编辑。
    pub can_edit_bio: bool,
    /// 本人持有的头衔（点头衔弹出切换列表）；别人的主页为空。
    pub my_titles: Vec<TitleChoice>,
    /// 个人简介（未通过审核时只有本人与管理员看得到）。
    pub bio: Option<String>,
    /// 简介的审核态：approved / pending / rejected。
    pub bio_state: String,
    /// 预览用的头部样式编号（1/2/3，生产恒为 1）。
    pub header_variant: u8,
    /// 「支持作者」区块：作者开了展示、且有渠道时才出现。
    pub donation_visible: bool,
    pub donation_channels: Vec<DonationChannelView>,
    pub donation_notice: Option<String>,
}

/// 调试页（开发自检；生产实例不注册该路由）。
#[derive(Template)]
#[template(path = "debug.html")]
pub struct DebugTemplate<'a> {
    pub is_staff: bool,
    pub csrf: String,
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub version: &'a str,
    pub bind: String,
    pub data_dir: String,
    pub download_mode: String,
    pub free_human: String,
    pub min_free_human: String,
    pub storage_ok: bool,
    pub users: i64,
    pub posts: i64,
    pub comments: i64,
    pub pending_images: i64,
    pub audit: Vec<DebugAuditView>,
}

/// 调试页里的审计行。
pub struct DebugAuditView {
    pub created_at: String,
    pub action: String,
    pub target: String,
    pub detail: String,
}

/// 管理员面板。
#[derive(Template)]
#[template(path = "admin.html")]
pub struct AdminTemplate<'a> {
    pub is_staff: bool,
    /// 磁盘预算总览（仅超级管理员可见）。
    pub server_free_human: String,
    pub quota_allocated_human: String,
    pub quota_used_human: String,
    pub quota_unused_human: String,
    /// 是否还有未分配的可用空间（分配总量超过服务器空闲时给出提示）。
    pub quota_over_committed: bool,
    /// 当前搜索词（回填到搜索框）。
    pub query: String,
    /// 用户总数（不受搜索影响）。
    pub total_users: i64,
    /// 页面上算「多久以前」用的时间基准。
    pub now: i64,
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub csrf: String,
    /// 当前管理员是否超级管理员（决定能否改等级/显示名）。
    pub is_super: bool,
    pub require_activation: bool,
    /// (值, 显示名)
    pub roles: Vec<(String, String)>,
    pub users: Vec<AdminUserView>,
    /// 待审核的帖子（按提交时间正序，先来先审）。
    pub pending: Vec<FeedView>,
    /// 分区与它们的封面（封面卡片用）。
    pub sections: Vec<SectionOption>,
}

/// 管理员面板里的用户行。
pub struct AdminUserView {
    pub id: i64,
    /// 是否被信任（发帖只走自动审核）。
    pub trusted: bool,
    pub email: String,
    /// 已分配预算（可读文本，如「1 GB」）。
    pub quota_human: String,
    /// 分配给该账号的 GB 数（表单回填用，保留一位小数）。
    pub quota_gb: String,
    /// 已占用（可读文本）。
    pub used_human: String,
    pub last_seen: String,
    pub created_from_now: String,
    pub avatar: Option<String>,
    pub handle: String,
    pub display_name: String,
    /// 无头像时圆形底上显示的首字符。
    pub initial: String,
    /// 无头像时的配色序号（0..5），对应 CSS 里的 c0..c5。
    pub color_index: i64,
    /// 最近 5 分钟内有活动（列表上的绿点）。
    pub online: bool,
    pub role: String,
    pub role_label: String,
    pub activated: bool,
    pub created_at: String,
    pub is_self: bool,
}

/// 发帖类型选项。
pub struct KindOption {
    pub value: String,
    pub label: String,
    pub hint: String,
    pub checked: bool,
}

/// 点击后按需加载的登录注册弹窗，不包含用户数据。
#[derive(Template)]
#[template(path = "auth_dialog.html")]
pub struct AuthDialogTemplate {}

/// 登录页。
#[derive(Template)]
#[template(path = "login.html")]
pub struct LoginTemplate<'a> {
    pub is_staff: bool,
    pub csrf: String,
    pub site_name: &'a str,
    pub user_label: Option<String>,
    pub error: Option<String>,
    pub account: &'a str,
}

/// 注册页。
#[derive(Template)]
#[template(path = "register.html")]
pub struct RegisterTemplate<'a> {
    pub is_staff: bool,
    pub csrf: String,
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
/// 相对时间（「几秒前 / 3 小时前 / 2 年前」）。管理页用它，比绝对时间直观。
pub fn format_relative(ts: i64, now: i64) -> String {
    let delta = (now - ts).max(0);
    match delta {
        0..=59 => "几秒前".to_string(),
        60..=3599 => format!("{} 分钟前", delta / 60),
        3600..=86_399 => format!("{} 小时前", delta / 3600),
        86_400..=2_591_999 => format!("{} 天前", delta / 86_400),
        2_592_000..=31_535_999 => format!("{} 个月前", delta / 2_592_000),
        _ => format!("{} 年前", delta / 31_536_000),
    }
}

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
