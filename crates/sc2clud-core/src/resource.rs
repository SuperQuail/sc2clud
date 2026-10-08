//! 帖子分区与资源来源。
//!
//! 两件事放一起是因为它们都是「资源帖的结构」：
//!
//! - [`PostSection`]：帖子归到哪个分区（原版战役 mod / 自制战役 / 工具…）；
//! - [`ResourceProvider`]：下载来源是哪个网盘或代码托管（含国内常见网盘）。
//!
//! GitHub 来源额外支持**镜像跳转**：见 [`github_mirrors`]。

use crate::error::{Error, Result};

/// 帖子分区。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostSection {
    /// 原版战役 mod（对官方战役的修改）。
    VanillaMod,
    /// 自制战役（整段新战役）。
    CustomCampaign,
    /// 工具（玩家用）。
    ToolPlayer,
    /// 工具（开发者用）。
    ToolDev,
}

impl PostSection {
    pub const ALL: [PostSection; 4] = [
        PostSection::VanillaMod,
        PostSection::CustomCampaign,
        PostSection::ToolPlayer,
        PostSection::ToolDev,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            PostSection::VanillaMod => "vanilla_mod",
            PostSection::CustomCampaign => "custom_campaign",
            PostSection::ToolPlayer => "tool_player",
            PostSection::ToolDev => "tool_dev",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PostSection::VanillaMod => "原版战役 mod",
            PostSection::CustomCampaign => "自制战役",
            PostSection::ToolPlayer => "工具（玩家用）",
            PostSection::ToolDev => "工具（开发者用）",
        }
    }

    /// 默认分区：新建帖子时的预选项。
    pub fn default_section() -> Self {
        PostSection::CustomCampaign
    }

    pub fn parse(raw: &str) -> Result<Self> {
        for section in Self::ALL {
            if section.as_str() == raw {
                return Ok(section);
            }
        }
        Err(Error::InvalidInput(format!("未知分区：{raw}")))
    }
}

/// 资源来源。国内常见网盘 + GitHub + 直链。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceProvider {
    BaiduPan,
    QuarkPan,
    AliyunPan,
    LanzouPan,
    Pan123,
    WeiyunPan,
    GitHub,
    Direct,
}

impl ResourceProvider {
    pub const ALL: [ResourceProvider; 8] = [
        ResourceProvider::BaiduPan,
        ResourceProvider::QuarkPan,
        ResourceProvider::AliyunPan,
        ResourceProvider::LanzouPan,
        ResourceProvider::Pan123,
        ResourceProvider::WeiyunPan,
        ResourceProvider::GitHub,
        ResourceProvider::Direct,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ResourceProvider::BaiduPan => "baidu",
            ResourceProvider::QuarkPan => "quark",
            ResourceProvider::AliyunPan => "aliyun",
            ResourceProvider::LanzouPan => "lanzou",
            ResourceProvider::Pan123 => "123pan",
            ResourceProvider::WeiyunPan => "weiyun",
            ResourceProvider::GitHub => "github",
            ResourceProvider::Direct => "direct",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ResourceProvider::BaiduPan => "百度网盘",
            ResourceProvider::QuarkPan => "夸克网盘",
            ResourceProvider::AliyunPan => "阿里云盘",
            ResourceProvider::LanzouPan => "蓝奏云",
            ResourceProvider::Pan123 => "123 云盘",
            ResourceProvider::WeiyunPan => "腾讯微云",
            ResourceProvider::GitHub => "GitHub",
            ResourceProvider::Direct => "直链 / 其他",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        for provider in Self::ALL {
            if provider.as_str() == raw {
                return Ok(provider);
            }
        }
        Err(Error::InvalidInput(format!("未知资源来源：{raw}")))
    }

    /// GitHub 来源要额外给镜像跳转。
    pub fn is_github(self) -> bool {
        matches!(self, ResourceProvider::GitHub)
    }
}

/// 校验下载地址：只允许 http/https，且必须是合法 URL。
pub fn validate_resource_url(raw: &str) -> Result<String> {
    let url = raw.trim();
    if url.is_empty() {
        return Err(Error::InvalidInput("下载地址不能为空".to_string()));
    }
    if url.len() > 500 {
        return Err(Error::InvalidInput("下载地址过长".to_string()));
    }
    if url.chars().any(char::is_whitespace) {
        return Err(Error::InvalidInput("下载地址不能含空白字符".to_string()));
    }
    let lowered = url.to_ascii_lowercase();
    if !(lowered.starts_with("https://") || lowered.starts_with("http://")) {
        return Err(Error::InvalidInput(
            "下载地址必须以 http:// 或 https:// 开头".to_string(),
        ));
    }
    Ok(url.to_string())
}

/// 网盘提取码：可选，允许 2..=8 位字母数字。
pub fn validate_extract_code(raw: &str) -> Result<Option<String>> {
    let code = raw.trim();
    if code.is_empty() {
        return Ok(None);
    }
    if !(2..=8).contains(&code.chars().count()) || !code.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return Err(Error::InvalidInput(
            "提取码应为 2–8 位字母或数字".to_string(),
        ));
    }
    Ok(Some(code.to_ascii_lowercase()))
}

