use crate::{Db, repo};
#[tokio::test]
async fn recommended_feature_bonus_does_not_override_hot_posts() {
    let db = Db::in_memory().await.unwrap();
    db.migrate().await.unwrap();
    let author = repo::create_user(db.pool(), "author", None, "h", 0, 1)
        .await
        .unwrap();
    let mut ids = Vec::new();
    for (name, likes, featured) in [("A", 10, false), ("B", 10, true), ("C", 40, false)] {
        let post = repo::create_post(db.pool(), author, name, "正文", 1)
            .await
            .unwrap();
        ids.push(post);
        for i in 0..likes {
            let voter = repo::create_user(db.pool(), &format!("v{name}{i}"), None, "h", 0, 1)
                .await
                .unwrap();
            sqlx::query("INSERT INTO post_likes VALUES (?, ?, 1)")
                .bind(post)
                .bind(voter)
                .execute(db.pool())
                .await
                .unwrap();
        }
        for _ in 0..5 {
            repo::create_comment(db.pool(), post, author, "评论", 2)
                .await
                .unwrap();
        }
        if featured {
            sqlx::query("UPDATE posts SET featured_at=2, featured_by=? WHERE id=?")
                .bind(author)
                .bind(post)
                .execute(db.pool())
                .await
                .unwrap();
        }
    }
    sqlx::query("UPDATE posts SET created_at=10 WHERE title='A'")
        .execute(db.pool())
        .await
        .unwrap();
    let filter = repo::FeedFilter {
        section: None,
        search: "",
        sort: repo::FeedSort::Recommended,
    };
    let rows = repo::list_feed_filtered(db.pool(), None, false, &filter, 20, 0)
        .await
        .unwrap();
    assert_eq!(
        rows.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![ids[2], ids[1], ids[0]]
    );
    assert_eq!(
        rows.iter()
            .map(|r| (r.like_count, r.comment_count))
            .collect::<Vec<_>>(),
        vec![(40, 5), (10, 5), (10, 5)]
    );
    assert!(
        !repo::set_post_featured(db.pool(), ids[1], true, Some(author), 20)
            .await
            .unwrap()
    );
    assert!(
        repo::set_post_featured(db.pool(), ids[1], false, Some(author), 21)
            .await
            .unwrap()
    );
    let rows = repo::list_feed_filtered(db.pool(), None, false, &filter, 20, 0)
        .await
        .unwrap();
    assert_eq!(
        rows.iter().map(|r| r.id).collect::<Vec<_>>(),
        vec![ids[2], ids[0], ids[1]]
    );
    sqlx::query("DELETE FROM post_likes WHERE post_id=? AND user_id=(SELECT MIN(user_id) FROM post_likes WHERE post_id=?)").bind(ids[2]).bind(ids[2]).execute(db.pool()).await.unwrap();
    let rows = repo::list_feed_filtered(db.pool(), None, false, &filter, 1, 0)
        .await
        .unwrap();
    assert_eq!(rows[0].like_count + 3 * rows[0].comment_count, 54);
    for (sort, expected) in [
        (repo::FeedSort::Likes, ids[2]),
        (repo::FeedSort::Latest, ids[0]),
    ] {
        let selected = repo::FeedFilter { sort, ..filter };
        assert_eq!(
            repo::list_feed_filtered(db.pool(), None, false, &selected, 1, 0)
                .await
                .unwrap()[0]
                .id,
            expected
        );
    }
    sqlx::query("UPDATE posts SET pinned_rank=1 WHERE id=?")
        .bind(ids[1])
        .execute(db.pool())
        .await
        .unwrap();
    assert_eq!(
        repo::list_feed_filtered(db.pool(), None, false, &filter, 1, 0)
            .await
            .unwrap()[0]
            .id,
        ids[1]
    );
}

#[test]
fn sort_parameters_are_closed_and_canonical() {
    for value in [None, Some("popular"), Some("bad SQL")] {
        assert_eq!(repo::FeedSort::parse(value), repo::FeedSort::Recommended);
    }
    for sort in [
        repo::FeedSort::Recommended,
        repo::FeedSort::Active,
        repo::FeedSort::Likes,
        repo::FeedSort::Latest,
    ] {
        assert_eq!(repo::FeedSort::parse(Some(sort.as_str())), sort);
    }
}

