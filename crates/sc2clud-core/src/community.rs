//! 社区结构：分区、用户组、头衔、等级经验。
//!
//! 这些数据的**形状**（而不是它们的存储）放在 core：Web 层与 DB 层都要用同一套判定，
//! 判定逻辑写两遍迟早会不一致。

use crate::auth::Role;
use crate::resource::PostSection;

/// 一条分区记录。
///
/// 分区原来写死在 [`PostSection`] 枚举里；管理员要能新建 / 归档 / 排序之后，
/// 枚举只作为**初始种子**，真实状态以这张表为准。
#[derive(Debug, Clone)]
pub struct SectionRecord {
    pub key: String,
    pub label: String,
    pub description: String,
    pub position: i64,
    /// 归档后不再展示，但**内容不删**，随时可以取回来。
    pub archived: bool,
    /// 允许发帖的最低等级。
    pub post_min_role: Role,
    /// 允许回帖的最低等级。
    pub reply_min_role: Role,
}

impl SectionRecord {
    /// 能不能发帖（游客一概不行）。
    pub fn can_post(&self, role: Option<Role>) -> bool {
        !self.archived && role.is_some_and(|role| role >= self.post_min_role)
    }

    /// 能不能回帖（与发帖**分开判定**：可以只放开回帖不放开发帖）。
    pub fn can_reply(&self, role: Option<Role>) -> bool {
        !self.archived && role.is_some_and(|role| role >= self.reply_min_role)
    }

    /// 归档分区不接受新内容。
    pub fn accepts_content(&self) -> bool {
        !self.archived
    }
}

impl From<&PostSection> for SectionRecord {
    fn from(section: &PostSection) -> Self {
        let post_min = section.required_permission().min_role();
        Self {
            key: section.as_str().to_string(),
            label: section.label().to_string(),
            description: String::new(),
            position: 0,
            archived: false,
            post_min_role: post_min.unwrap_or(Role::Member),
            reply_min_role: Role::Member,
        }
    }
}

/// 用户组：给「更精确的限制」用（目前落到分区的发帖 / 回帖白名单）。
#[derive(Debug, Clone)]
pub struct UserGroupRecord {
    pub id: i64,
    pub key: String,
    pub name: String,
    pub description: String,
    pub archived: bool,
}

/// 组 × 分区 的发言规则。
#[derive(Debug, Clone, Copy)]
pub struct GroupSectionRule {
    pub group_id: i64,
    pub can_post: bool,
    pub can_reply: bool,
}

/// 头衔：一个用户可以有多个，佩戴其中一个（或都不戴）。
#[derive(Debug, Clone)]
pub struct TitleRecord {
    pub id: i64,
    pub key: String,
    pub name: String,
    pub color: String,
    pub description: String,
    pub archived: bool,
}

/// 等级曲线：先给个**简单递增**的公式，等真正接入经验增长时再调。
///
/// 每级所需经验 = 100 × 等级²（累计量），因此等级 = ⌊√(exp/100)⌋ + 1。
pub const EXP_PER_LEVEL_BASE: i64 = 100;

/// 某个经验值对应的等级（至少 1 级）。
pub fn level_for_exp(exp: i64) -> i64 {
    if exp <= 0 {
        return 1;
    }
    let steps = (exp / EXP_PER_LEVEL_BASE) as f64;
    (steps.sqrt().floor() as i64) + 1
}

/// 升到某个等级所需的**累计**经验，用于展示进度条（前端后用）。
pub fn exp_for_level(level: i64) -> i64 {
    let level = level.max(1) - 1;
    EXP_PER_LEVEL_BASE * level * level
}

/// 从**任意域名、任意路径前缀**的站点链接里解析出帖子 id。
///
/// 只认路径里 `…/p/<数字>` 这一段，不看域名——以后加域名（含 `/dev` 这类前缀）都不用改。
/// shortcut: 不校验域名，站外 `…/p/12` 也会解析成我们的 12 号帖（调用方只用来取标题，风险可接受）。
pub fn parse_post_link(raw: &str) -> Option<i64> {
    let path = raw.trim().split(['?', '#']).next()?;
    let mut segments = path.split('/').peekable();
    while let Some(segment) = segments.next() {
        if segment.eq_ignore_ascii_case("p") {
            return segments.next()?.parse::<i64>().ok();
        }
    }
    None
}