/// GitHub 镜像条目。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitHubMirror {
    pub label: String,
    pub url: String,
    /// 原始地址（不是镜像）：用户也可以只复制原链。
    pub is_original: bool,
}

/// 默认镜像模板：`{url}` 会被替换成原始 GitHub 地址。
///
/// 这些公共服务变化很快（域名挂掉是常态），所以做成**配置项**
/// （`resources.github_mirrors`）：运维发现某个镜像不可用时改配置即可，不必重新编译。
pub const DEFAULT_GITHUB_MIRRORS: [&str; 5] = [
    "https://ghproxy.net/{url}",
    "https://gh-proxy.com/{url}",
    "https://ghfast.top/{url}",
    "https://hub.gitmirror.com/{url}",
    "https://github.moeyy.xyz/{url}",
];

/// 是否为 GitHub 系地址（决定要不要生成镜像候选）。
pub fn is_github_url(url: &str) -> bool {
    let lowered = url.to_ascii_lowercase();
    lowered.contains("github.com/")
        || lowered.contains("githubusercontent.com/")
        || lowered.contains("github.io/")
}

/// 生成镜像候选：原始地址排第一（`is_original = true`），随后是各镜像。
///
/// 排序与「最快的那个」由前端实测决定（见 `web/src/islands/mirrors.ts`）：
/// 服务端只给出候选，避免在后端拿着用户的网络状况瞎猜。
pub fn github_mirrors(original: &str, templates: &[String]) -> Vec<GitHubMirror> {
    let original = original.trim();
    if !is_github_url(original) {
        return Vec::new();
    }
    let mut out = Vec::with_capacity(templates.len() + 1);
    out.push(GitHubMirror {
        label: "GitHub 原链".to_string(),
        url: original.to_string(),
        is_original: true,
    });
    for template in templates {
        let template = template.trim();
        if template.is_empty() || !template.contains("{url}") {
            continue;
        }
        let host = template
            .split("://")
            .nth(1)
            .and_then(|rest| rest.split('/').next())
            .unwrap_or(template)
            .to_string();
        out.push(GitHubMirror {
            label: host,
            url: template.replace("{url}", original),
            is_original: false,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections_round_trip() {
        for section in PostSection::ALL {
            assert_eq!(PostSection::parse(section.as_str()).expect("ok"), section);
        }
        assert_eq!(PostSection::default_section(), PostSection::CustomCampaign);
        assert!(PostSection::parse("nope").is_err());
    }

    #[test]
    fn providers_round_trip_and_flag_github() {
        for provider in ResourceProvider::ALL {
            assert_eq!(
                ResourceProvider::parse(provider.as_str()).expect("ok"),
                provider
            );
        }
        assert!(ResourceProvider::GitHub.is_github());
        assert!(!ResourceProvider::BaiduPan.is_github());
        assert_eq!(ResourceProvider::BaiduPan.label(), "百度网盘");
    }

    #[test]
    fn resource_url_must_be_http() {
        assert!(validate_resource_url("https://pan.baidu.com/s/abc").is_ok());
        assert!(validate_resource_url("http://example.com/x").is_ok());
        assert!(validate_resource_url("pan.baidu.com/s/abc").is_err());
        assert!(validate_resource_url("javascript:alert(1)").is_err());
        assert!(validate_resource_url("https://a b.com").is_err());
    }

    #[test]
    fn extract_code_is_optional_and_normalized() {
        assert_eq!(validate_extract_code("").expect("ok"), None);
        assert_eq!(
            validate_extract_code(" a1B2 ").expect("ok"),
            Some("a1b2".into())
        );
        assert!(validate_extract_code("x").is_err(), "1 位太短");
        assert!(validate_extract_code("abcdefghi").is_err(), "9 位太长");
        assert!(validate_extract_code("a-1").is_err(), "只允许字母数字");
    }

    #[test]
    fn github_detection() {
        assert!(is_github_url(
            "https://github.com/a/b/releases/download/v1/x.exe"
        ));
        assert!(is_github_url(
            "https://raw.githubusercontent.com/a/b/main/x"
        ));
        assert!(!is_github_url("https://pan.baidu.com/s/abc"));
    }

    #[test]
    fn mirrors_put_original_first_and_substitute() {
        let templates: Vec<String> = DEFAULT_GITHUB_MIRRORS
            .iter()
            .map(|s| s.to_string())
            .collect();
        let url = "https://github.com/a/b/releases/download/v1/x.exe";
        let mirrors = github_mirrors(url, &templates);
        assert_eq!(mirrors.len(), templates.len() + 1);
        assert!(mirrors[0].is_original);
        assert_eq!(mirrors[0].url, url);
        assert!(
            mirrors[1]
                .url
                .starts_with("https://ghproxy.net/https://github.com/")
        );
        assert!(!mirrors[1].url.contains("{url}"), "占位符必须被替换");

        // 非 GitHub 地址不给镜像
        assert!(github_mirrors("https://pan.baidu.com/s/abc", &templates).is_empty());
    }

    #[test]
    fn broken_templates_are_skipped() {
        let templates = vec![
            "https://ok.example/{url}".to_string(),
            "没有占位符".to_string(),
        ];
        let mirrors = github_mirrors("https://github.com/a/b", &templates);
        assert_eq!(mirrors.len(), 2, "只有原链 + 一个合法模板");
    }
}
