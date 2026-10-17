//! 社区结构的仓储测试：分区 / 分区管理员 / 用户组 / 头衔 / 经验 / 帖子置顶精华搜索。
//!
//! 单独放一个文件：这些用例都在验证 0012 迁移引入的表，和既有测试互不干扰。

use sc2clud_core::auth::Role;
use sc2clud_core::now_unix;

use crate::{Db, repo};

async fn db() -> Db {
    let db = Db::in_memory().await.expect("内存库");
    db.migrate().await.expect("迁移应成功");
    db
}

async fn make_user(db: &Db, handle: &str) -> i64 {
    // 邮箱有唯一索引：一个用例里建多个用户时必须各不相同
    let email = format!("{handle}@test.local");
    repo::register_user(
        db.pool(),
        repo::NewUser {
            handle,
            display_name: handle,
            email: &email,
            password_hash: "h",
            activated: true,
            now: now_unix(),
        },
    )
    .await
    .expect("建用户")
}

async fn make_post(db: &Db, author: i64, section: &str, title: &str, body: &str) -> i64 {
    repo::create_post_reviewed(
        db.pool(),
        repo::NewPost {
            author_id: author,
            kind: "discussion",
            section,
            title,
            body,
            image_count: 0,
            review_state: "approved",
            review_note: None,
            now: now_unix(),
        },
    )
    .await
    .expect("发帖")
}

#[tokio::test]
async fn sections_can_be_created_reordered_archived_and_restored() {
    let db = db().await;
    let now = now_unix();
    let author = make_user(&db, "sec_author").await;
    let post = make_post(
        &db,
        author,
        "custom_campaign",
        "留在归档分区里的帖子",
        "正文",
    )
    .await;

    let seeded = repo::list_sections(db.pool(), false)
        .await
        .expect("分区列表");
    assert_eq!(seeded.len(), 5, "迁移应种下五个分区：{seeded:?}");

    let position = repo::next_section_position(db.pool()).await.expect("位置");
    assert!(
        repo::create_section(
            db.pool(),
            repo::NewSection {
                key: "qa_board",
                label: "测试分区",
                description: "用来试",
                position,
                post_min_role: "member",
                reply_min_role: "member",
                now,
            },
        )
        .await
        .expect("建分区")
    );
    assert!(
        !repo::create_section(
            db.pool(),
            repo::NewSection {
                key: "qa_board",
                label: "重复",
                description: "",
                position: 9,
                post_min_role: "member",
                reply_min_role: "member",
                now,
            },
        )
        .await
        .expect("重复 key 应被忽略")
    );

    let moved = repo::reorder_sections(db.pool(), &["qa_board".to_string()], now)
        .await
        .expect("排序");
    // 重排会重写**所有**分区的位置（列出的先排，其余接在后面），
    // 这样才不会出现两个分区同 position 的情况。
    assert_eq!(moved, 6, "5 个种子分区 + 新建的 1 个");
    let first = &repo::list_sections(db.pool(), false).await.expect("列表")[0];
    assert_eq!(first.key, "qa_board", "排序后应排第一");

    assert!(
        repo::set_section_archived(db.pool(), "qa_board", true, now)
            .await
            .expect("归档")
    );
    let visible = repo::list_sections(db.pool(), false)
        .await
        .expect("前台列表");
    assert!(!visible.iter().any(|s| s.key == "qa_board"));
    let all = repo::list_sections(db.pool(), true).await.expect("含归档");
    let archived = all
        .iter()
        .find(|s| s.key == "qa_board")
        .expect("归档分区还在");
    assert!(archived.archived);
    assert!(
        !archived.can_post(Some(Role::Super)),
        "归档分区不接受新内容"
    );
    assert!(
        repo::set_section_archived(db.pool(), "qa_board", false, now)
            .await
            .expect("取回")
    );

    let restored = repo::get_post_for(db.pool(), post, Some(author), false)
        .await
        .expect("查帖")
        .expect("归档不删内容，帖子必须还在");
    assert_eq!(restored.title, "留在归档分区里的帖子");
}

