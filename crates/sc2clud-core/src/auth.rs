//! 账号、角色与权限。
//!
//! 权限层级（自低到高）：
//!
//! ```text
//! 游客（未登录）  <  未激活用户  <  普通用户  <  认证开发者  <  网站管理员  <  超级管理员
//! ```
//!
//! 「未激活」不是角色，而是 `activated_at IS NULL` 的状态：未激活用户能登录、能看自己的待激活提示页，
//! 但不能发帖、回复、上传。这样「激活」与「角色」两条轴互不干扰（管理员也可以暂时停用某个账号）。
//!
//! 判定统一走 [`allows`]，不要在处理器里散落 `role == "admin"` 这类比较。

use crate::error::{Error, Result};

/// 已登录用户的角色。游客用 `None` 表示。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Role {
    Member,
    Developer,
    Admin,
    Super,
}

impl Role {
    pub const ALL: [Role; 4] = [Role::Member, Role::Developer, Role::Admin, Role::Super];

    /// 数据库与接口里的稳定取值（改动即破坏兼容，勿改）。
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Member => "member",
            Role::Developer => "developer",
            Role::Admin => "admin",
            Role::Super => "super",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Role::Member => "普通用户",
            Role::Developer => "认证开发者",
            Role::Admin => "网站管理员",
            Role::Super => "超级管理员",
        }
    }

    /// 解析数据库里的角色字符串；非法值一律拒绝（不静默降级成 member）。
    pub fn parse(raw: &str) -> Result<Self> {
        match raw {
            "member" => Ok(Role::Member),
            "developer" => Ok(Role::Developer),
            "admin" => Ok(Role::Admin),
            "super" => Ok(Role::Super),
            other => Err(Error::InvalidInput(format!("未知角色：{other}"))),
        }
    }
}

/// 站点上需要判定的动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    /// 浏览帖子与文件（游客即可）。
    ViewContent,
    /// 发普通讨论贴。
    CreateDiscussion,
    /// 发资源贴（认证开发者及以上）。
    CreateResource,
    /// 发转载资源贴（普通用户即可）。
    CreateRepost,
    /// 回复帖子。
    Comment,
    /// 设置自己的头像（任何已激活用户）。
    SetAvatar,
    /// 使用网盘（上传/下载/管理自己的文件）。
    ///
    /// **当前阶段只对网站管理员及以上开放**：网盘是后续施工内容，
    /// 等路径、配额、分享与清理策略定稿后再下调到普通用户。
    UseNetdisk,
    /// 上传自己的收款码（认证开发者及以上）。
    SetPaymentChannel,
    /// 域名管理（统一域名表增删）。
    ManageDomains,
    /// 发布 / 启停横幅。
    PublishBanner,
    /// 发系统公告。
    PostAnnouncement,
    /// 人工复核被审核机拦下的帖子。
    ReviewPost,
    /// 激活 / 停用用户。
    ManageUsers,
    /// 任免网站管理员，以及改站点设置。
    ManageRoles,
}

impl Permission {
    /// 该动作要求的最低角色（`None` = 游客也可）。
    pub fn min_role(self) -> Option<Role> {
        match self {
            Permission::ViewContent => None,
            Permission::CreateDiscussion
            | Permission::CreateRepost
            | Permission::Comment
            | Permission::SetAvatar => Some(Role::Member),
            // 网盘：暂只对管理员开放（施工中）
            Permission::UseNetdisk => Some(Role::Admin),
            // 讨论 / 资源 / 转载三类帖子对**所有已激活用户**开放（产品决定：不设发布门槛）。
            Permission::CreateResource => Some(Role::Member),
            // 收款码涉及钱财，只给认证开发者及以上（产品要求）。
            Permission::SetPaymentChannel => Some(Role::Developer),
            // 人工复核：管理员及以上（原为开发者，产品要求上调）。
            Permission::ReviewPost => Some(Role::Admin),
            Permission::ManageUsers => Some(Role::Admin),
            // 域名 / 横幅 / 系统公告：只有超级管理员能动（产品要求上调）。
            Permission::ManageDomains
            | Permission::PublishBanner
            | Permission::PostAnnouncement
            | Permission::ManageRoles => Some(Role::Super),
        }
    }
}