/// 资源帖状态：作者对外声明这个资源还管不管。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceStatus {
    /// 持续更新。
    Active,
    /// 接受 bug 修复（不再加新功能，但收 bug）。
    AcceptingFixes,
    /// 停止维护。
    Maintenance,
}

impl ResourceStatus {
    pub const ALL: [ResourceStatus; 3] = [
        ResourceStatus::Active,
        ResourceStatus::AcceptingFixes,
        ResourceStatus::Maintenance,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ResourceStatus::Active => "active",
            ResourceStatus::AcceptingFixes => "accepting_fixes",
            ResourceStatus::Maintenance => "maintenance",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ResourceStatus::Active => "持续更新",
            ResourceStatus::AcceptingFixes => "接受 bug 修复",
            ResourceStatus::Maintenance => "停止维护",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, crate::Error> {
        match raw.trim() {
            "active" => Ok(ResourceStatus::Active),
            "accepting_fixes" => Ok(ResourceStatus::AcceptingFixes),
            "maintenance" => Ok(ResourceStatus::Maintenance),
            other => Err(crate::Error::InvalidInput(format!("未知资源状态：{other}"))),
        }
    }
}

/// 把域名规范化：小写、去端口、去开头 `www.`、去结尾的点。
///
/// 「哪些域名是我们的」统一按这个形状比较，避免 `WWW.X.fun:80` 与 `x.fun` 被当成两个站。
pub fn normalize_domain(raw: &str) -> Option<String> {
    // 允许传完整 URL：先剥掉协议
    let raw = raw.trim();
    let raw = raw.split("://").nth(1).unwrap_or(raw);
    let host = raw.split(['/', '?', '#']).next()?;
    let host = host.split('@').next_back()?;
    let host = host.split(':').next()?;
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || !host.contains('.') {
        return None;
    }
    Some(host.strip_prefix("www.").unwrap_or(&host).to_string())
}

/// 取链接的域名（规范化后）。没写协议的也认：`x.fun/p/1` → `x.fun`。
pub fn link_domain(raw: &str) -> Option<String> {
    let rest = raw.trim();
    let after_scheme = rest.split("://").nth(1).unwrap_or(rest);
    normalize_domain(after_scheme)
}

/// 链接是不是本站的：域名在允许集合里（忽略协议、大小写、`www.`、端口）。
pub fn is_site_link(raw: &str, allowed: &[String]) -> bool {
    let Some(domain) = link_domain(raw) else {
        return false;
    };
    allowed
        .iter()
        .filter_map(|entry| normalize_domain(entry))
        .any(|entry| entry == domain)
}

/// issue 类型：bug / 功能建议 / 其它。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueKind {
    Bug,
    Feature,
    Other,
}

impl IssueKind {
    pub const ALL: [IssueKind; 3] = [IssueKind::Bug, IssueKind::Feature, IssueKind::Other];

    pub fn as_str(self) -> &'static str {
        match self {
            IssueKind::Bug => "bug",
            IssueKind::Feature => "feature",
            IssueKind::Other => "other",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            IssueKind::Bug => "Bug 反馈",
            IssueKind::Feature => "功能建议",
            IssueKind::Other => "其它",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, crate::Error> {
        match raw.trim() {
            "bug" => Ok(IssueKind::Bug),
            "feature" => Ok(IssueKind::Feature),
            "other" => Ok(IssueKind::Other),
            other => Err(crate::Error::InvalidInput(format!(
                "未知 issue 类型：{other}"
            ))),
        }
    }
}

/// issue 状态：开着 / 已关闭。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IssueState {
    Open,
    Closed,
}

impl IssueState {
    pub fn as_str(self) -> &'static str {
        match self {
            IssueState::Open => "open",
            IssueState::Closed => "closed",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            IssueState::Open => "待处理",
            IssueState::Closed => "已关闭",
        }
    }

    pub fn parse(raw: &str) -> Result<Self, crate::Error> {
        match raw.trim() {
            "open" => Ok(IssueState::Open),
            "closed" => Ok(IssueState::Closed),
            other => Err(crate::Error::InvalidInput(format!(
                "未知 issue 状态：{other}"
            ))),
        }
    }
}

#[cfg(test)]
mod domain_tests {
    use super::*;

    #[test]
    fn normalizes_domains_the_same_way() {
        for (raw, want) in [
            ("WWW.X.fun", "x.fun"),
            ("x.fun:8080", "x.fun"),
            ("xn--xpra07ba.fun.", "xn--xpra07ba.fun"),
            ("https://www.x.fun/p/1", "x.fun"),
            ("user:pw@x.fun", "x.fun"),
        ] {
            assert_eq!(normalize_domain(raw).as_deref(), Some(want), "{raw}");
        }
        assert!(normalize_domain("localhost").is_none());
        assert!(normalize_domain("").is_none());
    }