#[tokio::test]
async fn section_permissions_gate_post_and_reply_separately() {
    let db = db().await;
    let now = now_unix();
    let announcement = repo::get_section(db.pool(), "announcement")
        .await
        .expect("查")
        .expect("存在");
    assert!(!announcement.can_post(Some(Role::Member)));
    assert!(announcement.can_post(Some(Role::Admin)));
    assert!(announcement.can_reply(Some(Role::Member)));

    repo::update_section(
        db.pool(),
        "announcement",
        "公告",
        "站点通知",
        "admin",
        "developer",
        now,
    )
    .await
    .expect("改权限");
    let strict = repo::get_section(db.pool(), "announcement")
        .await
        .expect("查")
        .expect("存在");
    assert!(!strict.can_reply(Some(Role::Member)));
    assert!(strict.can_reply(Some(Role::Developer)));
}

#[tokio::test]
async fn section_moderators_round_trip() {
    let db = db().await;
    let now = now_unix();
    let user = make_user(&db, "sec_mod").await;
    assert!(
        repo::add_section_moderator(db.pool(), "custom_campaign", user, None, now)
            .await
            .expect("加管理员")
    );
    assert!(
        !repo::add_section_moderator(db.pool(), "custom_campaign", user, None, now)
            .await
            .expect("重复加是幂等的")
    );
    assert!(
        repo::is_section_moderator(db.pool(), "custom_campaign", user)
            .await
            .expect("查询")
    );
    let list = repo::list_section_moderators(db.pool(), "custom_campaign")
        .await
        .expect("列表");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].handle, "sec_mod");
    assert!(
        repo::remove_section_moderator(db.pool(), "custom_campaign", user)
            .await
            .expect("移除")
    );
    assert!(
        !repo::is_section_moderator(db.pool(), "custom_campaign", user)
            .await
            .expect("查询")
    );
}

#[tokio::test]
async fn user_groups_grant_section_access() {
    let db = db().await;
    let now = now_unix();
    let user = make_user(&db, "grouped").await;
    let group = repo::create_user_group(db.pool(), "veterans", "老兵", "内测成员", now)
        .await
        .expect("建组");
    assert_eq!(
        group,
        repo::create_user_group(db.pool(), "veterans", "老兵", "", now)
            .await
            .expect("重复 key 返回同一个 id")
    );

    assert!(
        repo::add_group_member(db.pool(), group, user, now)
            .await
            .expect("入组")
    );
    assert!(
        !repo::add_group_member(db.pool(), group, user, now)
            .await
            .expect("重复入组幂等")
    );
    assert_eq!(
        repo::list_group_members(db.pool(), group)
            .await
            .expect("成员")
            .len(),
        1
    );
    assert_eq!(
        repo::list_user_groups_for(db.pool(), user)
            .await
            .expect("所在组")
            .len(),
        1
    );

    repo::set_group_section_rule(db.pool(), group, "tool_dev", true, false)
        .await
        .expect("设规则");
    let rules = repo::group_rules_for_user_section(db.pool(), user, "tool_dev")
        .await
        .expect("查规则");
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0].can_post, 1);
    assert_eq!(rules[0].can_reply, 0);
    assert!(
        repo::group_rules_for_user_section(db.pool(), user, "custom_campaign")
            .await
            .expect("别的分区没有规则")
            .is_empty()
    );

    assert!(
        repo::set_user_group_archived(db.pool(), group, true, now)
            .await
            .expect("归档组")
    );
    assert!(
        repo::group_rules_for_user_section(db.pool(), user, "tool_dev")
            .await
            .expect("查规则")
            .is_empty(),
        "组归档后规则不再生效"
    );
}

#[tokio::test]
async fn titles_can_be_granted_equipped_and_revoked() {
    let db = db().await;
    let now = now_unix();
    let user = make_user(&db, "titled").await;
    let veteran = repo::create_title(db.pool(), "veteran", "老兵", "#f80", "早期成员", now)
        .await
        .expect("建头衔");
    let helper = repo::create_title(db.pool(), "helper", "热心助人", "#0af", "", now)
        .await
        .expect("建头衔");

    assert!(
        repo::grant_title(db.pool(), user, veteran, None, now)
            .await
            .expect("授予")
    );
    assert!(
        repo::grant_title(db.pool(), user, helper, None, now)
            .await
            .expect("授予")
    );
    assert_eq!(
        repo::list_user_titles(db.pool(), user)
            .await
            .expect("持有")
            .len(),
        2
    );

    assert!(
        repo::set_equipped_title(db.pool(), user, Some(veteran))
            .await
            .expect("佩戴")
    );
    let titles = repo::list_user_titles(db.pool(), user).await.expect("持有");
    assert_eq!(titles.iter().filter(|t| t.equipped == 1).count(), 1);
    assert_eq!(
        titles
            .iter()
            .find(|t| t.equipped == 1)
            .expect("戴着")
            .title_id,
        veteran
    );

    let other = repo::create_title(db.pool(), "ghost", "幽灵", "", "", now)
        .await
        .expect("建头衔");
    assert!(
        !repo::set_equipped_title(db.pool(), user, Some(other))
            .await
            .expect("没持有的不能戴")
    );

    assert!(
        repo::revoke_title(db.pool(), user, veteran)
            .await
            .expect("收回")
    );
    let after = repo::list_user_titles(db.pool(), user).await.expect("持有");
    assert_eq!(after.len(), 1);
    assert!(
        after.iter().all(|t| t.equipped == 0),
        "收回正戴着的头衔后应自动摘掉"
    );
}