/// 唯一的权限判定入口。
///
/// `activated` 对游客与纯管理动作无意义，但对「发帖/回复/上传」是硬门槛。
pub fn allows(role: Option<Role>, activated: bool, permission: Permission) -> bool {
    let Some(required) = permission.min_role() else {
        return true; // 游客可读
    };
    let Some(role) = role else {
        return false; // 未登录
    };
    if !activated && !matches!(permission, Permission::ReviewPost) {
        // 未激活：连查看自己的管理动作都不允许，但角色达到要求的管理员必须能干活——
        // 管理员由超级管理员激活后才上岗，所以这里直接要求激活。
        return false;
    }
    role >= required
}

// ---------------------------------------------------------------- 口令

use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use rand_core::{OsRng, RngCore};

/// 生成 N 字节随机数的十六进制串（会话令牌、CSRF 令牌）。
pub fn random_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buf);
    let mut out = String::with_capacity(bytes * 2);
    for byte in buf {
        out.push(char::from_digit((byte >> 4) as u32, 16).unwrap_or('0'));
        out.push(char::from_digit((byte & 0x0f) as u32, 16).unwrap_or('0'));
    }
    out
}

/// Argon2id 口令哈希（默认参数 m=19 MiB / t=2 / p=1，2 核上约几十毫秒）。
pub fn hash_password(password: &str) -> Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| Error::InvalidInput(format!("口令哈希失败：{e}")))
}

/// 校验口令。故意只回 bool：调用方不该区分「口令错」与「哈希串损坏」。
pub fn verify_password(password: &str, stored_hash: &str) -> bool {
    let Ok(parsed) = PasswordHash::new(stored_hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed)
        .is_ok()
}

// ---------------------------------------------------------------- 注册字段校验

/// 邮箱：只做形状校验——**当前不发验证邮件**，所以这里不追求 RFC 完备。
pub fn validate_email(raw: &str) -> Result<String> {
    let email = raw.trim();
    let reject = |reason: &str| Error::InvalidInput(format!("邮箱无效：{reason}"));
    if email.len() > 254 || email.is_empty() {
        return Err(reject("长度不合法"));
    }
    if email.chars().any(char::is_whitespace) {
        return Err(reject("不能含空白字符"));
    }
    let mut parts = email.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return Err(reject("必须且只能有一个 @"));
    };
    if local.is_empty() || local.len() > 64 {
        return Err(reject("本地部分长度不合法"));
    }
    if !domain.contains('.') || domain.starts_with('.') || domain.ends_with('.') {
        return Err(reject("域名部分不合法"));
    }
    Ok(email.to_ascii_lowercase())
}

/// 用户名：3..=24 个 ASCII 字母/数字/下划线/连字符，不能以连字符开头。
pub fn validate_handle(raw: &str) -> Result<String> {
    let handle = raw.trim();
    let bad = |reason: &str| Error::InvalidInput(format!("用户名无效：{reason}"));
    let len = handle.chars().count();
    if !(3..=24).contains(&len) {
        return Err(bad("长度需为 3..24"));
    }
    if !handle
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(bad("只允许字母、数字、下划线与连字符"));
    }
    if handle.starts_with('-') {
        return Err(bad("不能以连字符开头"));
    }
    Ok(handle.to_string())
}

/// 头像成品的体积上限：64 KB。
///
/// 压缩在**用户浏览器**里完成（canvas），服务端只做最后一道校验——
/// 2 vCPU 的机器不该把算力花在图片转码上。
pub const MAX_AVATAR_BYTES: u64 = 64 * 1024;

/// 显示名上限（字符数，不是字节数）——中文一个字算一个。
pub const MAX_DISPLAY_NAME_CHARS: usize = 20;

/// 显示名：非空、≤ 20 个字符、不含控制字符。
///
/// 与登录名不同，显示名面向读者，允许任意文字（中文、表情都行），
/// 也允许重复——重复由用户自己区分，不占用唯一索引。
pub fn validate_display_name(raw: &str) -> Result<String> {
    let name = raw.trim();
    let bad = |reason: &str| Error::InvalidInput(format!("显示名无效：{reason}"));
    if name.is_empty() {
        return Err(bad("不能为空"));
    }
    if name.chars().count() > MAX_DISPLAY_NAME_CHARS {
        return Err(bad(&format!("最长 {MAX_DISPLAY_NAME_CHARS} 个字符")));
    }
    if name.chars().any(char::is_control) {
        return Err(bad("不能包含控制字符"));
    }
    Ok(name.to_string())
}

