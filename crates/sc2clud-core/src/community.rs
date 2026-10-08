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
