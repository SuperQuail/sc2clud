//! 帖子类型与审核机。
//!
//! 设计要点（对齐当前阶段「所有帖子走审核，但暂时不卡审核」）：
//!
//! - **默认放行**：绝大多数帖子被审核机直接判为 `Approved`；
//! - 只有命中硬规则（长度、图片数）才 `Rejected`；
//! - 命中可疑规则（广告词、外链过多、资源帖空手）转 `Pending` 人工复核，
//!   但 `Pending` **仍然可见**——既保留审核流水，又不真的卡住发布；
//! - 只有 `Rejected` 从列表里消失。
//!
//! 规则放在领域层而不是处理器里：能单测，也能被后台脚本复用。

use crate::auth::{Permission, Role};
use crate::error::{Error, Result};

/// 单帖图片上限：主帖最多 10 张；**回复不允许带图**（由 Web 层拒绝）。
pub const MAX_IMAGES_PER_POST: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PostKind {
    /// 普通讨论贴（普通用户可发）。
    Discussion,
    /// 资源贴（认证开发者及以上）。
    Resource,
    /// 转载资源贴（普通用户可发）。
    Repost,
}

impl PostKind {
    pub const ALL: [PostKind; 3] = [PostKind::Discussion, PostKind::Resource, PostKind::Repost];

    pub fn as_str(self) -> &'static str {
        match self {
            PostKind::Discussion => "discussion",
            PostKind::Resource => "resource",
            PostKind::Repost => "repost",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            PostKind::Discussion => "讨论",
            PostKind::Resource => "资源",
            PostKind::Repost => "转载",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        match raw {
            "discussion" => Ok(PostKind::Discussion),
            "resource" => Ok(PostKind::Resource),
            "repost" => Ok(PostKind::Repost),
            other => Err(Error::InvalidInput(format!("未知帖子类型：{other}"))),
        }
    }