/// 口令：8..=128 字节，且不能全是空白。
pub fn validate_password(raw: &str) -> Result<()> {
    if raw.trim().is_empty() || raw.len() < 8 {
        return Err(Error::InvalidInput("口令至少 8 位".to_string()));
    }
    if raw.len() > 128 {
        return Err(Error::InvalidInput("口令最长 128 位".to_string()));
    }
    Ok(())
}

// ---------------------------------------------------------------- 会话令牌

/// 生成一对会话令牌：(发给浏览器放入 Cookie 的原始令牌, 存库的摘要)。
///
/// 库里只存摘要：数据库被读走也不能直接拿来冒充登录。
pub fn new_session_token() -> (String, String) {
    let token = random_hex(32);
    let digest = hash_token(&token);
    (token, digest)
}

/// 会话令牌摘要——`sessions.id` 存的就是它（blake3 十六进制）。
pub fn hash_token(token: &str) -> String {
    crate::hash::hash_bytes(token.as_bytes()).to_string()
}

/// CSRF 令牌：表单隐藏字段与库里记录的值双提交比对。
pub fn new_csrf_token() -> String {
    random_hex(16)
}

#[cfg(test)]
mod permission_tests {
    use super::*;

    #[test]
    fn permission_tree_matches_the_documented_matrix() {
        // 这份期望值就是 docs/PERMISSIONS.md 的表格；改权限必须同时改这里与文档。
        let expected: [(Permission, Option<Role>); 12] = [
            (Permission::ViewContent, None),
            (Permission::CreateDiscussion, Some(Role::Member)),
            (Permission::CreateResource, Some(Role::Member)),
            (Permission::CreateRepost, Some(Role::Member)),
            (Permission::Comment, Some(Role::Member)),
            (Permission::SetAvatar, Some(Role::Member)),
            (Permission::SetPaymentChannel, Some(Role::Developer)),
            (Permission::ReviewPost, Some(Role::Admin)),
            (Permission::UseNetdisk, Some(Role::Admin)),
            (Permission::ManageUsers, Some(Role::Admin)),
            (Permission::ManageDomains, Some(Role::Super)),
            (Permission::PublishBanner, Some(Role::Super)),
        ];
        for (permission, want) in expected {
            assert_eq!(permission.min_role(), want, "{permission:?} 的门槛变了");
        }
        assert_eq!(Permission::PostAnnouncement.min_role(), Some(Role::Super));
        assert_eq!(Permission::ManageRoles.min_role(), Some(Role::Super));
    }