#[tokio::test]
async fn exp_is_recorded_and_level_follows_the_curve() {
    let db = db().await;
    let now = now_unix();
    let user = make_user(&db, "leveling").await;
    let (exp, level) = repo::add_exp(db.pool(), user, 60, "发帖", Some("post:1"), now)
        .await
        .expect("加经验");
    assert_eq!((exp, level), (60, 1));
    let (exp, level) = repo::add_exp(db.pool(), user, 60, "被赞", Some("post:1"), now)
        .await
        .expect("加经验");
    assert_eq!((exp, level), (120, 2), "累计 100 经验应到 2 级");
    assert_eq!(
        repo::list_exp_events(db.pool(), user, 10)
            .await
            .expect("流水")
            .len(),
        2
    );
}

#[tokio::test]
async fn posts_can_be_pinned_featured_and_searched() {
    let db = db().await;
    let now = now_unix();
    let author = make_user(&db, "poster").await;
    let plain = make_post(&db, author, "custom_campaign", "普通帖子", "随便写点").await;
    let starred = make_post(
        &db,
        author,
        "custom_campaign",
        "弥音启动器教程",
        "怎么用启动器",
    )
    .await;

    assert!(
        repo::set_post_pinned(db.pool(), starred, 10, Some(author), now)
            .await
            .expect("置顶")
    );
    let feed = repo::list_feed_by_section(
        db.pool(),
        Some(author),
        false,
        Some("custom_campaign"),
        10,
        0,
    )
    .await
    .expect("列表");
    assert_eq!(feed[0].id, starred, "置顶帖排最前");

    assert!(
        repo::set_post_featured(db.pool(), starred, true, Some(author), now)
            .await
            .expect("精华")
    );
    let featured = repo::list_featured_posts(db.pool(), None, 10)
        .await
        .expect("精华列表");
    assert_eq!(featured.len(), 1);
    assert_eq!(featured[0].id, starred);
    assert!(
        repo::set_post_featured(db.pool(), starred, false, Some(author), now)
            .await
            .expect("取消精华")
    );
    assert!(
        repo::list_featured_posts(db.pool(), None, 10)
            .await
            .expect("精华列表")
            .is_empty()
    );

    assert!(
        repo::mark_post_pushed(db.pool(), starred, now)
            .await
            .expect("推送")
    );

    let hits = repo::search_posts(db.pool(), "启动器", None, 10, 0)
        .await
        .expect("搜索");
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, starred);
    let body_hits = repo::search_posts(db.pool(), "随便写", None, 10, 0)
        .await
        .expect("搜索");
    assert_eq!(body_hits.len(), 1);
    assert_eq!(body_hits[0].id, plain);
    assert!(
        repo::search_posts(db.pool(), "%", None, 10, 0)
            .await
            .expect("搜索")
            .is_empty(),
        "LIKE 通配符必须被转义，% 不该匹配所有帖子"
    );
}

