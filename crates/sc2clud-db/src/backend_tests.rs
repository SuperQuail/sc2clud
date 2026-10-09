//! 第二批后端功能的仓储测试：站点域名、资源帖 issue、横幅定向用户组。

use sc2clud_core::now_unix;

use crate::{Db, repo};

async fn db() -> Db {
    let db = Db::in_memory().await.expect("内存库");
    db.migrate().await.expect("迁移应成功");
    db
}

async fn make_user(db: &Db, handle: &str) -> i64 {
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

async fn make_post(db: &Db, author: i64, title: &str) -> i64 {
    repo::create_post_reviewed(
        db.pool(),
        repo::NewPost {
            author_id: author,
            kind: "resource",
            section: "custom_campaign",
            title,
            body: "正文",
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
async fn site_domains_can_be_managed() {
    let db = db().await;
    let now = now_unix();
    assert!(
        repo::add_site_domain(db.pool(), "x.fun", "主站", now)
            .await
            .expect("加域名")
    );
    assert!(
        !repo::add_site_domain(db.pool(), "x.fun", "重复", now)
            .await
            .expect("重复加是幂等的")
    );
    repo::add_site_domain(db.pool(), "xn--xpra07ba.fun", "", now)
        .await
        .expect("加域名");
    assert_eq!(
        repo::list_site_domains(db.pool())
            .await
            .expect("列表")
            .len(),
        2
    );
    assert!(
        repo::remove_site_domain(db.pool(), "x.fun")
            .await
            .expect("删")
    );
    let left = repo::list_site_domains(db.pool()).await.expect("列表");
    assert_eq!(left.len(), 1);
    assert_eq!(left[0].domain, "xn--xpra07ba.fun");
}

#[tokio::test]
async fn issues_can_be_filed_commented_and_closed() {
    let db = db().await;
    let now = now_unix();
    let author = make_user(&db, "issue_author").await;
    let reporter = make_user(&db, "issue_reporter").await;
    let post = make_post(&db, author, "灰烬归来 v2").await;

    let bug = repo::create_issue(
        db.pool(),
        repo::NewIssue {
            post_id: post,
            author_id: reporter,
            kind: "bug",
            title: "第二关闪退",
            body: "进场就崩",
            now,
        },
    )
    .await
    .expect("提 issue");
    repo::create_issue(
        db.pool(),
        repo::NewIssue {
            post_id: post,
            author_id: reporter,
            kind: "feature",
            title: "想要自动更新",
            body: "",
            now,
        },
    )
    .await
    .expect("提 issue");

    let open = repo::list_issues(db.pool(), post, false, 20, 0)
        .await
        .expect("列表");
    assert_eq!(open.len(), 2);
    assert_eq!(
        repo::count_open_issues(db.pool(), post)
            .await
            .expect("计数"),
        2
    );
    assert_eq!(open[0].author_handle, "issue_reporter");

    repo::add_issue_comment(db.pool(), bug, author, "我看看", now + 1)
        .await
        .expect("回复");
    let detail = repo::get_issue(db.pool(), bug)
        .await
        .expect("查")
        .expect("存在");
    assert_eq!(detail.comment_count, 1);
    assert!(
        detail.updated_at > detail.created_at,
        "有回复要顶 updated_at"
    );
    assert_eq!(
        repo::list_issue_comments(db.pool(), bug)
            .await
            .expect("回复")
            .len(),
        1
    );

    assert!(
        repo::set_issue_state(db.pool(), bug, "closed", Some(author), now + 2)
            .await
            .expect("关闭")
    );
    assert!(
        !repo::set_issue_state(db.pool(), bug, "closed", Some(author), now + 3)
            .await
            .expect("重复关闭是幂等的")
    );
    assert_eq!(
        repo::count_open_issues(db.pool(), post)
            .await
            .expect("计数"),
        1
    );
    assert_eq!(
        repo::list_issues(db.pool(), post, false, 20, 0)
            .await
            .expect("只看待处理")
            .len(),
        1
    );
    assert_eq!(
        repo::list_issues(db.pool(), post, true, 20, 0)
            .await
            .expect("含已关闭")
            .len(),
        2
    );
}

#[tokio::test]
async fn targeted_banner_only_shows_to_group_members() {
    let db = db().await;
    let now = now_unix();
    let insider = make_user(&db, "insider").await;
    let outsider = make_user(&db, "outsider").await;
    let group = repo::create_user_group(db.pool(), "beta", "内测", "", now)
        .await
        .expect("建组");
    repo::add_group_member(db.pool(), group, insider, now)
        .await
        .expect("入组");

    let banner = repo::create_banner(
        db.pool(),
        repo::NewBanner {
            title: "内测公告",
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
    repo::set_banner_groups(db.pool(), banner, &[group])
        .await
        .expect("定向");
    assert_eq!(
        repo::list_banner_groups(db.pool(), banner)
            .await
            .expect("查组"),
        vec![group]
    );

    assert_eq!(
        repo::visible_banners(db.pool(), insider, now)
            .await
            .expect("内测成员")
            .len(),
        1
    );
    assert!(
        repo::visible_banners(db.pool(), outsider, now)
            .await
            .expect("别的用户")
            .is_empty(),
        "定向横幅不该给组外的人看"
    );

    repo::set_banner_groups(db.pool(), banner, &[])
        .await
        .expect("取消定向");
    assert_eq!(
        repo::visible_banners(db.pool(), outsider, now)
            .await
            .expect("外人")
            .len(),
        1,
        "取消定向后所有人都能看到"
    );
}

#[tokio::test]
async fn group_deny_beats_role_and_allow() {
    use sc2clud_core::auth::Role;
    let db = db().await;
    let now = now_unix();
    let user = make_user(&db, "banned").await;
    let group = repo::create_user_group(db.pool(), "muted", "禁言组", "", now)
        .await
        .expect("建组");
    repo::add_group_member(db.pool(), group, user, now)
        .await
        .expect("入组");

    // 普通用户本来能在「自制战役」发帖
    let before = repo::section_capabilities(db.pool(), user, Role::Member, "custom_campaign")
        .await
        .expect("查")
        .expect("存在");
    assert!(before.can_post && before.can_reply);

    // 组里给他禁言 → 即使角色够、别的组允许也不许
    repo::set_group_section_rule_full(db.pool(), group, "custom_campaign", true, true, true, true)
        .await
        .expect("设禁止");
    let after = repo::section_capabilities(db.pool(), user, Role::Member, "custom_campaign")
        .await
        .expect("查")
        .expect("存在");
    assert!(!after.can_post, "禁止应当优先于角色门槛");
    assert!(!after.can_reply);

    // 超级管理员也照样被禁（禁止就是禁止）
    let admin = repo::section_capabilities(db.pool(), user, Role::Super, "custom_campaign")
        .await
        .expect("查")
        .expect("存在");
    assert!(!admin.can_post);

    // 只对某个分区生效：别的分区不受影响（vanilla_mod 的门槛是 member）
    let other = repo::section_capabilities(db.pool(), user, Role::Member, "vanilla_mod")
        .await
        .expect("查")
        .expect("存在");
    assert!(other.can_post, "禁言只对配置过的分区生效");
}

#[tokio::test]
async fn archived_section_content_leaves_lists_and_search() {
    let db = db().await;
    let now = now_unix();
    let author = make_user(&db, "arch_author").await;
    let post = make_post(&db, author, "归档前后都在的帖子").await;

    let feed = repo::list_feed_by_section(db.pool(), Some(author), false, None, 20, 0)
        .await
        .expect("列表");
    assert_eq!(feed.len(), 1, "归档前应当在列表里");
    assert!(
        !repo::search_posts(db.pool(), "归档前后", None, 20, 0)
            .await
            .expect("搜索")
            .is_empty(),
        "归档前搜得到"
    );

    repo::set_section_archived(db.pool(), "custom_campaign", true, now)
        .await
        .expect("归档分区");
    let feed = repo::list_feed_by_section(db.pool(), Some(author), false, None, 20, 0)
        .await
        .expect("列表");
    assert!(feed.is_empty(), "归档分区的内容不该再出现在列表里");
    assert!(
        repo::search_posts(db.pool(), "归档前后", None, 20, 0)
            .await
            .expect("搜索")
            .is_empty(),
        "归档分区的内容也不该被搜到"
    );
    // 内容本身没丢：取回分区即恢复
    repo::set_section_archived(db.pool(), "custom_campaign", false, now)
        .await
        .expect("取回");
    let feed = repo::list_feed_by_section(db.pool(), Some(author), false, None, 20, 0)
        .await
        .expect("列表");
    assert_eq!(feed.len(), 1, "取回后内容原样回来");
    assert!(feed[0].id == post);
}

#[tokio::test]
async fn filing_an_issue_notifies_the_post_author() {
    let db = db().await;
    let now = now_unix();
    let author = make_user(&db, "notify_author").await;
    let reporter = make_user(&db, "notify_reporter").await;
    let post = make_post(&db, author, "会被提 issue 的帖子").await;

    repo::create_issue(
        db.pool(),
        repo::NewIssue {
            post_id: post,
            author_id: reporter,
            kind: "bug",
            title: "进不去第二关",
            body: "点击就崩",
            now,
        },
    )
    .await
    .expect("提 issue");
    let rows: Vec<(i64,)> =
        sqlx::query_as("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'issue'")
            .bind(author)
            .fetch_all(db.pool())
            .await
            .expect("查通知");
    assert_eq!(rows[0].0, 1, "帖作者应当收到一条 issue 通知");

    // 自己给自己的帖子提 issue 不通知自己
    repo::create_issue(
        db.pool(),
        repo::NewIssue {
            post_id: post,
            author_id: author,
            kind: "feature",
            title: "自己的备忘",
            body: "",
            now,
        },
    )
    .await
    .expect("提 issue");
    let rows: Vec<(i64,)> =
        sqlx::query_as("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'issue'")
            .bind(author)
            .fetch_all(db.pool())
            .await
            .expect("查通知");
    assert_eq!(rows[0].0, 1, "自己提的不该再给自己发一条");
}

#[tokio::test]
async fn pushing_a_post_notifies_only_that_group() {
    let db = db().await;
    let now = now_unix();
    let author = make_user(&db, "push_author").await;
    let insider = make_user(&db, "push_insider").await;
    let outsider = make_user(&db, "push_outsider").await;
    let group = repo::create_user_group(db.pool(), "watchers", "关注者", "", now)
        .await
        .expect("建组");
    repo::add_group_member(db.pool(), group, insider, now)
        .await
        .expect("入组");
    let post = make_post(&db, author, "只想推给关注者的帖子").await;

    let sent = repo::push_post_to_groups(db.pool(), post, &[group], now)
        .await
        .expect("推送");
    assert_eq!(sent, 1, "只推给该组成员，作者自己被排除");
    let insider_count: Vec<(i64,)> =
        sqlx::query_as("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'push'")
            .bind(insider)
            .fetch_all(db.pool())
            .await
            .expect("查");
    assert_eq!(insider_count[0].0, 1);
    let outsider_count: Vec<(i64,)> =
        sqlx::query_as("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'push'")
            .bind(outsider)
            .fetch_all(db.pool())
            .await
            .expect("查");
    assert_eq!(outsider_count[0].0, 0, "组外的人不该被打扰");
    let author_count: Vec<(i64,)> =
        sqlx::query_as("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND kind = 'push'")
            .bind(author)
            .fetch_all(db.pool())
            .await
            .expect("查");
    assert_eq!(author_count[0].0, 0, "作者不该收到自己的推送");
    assert_eq!(
        repo::post_resource_status(db.pool(), post)
            .await
            .expect("查状态")
            .as_deref(),
        Some("active")
    );
}

#[tokio::test]
async fn titles_and_exp_are_readable_from_the_backend() {
    use sc2clud_core::community::ExpAction;
    let db = db().await;
    let now = now_unix();
    let user = make_user(&db, "titled_read").await;
    let other = make_user(&db, "untitled").await;

    let title = repo::create_title(db.pool(), "vip", "VIP", "#f80", "", now)
        .await
        .expect("建头衔");
    assert!(
        repo::equipped_title_for(db.pool(), user)
            .await
            .expect("查")
            .is_none()
    );
    repo::grant_title(db.pool(), user, title, None, now)
        .await
        .expect("授予");
    repo::set_equipped_title(db.pool(), user, Some(title))
        .await
        .expect("佩戴");
    let equipped = repo::equipped_title_for(db.pool(), user).await.expect("查");
    assert_eq!(equipped.expect("戴着").key, "vip");

    // 批量查询：只有戴了的人出现（列表渲染用，不做 N+1）
    let batch = repo::equipped_titles_for(db.pool(), &[user, other])
        .await
        .expect("批量查");
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0].0, user);

    // 经验：按动作给分，等级跟着曲线走
    let (exp, level) =
        repo::award_exp(db.pool(), user, ExpAction::PostCreated, Some("post:1"), now)
            .await
            .expect("发经验");
    assert_eq!(exp, ExpAction::PostCreated.exp());
    assert_eq!(level, 1);
    for _ in 0..6 {
        repo::award_exp(db.pool(), user, ExpAction::PostCreated, None, now)
            .await
            .expect("发经验");
    }
    let (exp, level) = repo::award_exp(db.pool(), user, ExpAction::CommentCreated, None, now)
        .await
        .expect("发经验");
    assert_eq!(
        level,
        sc2clud_core::community::level_for_exp(exp),
        "等级必须跟曲线一致"
    );
}

#[tokio::test]
async fn editing_a_post_stages_until_approved() {
    let db = db().await;
    let now = now_unix();
    let author = make_user(&db, "edit_author").await;
    let post = make_post(&db, author, "原来的标题").await;

    // 审核机没直接放行 → 暂存：posts 保持原样
    let outcome = repo::submit_post_edit(
        db.pool(),
        repo::PostEdit {
            id: post,
            title: "改过的标题",
            body: "改过的正文",
            kind: "discussion",
            section: "custom_campaign",
            review_state: "pending",
            review_note: Some("含敏感词，待人工"),
            submitted_by: Some(author),
            now,
        },
        "pending",
    )
    .await
    .expect("提交编辑");
    assert_eq!(outcome, repo::EditOutcome::Staged);
    assert!(
        repo::has_pending_revision(db.pool(), post)
            .await
            .expect("查"),
        "应当有一份待审修改"
    );
    // 对外仍是原帖
    let current = repo::resolved_post_title(db.pool(), post)
        .await
        .expect("查标题");
    assert_eq!(current.as_deref(), Some("原来的标题"), "通过前对外显示原帖");
    let revision = repo::pending_revision(db.pool(), post)
        .await
        .expect("查待审")
        .expect("存在");
    assert_eq!(revision.title, "改过的标题");
    assert!(revision.note.is_some());

    // 通过 → 替换原帖并清掉待审
    assert!(
        repo::apply_pending_revision(db.pool(), post, now)
            .await
            .expect("落地")
    );
    assert!(
        !repo::has_pending_revision(db.pool(), post)
            .await
            .expect("查")
    );
    assert_eq!(
        repo::resolved_post_title(db.pool(), post)
            .await
            .expect("查")
            .as_deref(),
        Some("改过的标题")
    );
}

#[tokio::test]
async fn rejecting_an_edit_keeps_the_original() {
    let db = db().await;
    let now = now_unix();
    let author = make_user(&db, "reject_author").await;
    let post = make_post(&db, author, "不会被改掉的标题").await;
    repo::submit_post_edit(
        db.pool(),
        repo::PostEdit {
            id: post,
            title: "坏标题",
            body: "坏正文",
            kind: "discussion",
            section: "custom_campaign",
            review_state: "pending",
            review_note: None,
            submitted_by: Some(author),
            now,
        },
        "pending",
    )
    .await
    .expect("提交编辑");
    assert!(
        repo::drop_pending_revision(db.pool(), post)
            .await
            .expect("丢弃")
    );
    assert!(
        !repo::has_pending_revision(db.pool(), post)
            .await
            .expect("查")
    );
    assert_eq!(
        repo::resolved_post_title(db.pool(), post)
            .await
            .expect("查")
            .as_deref(),
        Some("不会被改掉的标题"),
        "拒绝修改后原帖必须完好"
    );
    // 通过时直接生效（管理员编辑走这条路）
    let outcome = repo::submit_post_edit(
        db.pool(),
        repo::PostEdit {
            id: post,
            title: "管理员直接改的标题",
            body: "正文",
            kind: "discussion",
            section: "custom_campaign",
            review_state: "approved",
            review_note: None,
            submitted_by: Some(author),
            now,
        },
        "approved",
    )
    .await
    .expect("提交编辑");
    assert_eq!(outcome, repo::EditOutcome::Applied);
    assert_eq!(
        repo::resolved_post_title(db.pool(), post)
            .await
            .expect("查")
            .as_deref(),
        Some("管理员直接改的标题")
    );
}

#[tokio::test]
async fn donation_showcase_respects_the_authors_switch() {
    let db = db().await;
    let now = now_unix();
    let author = make_user(&db, "donation_author").await;
    repo::add_payment_channel(
        db.pool(),
        author,
        "alipay",
        "支付宝",
        "hash-qr",
        "image/png",
        now,
    )
    .await
    .expect("加收款码");

    // 默认不展示：收款码涉及钱财，必须作者自己开
    let off = repo::author_showcase(db.pool(), author)
        .await
        .expect("展示块");
    assert!(!off.donation_visible);
    assert!(off.channels.is_empty(), "没开就不该把渠道带出去");

    assert!(
        repo::set_donation_visible(db.pool(), author, true)
            .await
            .expect("开")
    );
    assert!(
        !repo::set_donation_visible(db.pool(), author, true)
            .await
            .expect("重复开是幂等的")
    );
    let on = repo::author_showcase(db.pool(), author)
        .await
        .expect("展示块");
    assert!(on.donation_visible);
    assert_eq!(on.channels.len(), 1);
    assert_eq!(on.channels[0].channel, "alipay");
    assert_eq!(on.channels[0].image_hash, "hash-qr");

    repo::set_donation_visible(db.pool(), author, false)
        .await
        .expect("关");
    let off = repo::author_showcase(db.pool(), author)
        .await
        .expect("展示块");
    assert!(!off.donation_visible && off.channels.is_empty());
}