    #[test]
    fn accepts_only_our_domains() {
        let ours = vec!["xn--xpra07ba.fun".to_string(), "x.fun".to_string()];
        assert!(is_site_link("http://www.xn--xpra07ba.fun/p/12", &ours));
        assert!(is_site_link("https://x.fun/dev/p/12", &ours));
        assert!(is_site_link("X.FUN:443/p/12", &ours), "没写协议也认");
        assert!(!is_site_link("https://evil.example/p/12", &ours));
        assert!(!is_site_link("not a link", &ours));
    }

    #[test]
    fn issue_enums_round_trip() {
        for kind in IssueKind::ALL {
            assert_eq!(IssueKind::parse(kind.as_str()).expect("ok"), kind);
        }
        for state in [IssueState::Open, IssueState::Closed] {
            assert_eq!(IssueState::parse(state.as_str()).expect("ok"), state);
        }
        assert!(IssueKind::parse("nope").is_err());
    }
}
#[cfg(test)]
mod link_tests {
    use super::*;

    #[test]
    fn parses_links_from_any_domain_or_prefix() {
        for (raw, want) in [
            ("https://sc2clud.example/p/12", 12),
            ("http://www.叽叽咕咕.fun/p/12", 12),
            ("http://www.xn--xpra07ba.fun/dev/p/12", 12),
            ("https://a.b.c/some/prefix/p/12/", 12),
            ("https://a.b.c/p/12?from=share#top", 12),
            ("/p/12", 12),
            ("p/12", 12),
            ("  https://x.y/P/12  ", 12),
        ] {
            assert_eq!(parse_post_link(raw), Some(want), "解析失败：{raw}");
        }
    }

    #[test]
    fn rejects_non_post_links() {
        for raw in [
            "",
            "https://x.y/u/tangtian",
            "https://x.y/p/",
            "https://x.y/p/abc",
            "12",
            "https://x.y/posts/12",
            // 超范围数字应当被拒，而不是溢出
            "https://x.y/p/99999999999999999999",
        ] {
            assert_eq!(parse_post_link(raw), None, "不该解析：{raw}");
        }
    }

    #[test]
    fn resource_status_round_trips() {
        for status in ResourceStatus::ALL {
            assert_eq!(ResourceStatus::parse(status.as_str()).expect("ok"), status);
            assert!(!status.label().is_empty());
        }
        assert!(ResourceStatus::parse("nope").is_err());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_curve_is_monotonic() {
        assert_eq!(level_for_exp(0), 1);
        assert_eq!(level_for_exp(-5), 1);
        let mut last = 0;
        for exp in [0, 99, 100, 399, 400, 899, 900, 1600, 10_000] {
            let level = level_for_exp(exp);
            assert!(level >= last, "等级必须单调不减：exp={exp}");
            last = level;
        }
        assert_eq!(level_for_exp(100), 2);
        assert_eq!(level_for_exp(400), 3);
        assert_eq!(level_for_exp(900), 4);
    }

    #[test]
    fn exp_for_level_round_trips() {
        for level in 1..12 {
            let exp = exp_for_level(level);
            assert_eq!(level_for_exp(exp), level, "level={level} exp={exp}");
        }
    }

    #[test]
    fn section_gates_post_and_reply_separately() {
        let section = SectionRecord {
            key: "announcement".to_string(),
            label: "公告".to_string(),
            description: String::new(),
            position: 0,
            archived: false,
            post_min_role: Role::Admin,
            reply_min_role: Role::Member,
        };
        // 普通用户能回不能发
        assert!(!section.can_post(Some(Role::Member)));
        assert!(section.can_reply(Some(Role::Member)));
        // 管理员两者都能
        assert!(section.can_post(Some(Role::Admin)));
        assert!(section.can_reply(Some(Role::Admin)));
        // 游客都不行
        assert!(!section.can_post(None));
        assert!(!section.can_reply(None));
    }

    #[test]
    fn archived_section_accepts_nothing() {
        let mut section = SectionRecord::from(&PostSection::default_section());
        section.archived = true;
        assert!(!section.can_post(Some(Role::Super)));
        assert!(!section.can_reply(Some(Role::Super)));
        assert!(!section.accepts_content());
    }
}