#[tokio::test]
async fn banners_respect_dismissal_window_and_activation() {
    let db = db().await;
    let now = now_unix();
    let user = make_user(&db, "banner_user").await;
    let other = make_user(&db, "banner_other").await;

    let live = repo::create_banner(
        db.pool(),
        repo::NewBanner {
            title: "站点维护",
            body: "今晚 2 点维护",
            kind: "warning",
            url: None,
            starts_at: None,
            ends_at: None,
            created_by: None,
            now,
        },
    )
    .await
    .expect("建横幅");
    // 已过期 / 未开始 / 已停用的都不该出现
    repo::create_banner(
        db.pool(),
        repo::NewBanner {
            title: "过期",
            body: "",
            kind: "info",
            url: None,
            starts_at: None,
            ends_at: Some(now - 10),
            created_by: None,
            now,
        },
    )
    .await
    .expect("建横幅");
    repo::create_banner(
        db.pool(),
        repo::NewBanner {
            title: "未开始",
            body: "",
            kind: "info",
            url: None,
            starts_at: Some(now + 3600),
            ends_at: None,
            created_by: None,
            now,
        },
    )
    .await
    .expect("建横幅");
    let paused = repo::create_banner(
        db.pool(),
        repo::NewBanner {
            title: "停用",
            body: "",
            kind: "info",
            url: None,
            starts_at: None,
            ends_at: None,
            created_by: None,
            now,
        },
    )
    .await
    .expect("建横幅");
    assert!(
        repo::set_banner_active(db.pool(), paused, false)
            .await
            .expect("停用")
    );

    let mine = repo::visible_banners(db.pool(), user, now)
        .await
        .expect("可见");
    assert_eq!(mine.len(), 1, "只有生效中的那条：{mine:?}");
    assert_eq!(mine[0].id, live);

    // 点确认后不再出现，且只影响自己
    assert!(
        repo::dismiss_banner(db.pool(), live, user, now)
            .await
            .expect("确认")
    );
    assert!(
        !repo::dismiss_banner(db.pool(), live, user, now)
            .await
            .expect("重复确认幂等")
    );
    assert!(
        repo::visible_banners(db.pool(), user, now)
            .await
            .expect("可见")
            .is_empty()
    );
    assert_eq!(
        repo::visible_banners(db.pool(), other, now)
            .await
            .expect("别人还看得到")
            .len(),
        1
    );
}

#[tokio::test]
async fn payment_channels_round_trip() {
    let db = db().await;
    let now = now_unix();
    let user = make_user(&db, "payee").await;
    let other = make_user(&db, "stranger").await;

    let alipay = repo::add_payment_channel(
        db.pool(),
        user,
        "alipay",
        "支付宝",
        "hash-a",
        "image/png",
        now,
    )
    .await
    .expect("加渠道");
    repo::add_payment_channel(
        db.pool(),
        user,
        "wechat",
        "微信",
        "hash-b",
        "image/webp",
        now,
    )
    .await
    .expect("加渠道");
    assert_eq!(
        repo::list_payment_channels(db.pool(), user)
            .await
            .expect("列表")
            .len(),
        2
    );

    // 不是自己的删不掉
    assert!(
        repo::delete_payment_channel(db.pool(), other, alipay)
            .await
            .expect("越权删除")
            .is_none()
    );
    assert_eq!(
        repo::list_payment_channels(db.pool(), user)
            .await
            .expect("列表")
            .len(),
        2
    );

    assert_eq!(
        repo::delete_payment_channel(db.pool(), user, alipay)
            .await
            .expect("删除")
            .as_deref(),
        Some("hash-a"),
        "删除时要返回图片摘要供回收"
    );
    assert_eq!(
        repo::list_payment_channels(db.pool(), user)
            .await
            .expect("列表")
            .len(),
        1
    );
}

#[tokio::test]
async fn post_title_and_resource_status_round_trip() {
    let db = db().await;
    let author = make_user(&db, "resource_author").await;
    let post = make_post(&db, author, "custom_campaign", "灰烬归来 v2", "正文").await;

    assert_eq!(
        repo::resolved_post_title(db.pool(), post)
            .await
            .expect("查标题")
            .as_deref(),
        Some("灰烬归来 v2")
    );
    assert!(
        repo::resolved_post_title(db.pool(), 999_999)
            .await
            .expect("查")
            .is_none()
    );

    assert_eq!(
        repo::post_resource_status(db.pool(), post)
            .await
            .expect("查状态")
            .as_deref(),
        Some("active"),
        "默认持续更新"
    );
    assert!(
        repo::set_post_resource_status(db.pool(), post, "maintenance", now_unix())
            .await
            .expect("改状态")
    );
    assert_eq!(
        repo::post_resource_status(db.pool(), post)
            .await
            .expect("查状态")
            .as_deref(),
        Some("maintenance")
    );
}