    /// 发这种帖子需要的权限。
    pub fn required_permission(self) -> Permission {
        match self {
            PostKind::Discussion => Permission::CreateDiscussion,
            PostKind::Resource => Permission::CreateResource,
            PostKind::Repost => Permission::CreateRepost,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReviewState {
    Pending,
    Approved,
    /// 打回：作者需要修改后重新提交（作者与管理员可见）。
    Revision,
    Rejected,
}

impl ReviewState {
    pub const ALL: [ReviewState; 4] = [
        ReviewState::Pending,
        ReviewState::Approved,
        ReviewState::Revision,
        ReviewState::Rejected,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ReviewState::Pending => "pending",
            ReviewState::Approved => "approved",
            ReviewState::Revision => "revision",
            ReviewState::Rejected => "rejected",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            ReviewState::Pending => "审核中",
            ReviewState::Approved => "已通过",
            ReviewState::Revision => "需修改",
            ReviewState::Rejected => "已拒绝",
        }
    }

    pub fn parse(raw: &str) -> Result<Self> {
        match raw {
            "pending" => Ok(ReviewState::Pending),
            "approved" => Ok(ReviewState::Approved),
            "revision" => Ok(ReviewState::Revision),
            "rejected" => Ok(ReviewState::Rejected),
            other => Err(Error::InvalidInput(format!("未知审核状态：{other}"))),
        }
    }

    /// 对**当前查看者**是否可见。
    ///
    /// - `approved`：所有人可见；
    /// - `pending`（审核中）/ `revision`（打回待改）：只有作者本人与管理员及以上可见；
    /// - `rejected`：只有管理员及以上可见（便于复查与改判）。
    pub fn visible_to(self, is_author: bool, is_staff: bool) -> bool {
        match self {
            ReviewState::Approved => true,
            ReviewState::Pending | ReviewState::Revision => is_author || is_staff,
            ReviewState::Rejected => is_staff,
        }
    }
}

/// 审核结论。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReviewOutcome {
    pub state: ReviewState,
    pub note: Option<String>,
    /// 是否由审核机自动判定（false = 人工改过）。
    pub automatic: bool,
}

/// 命中即转人工复核的关键词（先给一小撮；将来可挪进 `settings`）。
const SUSPICIOUS_KEYWORDS: [&str; 6] = ["加微信", "刷单", "代充", "免费领", "点击领取", "私聊"];

/// 外链数量上限：超过就转人工。
const MAX_LINKS: usize = 5;

/// 发帖时的审核入口：**管理员及以上直接放行，不走审核机**。
///
/// 其余角色一律过审核机（绝大多数会直接通过）。
/// 返回的 `automatic: false` 表示这是「人（管理动作）」的决定，不是审核机的结论。
pub fn review_for_author(
    role: Option<Role>,
    kind: PostKind,
    title: &str,
    body: &str,
    image_count: usize,
) -> ReviewOutcome {
    if role.is_some_and(|role| role >= Role::Admin) {
        return ReviewOutcome {
            state: ReviewState::Approved,
            note: Some("管理员直接发布，跳过审核机".to_string()),
            automatic: false,
        };
    }
    auto_review(kind, title, body, image_count)
}

/// 审核机：**绝大多数情况直接过**。
pub fn auto_review(kind: PostKind, title: &str, body: &str, image_count: usize) -> ReviewOutcome {
    let reject = |note: &str| ReviewOutcome {
        state: ReviewState::Rejected,
        note: Some(note.to_string()),
        automatic: true,
    };
    let review = |note: String| ReviewOutcome {
        state: ReviewState::Pending,
        note: Some(note),
        automatic: true,
    };

    let title_chars = title.trim().chars().count();
    let body_chars = body.trim().chars().count();

    // ---- 硬规则：直接拒绝 ----
    if title_chars < 2 {
        return reject("标题过短");
    }
    if title_chars > 120 {
        return reject("标题过长");
    }
    if body_chars < 2 {
        return reject("正文过短");
    }
    if body_chars > 20_000 {
        return reject("正文过长");
    }
    if image_count > MAX_IMAGES_PER_POST {
        return reject(&format!("图片超过 {MAX_IMAGES_PER_POST} 张"));
    }

    // ---- 可疑规则：转人工（帖子仍可见）----
    let haystack = format!("{title}\n{body}");
    if let Some(hit) = SUSPICIOUS_KEYWORDS
        .iter()
        .find(|word| haystack.contains(**word))
    {
        return review(format!("命中可疑词「{hit}」"));
    }
    let links = haystack.matches("http").count();
    if links > MAX_LINKS {
        return review(format!("外链过多（{links} 处）"));
    }
    if kind == PostKind::Resource && links == 0 && image_count == 0 {
        return review("资源帖既无链接也无图".to_string());
    }

    ReviewOutcome {
        state: ReviewState::Approved,
        note: None,
        automatic: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_post_is_approved_automatically() {
        let out = auto_review(
            PostKind::Discussion,
            "新人报到",
            "大家好，第一次来这个社区。",
            0,
        );
        assert_eq!(out.state, ReviewState::Approved);
        assert!(out.note.is_none());
        assert!(out.automatic);
    }

    #[test]
    fn hard_rules_reject_immediately() {
        assert_eq!(
            auto_review(PostKind::Discussion, "x", "正文", 0).state,
            ReviewState::Rejected
        );
        assert_eq!(
            auto_review(PostKind::Discussion, "正常标题", "", 0).state,
            ReviewState::Rejected
        );
        assert_eq!(
            auto_review(
                PostKind::Discussion,
                "正常标题",
                "正文",
                MAX_IMAGES_PER_POST + 1
            )
            .state,
            ReviewState::Rejected
        );
    }

    #[test]
    fn suspicious_content_goes_to_manual_review_but_stays_visible() {
        let out = auto_review(PostKind::Discussion, "好物分享", "想要的话加微信联系我", 0);
        assert_eq!(out.state, ReviewState::Pending);
        assert!(out.note.is_some());
    }

    #[test]
    fn pending_is_visible_only_to_author_and_staff() {
        let pending = ReviewState::Pending;
        assert!(!pending.visible_to(false, false), "游客看不到审核中的帖子");
        assert!(
            pending.visible_to(true, false),
            "作者本人可以看到自己的待审帖"
        );
        assert!(pending.visible_to(false, true), "管理员可以看到");

        assert!(ReviewState::Approved.visible_to(false, false));
        assert!(!ReviewState::Rejected.visible_to(false, false));
        assert!(
            ReviewState::Rejected.visible_to(false, true),
            "被拒的帖子管理员仍能复查"
        );
    }

    #[test]
    fn admins_publish_without_review() {
        use crate::auth::Role;
        // 命中硬规则的内容，管理员仍然直接发布
        let out = review_for_author(Some(Role::Admin), PostKind::Discussion, "x", "y", 0);
        assert_eq!(out.state, ReviewState::Approved);
        assert!(!out.automatic, "管理动作不是审核机的结论");

        let super_out = review_for_author(Some(Role::Super), PostKind::Resource, "x", "y", 0);
        assert_eq!(super_out.state, ReviewState::Approved);

        // 普通用户与开发者仍然走审核机
        let member = review_for_author(Some(Role::Member), PostKind::Discussion, "x", "y", 0);
        assert_eq!(member.state, ReviewState::Rejected);
        let dev_sus = review_for_author(
            Some(Role::Developer),
            PostKind::Discussion,
            "好物",
            "加微信",
            0,
        );
        assert_eq!(dev_sus.state, ReviewState::Pending);
    }

    #[test]
    fn too_many_links_goes_to_review() {
        let body = (0..6)
            .map(|i| format!("http://host{i}.example"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            auto_review(PostKind::Discussion, "标题", &body, 0).state,
            ReviewState::Pending
        );
    }

    #[test]
    fn resource_post_without_content_goes_to_review() {
        assert_eq!(
            auto_review(PostKind::Resource, "地图包", "分享一个地图包", 0).state,
            ReviewState::Pending
        );
        assert_eq!(
            auto_review(PostKind::Resource, "地图包", "看 http://x.example", 0).state,
            ReviewState::Approved
        );
        assert_eq!(
            auto_review(PostKind::Resource, "地图包", "分享一个地图包", 1).state,
            ReviewState::Approved
        );
    }

    #[test]
    fn approved_is_the_only_publicly_visible_state() {
        assert!(ReviewState::Approved.visible_to(false, false));
        assert!(!ReviewState::Pending.visible_to(false, false));
        assert!(!ReviewState::Rejected.visible_to(false, false));
    }

    #[test]
    fn kind_and_state_round_trip() {
        for kind in PostKind::ALL {
            assert_eq!(PostKind::parse(kind.as_str()).expect("ok"), kind);
        }
        for state in ReviewState::ALL {
            assert_eq!(ReviewState::parse(state.as_str()).expect("ok"), state);
        }
        assert!(PostKind::parse("nope").is_err());
        assert!(ReviewState::parse("nope").is_err());
    }

    #[test]
    fn each_kind_requires_the_right_permission() {
        assert_eq!(
            PostKind::Resource.required_permission(),
            crate::auth::Permission::CreateResource
        );
        assert_eq!(
            PostKind::Repost.required_permission(),
            crate::auth::Permission::CreateRepost
        );
        assert_eq!(
            PostKind::Discussion.required_permission(),
            crate::auth::Permission::CreateDiscussion
        );
    }
}