    #[test]
    fn unactivated_users_cannot_write_but_staff_can_review() {
        assert!(!allows(
            Some(Role::Member),
            false,
            Permission::CreateDiscussion
        ));
        assert!(!allows(Some(Role::Member), false, Permission::SetAvatar));
        assert!(allows(
            Some(Role::Member),
            true,
            Permission::CreateDiscussion
        ));
        assert!(allows(Some(Role::Admin), false, Permission::ReviewPost));
        assert!(allows(None, false, Permission::ViewContent));
        assert!(!allows(None, false, Permission::Comment));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_parse_is_strict_and_ordered() {
        assert_eq!(Role::parse("member").expect("ok"), Role::Member);
        assert_eq!(Role::parse("super").expect("ok"), Role::Super);
        assert!(
            Role::parse("root").is_err(),
            "未知角色必须报错，不能静默降级"
        );
        assert!(Role::Super > Role::Admin);
        assert!(Role::Admin > Role::Developer);
        assert!(Role::Developer > Role::Member);
    }

    #[test]
    fn guests_can_read_but_not_post() {
        assert!(allows(None, false, Permission::ViewContent));
        assert!(!allows(None, false, Permission::CreateDiscussion));
        assert!(!allows(None, false, Permission::Comment));
    }

    #[test]
    fn inactive_members_are_blocked_until_activated() {
        assert!(!allows(
            Some(Role::Member),
            false,
            Permission::CreateDiscussion
        ));
        assert!(allows(
            Some(Role::Member),
            true,
            Permission::CreateDiscussion
        ));
        assert!(allows(Some(Role::Member), true, Permission::CreateRepost));
        // 产品决定：三类帖子对所有已激活用户开放，不设发布门槛
        assert!(allows(Some(Role::Member), true, Permission::CreateResource));
    }

    #[test]
    fn developer_and_admin_tiers() {
        // 人工复核：管理员及以上（产品要求上调，原为开发者）
        assert!(!allows(Some(Role::Developer), true, Permission::ReviewPost));
        assert!(allows(Some(Role::Admin), true, Permission::ReviewPost));
        // 收款码：认证开发者及以上
        assert!(allows(
            Some(Role::Developer),
            true,
            Permission::SetPaymentChannel
        ));
        assert!(!allows(
            Some(Role::Member),
            true,
            Permission::SetPaymentChannel
        ));
        // 域名 / 横幅 / 公告：只有超级管理员
        for permission in [
            Permission::ManageDomains,
            Permission::PublishBanner,
            Permission::PostAnnouncement,
        ] {
            assert!(
                !allows(Some(Role::Admin), true, permission),
                "{permission:?} 不该给管理员"
            );
            assert!(
                allows(Some(Role::Super), true, permission),
                "{permission:?} 应给超管"
            );
        }
        assert!(allows(Some(Role::Member), true, Permission::SetAvatar));
        assert!(
            !allows(Some(Role::Member), false, Permission::SetAvatar),
            "未激活不能换头像"
        );
        // 网盘暂不对普通用户/开发者开放
        assert!(!allows(Some(Role::Member), true, Permission::UseNetdisk));
        assert!(!allows(Some(Role::Developer), true, Permission::UseNetdisk));
        assert!(allows(Some(Role::Admin), true, Permission::UseNetdisk));
        assert!(!allows(
            Some(Role::Developer),
            true,
            Permission::ManageUsers
        ));
        assert!(allows(Some(Role::Admin), true, Permission::ManageUsers));
        assert!(!allows(Some(Role::Admin), true, Permission::ManageRoles));
        assert!(allows(Some(Role::Super), true, Permission::ManageRoles));
    }

    #[test]
    fn password_hash_round_trip() {
        let hash = hash_password("correct horse battery").expect("哈希");
        assert!(hash.starts_with("$argon2"), "应是 PHC 字符串：{hash}");
        assert!(verify_password("correct horse battery", &hash));
        assert!(!verify_password("wrong password", &hash));
        assert!(
            !verify_password("correct horse battery", "不是哈希"),
            "损坏的哈希串必须判假而不是 panic"
        );
    }

    #[test]
    fn session_tokens_are_unique_and_only_digest_is_stored() {
        let (t1, d1) = new_session_token();
        let (t2, d2) = new_session_token();
        assert_ne!(t1, t2);
        assert_eq!(d1.len(), 64, "摘要应是 blake3 十六进制");
        assert_ne!(d1, d2);
        assert_ne!(d1, t1, "库里存的不能等于令牌本身");
        assert_eq!(hash_token(&t1), d1, "同一令牌必须得到同一摘要");
    }

    #[test]
    fn email_and_handle_validation() {
        assert_eq!(
            validate_email(" A@Example.COM ").expect("ok"),
            "a@example.com"
        );
        assert!(validate_email("no-at-sign").is_err());
        assert!(validate_email("a@b").is_err(), "域名必须有点");
        assert!(validate_email("a b@c.com").is_err());
        assert!(validate_email("a@@b.com").is_err());

        assert_eq!(validate_handle(" rain-01 ").expect("ok"), "rain-01");
        assert!(validate_handle("ab").is_err());
        assert!(validate_handle("有中文").is_err());
        assert!(validate_handle("-lead").is_err());
        assert!(validate_handle("has space").is_err());
    }

    #[test]
    fn display_name_rules() {
        assert_eq!(validate_display_name("  弥音  ").expect("ok"), "弥音");
        assert_eq!(validate_display_name("a").expect("ok"), "a");
        // 20 个中文字符可以，21 个不行（按字符数而非字节数）
        let twenty: String = "星".repeat(20);
        assert!(validate_display_name(&twenty).is_ok());
        assert!(validate_display_name(&"星".repeat(21)).is_err());
        assert!(validate_display_name("   ").is_err(), "空白不算名字");
        assert!(validate_display_name("").is_err());
        assert!(
            validate_display_name("bad\nname").is_err(),
            "换行是控制字符"
        );
        // 显示名允许重复，也没有字符集限制
        assert_eq!(validate_display_name("同名的人").expect("ok"), "同名的人");
    }

    #[test]
    fn password_strength_bounds() {
        assert!(validate_password("1234567").is_err());
        assert!(validate_password("12345678").is_ok());
        assert!(validate_password("        ").is_err());
    }
}
