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