#[tokio::test]
async fn active_ignores_edits_and_deleted_interactions_and_count_matches_pages() {
    let db = Db::in_memory().await.unwrap();
    db.migrate().await.unwrap();
    let user = repo::create_user(db.pool(), "activity", None, "h", 0, 1)
        .await
        .unwrap();
    let a = repo::create_post(db.pool(), user, "first", "body", 1)
        .await
        .unwrap();
    let b = repo::create_post(db.pool(), user, "second", "body", 2)
        .await
        .unwrap();
    let filter = repo::FeedFilter {
        section: None,
        search: "",
        sort: repo::FeedSort::Active,
    };
    assert_eq!(
        repo::list_feed_filtered(db.pool(), None, false, &filter, 1, 0)
            .await
            .unwrap()[0]
            .id,
        b
    );
    let issue:i64=sqlx::query_scalar("INSERT INTO post_issues(post_id,author_id,title,created_at,updated_at) VALUES (?,?,'issue',3,100) RETURNING id").bind(a).bind(user).fetch_one(db.pool()).await.unwrap();
    assert_eq!(
        repo::list_feed_filtered(db.pool(), None, false, &filter, 1, 0)
            .await
            .unwrap()[0]
            .id,
        a
    );
    repo::create_comment(db.pool(), b, user, "comment", 4)
        .await
        .unwrap();
    assert_eq!(
        repo::list_feed_filtered(db.pool(), None, false, &filter, 1, 0)
            .await
            .unwrap()[0]
            .id,
        b
    );
    sqlx::query(
        "INSERT INTO issue_comments(issue_id,author_id,body,created_at) VALUES (?,?,'reply',5)",
    )
    .bind(issue)
    .bind(user)
    .execute(db.pool())
    .await
    .unwrap();
    assert_eq!(
        repo::list_feed_filtered(db.pool(), None, false, &filter, 1, 0)
            .await
            .unwrap()[0]
            .id,
        a
    );
    sqlx::query("UPDATE issue_comments SET deleted_at=6")
        .execute(db.pool())
        .await
        .unwrap();
    assert_eq!(
        repo::list_feed_filtered(db.pool(), None, false, &filter, 1, 0)
            .await
            .unwrap()[0]
            .id,
        b
    );
    sqlx::query("UPDATE comments SET deleted_at=7")
        .execute(db.pool())
        .await
        .unwrap();
    assert_eq!(
        repo::list_feed_filtered(db.pool(), None, false, &filter, 1, 0)
            .await
            .unwrap()[0]
            .id,
        a
    );
    assert_eq!(
        repo::list_feed_filtered(db.pool(), None, false, &filter, 1, 1)
            .await
            .unwrap()[0]
            .id,
        b
    );
    assert_eq!(
        repo::count_feed_filtered(db.pool(), None, false, &filter)
            .await
            .unwrap(),
        2
    );
    sqlx::query(
        "UPDATE sections SET archived_at=8 WHERE key=(SELECT section FROM posts WHERE id=?)",
    )
    .bind(a)
    .execute(db.pool())
    .await
    .unwrap();
    assert_eq!(
        repo::count_feed_filtered(db.pool(), None, false, &filter)
            .await
            .unwrap(),
        0
    );
    assert!(
        repo::list_feed_filtered(db.pool(), None, false, &filter, 12, 0)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn featured_fractional_boundary_and_issues_do_not_score() {
    let db = Db::in_memory().await.unwrap();
    db.migrate().await.unwrap();
    let author = repo::create_user(db.pool(), "fraction", None, "h", 0, 1)
        .await
        .unwrap();
    let mut ids = Vec::new();
    // 21.2 必须超过较新的 21；20 与普通 20 按发布时间打破并列。
    for (title, likes, featured, time) in [
        ("D", 0, true, 1),
        ("E", 1, true, 2),
        ("F", 21, false, 3),
        ("G", 20, false, 4),
    ] {
        let id = repo::create_post(db.pool(), author, title, "正文", time)
            .await
            .unwrap();
        ids.push(id);
        for i in 0..likes {
            let voter =
                repo::create_user(db.pool(), &format!("fraction{title}{i}"), None, "h", 0, 1)
                    .await
                    .unwrap();
            sqlx::query("INSERT INTO post_likes VALUES (?, ?, 1)")
                .bind(id)
                .bind(voter)
                .execute(db.pool())
                .await
                .unwrap();
        }
        if featured {
            repo::set_post_featured(db.pool(), id, true, Some(author), 5)
                .await
                .unwrap();
        }
    }
    let filter = repo::FeedFilter {
        section: None,
        search: "",
        sort: repo::FeedSort::Recommended,
    };
    let expected = vec![ids[1], ids[2], ids[3], ids[0]];
    for stage in 0..3 {
        let rows = repo::list_feed_filtered(db.pool(), None, false, &filter, 20, 0)
            .await
            .unwrap();
        assert_eq!(rows.iter().map(|r| r.id).collect::<Vec<_>>(), expected);
        assert_eq!(rows[0].featured_at, Some(5));
        if stage == 0 {
            sqlx::query("INSERT INTO post_issues(post_id,author_id,title,created_at,updated_at) VALUES (?,?,'问题',100,100)").bind(ids[0]).bind(author).execute(db.pool()).await.unwrap();
        } else if stage == 1 {
            sqlx::query("INSERT INTO issue_comments(issue_id,author_id,body,created_at) VALUES ((SELECT id FROM post_issues LIMIT 1),?,'回复',200)").bind(author).execute(db.pool()).await.unwrap();
        }
    }
    assert_eq!(
        repo::get_post_for(db.pool(), ids[0], None, false)
            .await
            .unwrap()
            .unwrap()
            .featured_at,
        Some(5)
    );
    assert!(
        repo::list_posts(db.pool(), 20, 0)
            .await
            .unwrap()
            .iter()
            .any(|r| r.featured_at == Some(5))
    );
    assert!(
        repo::list_posts_by_author(db.pool(), author, false, 20)
            .await
            .unwrap()
            .iter()
            .any(|r| r.featured_at == Some(5))
    );
}

#[tokio::test]
async fn pending_and_legacy_feed_read_featured_column() {
    let db = Db::in_memory().await.unwrap();
    db.migrate().await.unwrap();
    let author = repo::create_user(db.pool(), "legacy", None, "h", 0, 1)
        .await
        .unwrap();
    let id = repo::create_post(db.pool(), author, "旧列表", "正文", 1)
        .await
        .unwrap();
    repo::set_post_featured(db.pool(), id, true, Some(author), 5)
        .await
        .unwrap();
    assert_eq!(
        repo::list_feed(db.pool(), None, false, 20, 0)
            .await
            .unwrap()[0]
            .featured_at,
        Some(5)
    );
    sqlx::query("UPDATE posts SET review_state='pending' WHERE id=?")
        .bind(id)
        .execute(db.pool())
        .await
        .unwrap();
    assert_eq!(
        repo::list_pending_posts(db.pool(), 20).await.unwrap()[0].featured_at,
        Some(5)
    );
}
