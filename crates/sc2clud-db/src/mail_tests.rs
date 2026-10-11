//! 发信账号与验证码的仓储测试。
//!
//! 这些函数都有外部副作用（写密文、改额度账、跨表外键），按仓库约定必须有测试。

use sqlx::SqlitePool;

use crate::models::{MailAccountDraft, MailAccountRow};
use crate::{Db, repo};

async fn db() -> Db {
    let db = Db::in_memory().await.expect("内存库");
    db.migrate().await.expect("迁移应成功");
    db
}

/// 加密用的密钥文件路径（用临时目录，不碰真实数据目录）。
fn secret_path() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("sc2clud-mail-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("临时目录");
    dir.join("x.sqlite3")
}

fn draft(label: &str, priority: i64) -> MailAccountDraft {
    MailAccountDraft {
        provider: "resend".to_string(),
        label: label.to_string(),
        priority,
        from_address: "noreply@example.com".to_string(),
        from_name: "SC2clud".to_string(),
        reply_to: String::new(),
        options_json: "{\"base_url\":\"http://127.0.0.1:1\"}".to_string(),
        daily_quota: 100,
        enabled: true,
        actor_id: None,
    }
}

async fn find(pool: &SqlitePool, id: i64) -> MailAccountRow {
    repo::list_mail_accounts(pool, true)
        .await
        .expect("列表")
        .into_iter()
        .find(|a| a.id == id)
        .expect("账号应该还在")
}

#[tokio::test]
async fn accounts_are_ordered_by_priority_and_archive_hides_them() {
    let db = db().await;
    let pool = db.pool();
    let now = 1_700_000_000;
    let backup = repo::add_mail_account(pool, &draft("备用", 200), now)
        .await
        .expect("新增");
    let primary = repo::add_mail_account(pool, &draft("主号", 100), now)
        .await
        .expect("新增");

    let list = repo::list_mail_accounts(pool, false).await.expect("列表");
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].id, primary, "priority 小的排前面（主用在前）");
    assert_eq!(list[1].id, backup);

    assert!(
        repo::archive_mail_account(pool, backup, true, now)
            .await
            .expect("归档")
    );
    assert_eq!(
        repo::list_mail_accounts(pool, false)
            .await
            .expect("列表")
            .len(),
        1,
        "归档的不出现在可用列表"
    );
    assert_eq!(
        repo::list_mail_accounts(pool, true)
            .await
            .expect("列表")
            .len(),
        2,
        "include_archived 能看见归档的"
    );
    assert!(
        !repo::archive_mail_account(pool, backup, true, now)
            .await
            .expect("重复归档"),
        "已经归档过就不再算改动"
    );

    assert!(
        repo::set_mail_enabled(pool, primary, false, now)
            .await
            .expect("停用")
    );
    assert_eq!(find(pool, primary).await.enabled, 0);
}

#[tokio::test]
async fn secret_round_trips_and_is_stored_encrypted() {
    let db = db().await;
    let pool = db.pool();
    let path = secret_path();
    let now = 1_700_000_000;
    // updated_by 是指向 users 的外键：真实路径上操作者一定存在，这里也要建一个。
    let admin = repo::create_user(pool, "admin", None, "x", 0, now)
        .await
        .expect("建操作者");
    let id = repo::add_mail_account(pool, &draft("主号", 100), now)
        .await
        .expect("新增");

    assert!(!repo::mail_secret_set(pool, id).await.expect("查询"));
    assert!(repo::mail_secret(pool, &path, id).await.is_none());

    let payload = "{\"api_key\":\"re_test_123\"}";
    repo::set_mail_secret(pool, &path, id, payload, Some(admin), now)
        .await
        .expect("存密钥");

    let (by,): (Option<i64>,) = sqlx::query_as("SELECT updated_by FROM mail_accounts WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await
        .expect("读 updated_by");
    assert_eq!(by, Some(admin), "要留下是谁改的密钥");

    assert!(repo::mail_secret_set(pool, id).await.expect("查询"));
    assert_eq!(
        repo::mail_secret(pool, &path, id).await.as_deref(),
        Some(payload),
        "取回来的必须和存进去的一样"
    );

    let (cipher,): (Vec<u8>,) =
        sqlx::query_as("SELECT secret_cipher FROM mail_accounts WHERE id = ?")
            .bind(id)
            .fetch_one(pool)
            .await
            .expect("读密文");
    assert!(cipher.len() > payload.len(), "密文不该比明文短");
    assert!(
        !cipher.windows(6).any(|w| w == b"re_tes"),
        "密文里不该出现明文片段"
    );

    // 别的账号拿不到这份密钥
    let other = repo::add_mail_account(pool, &draft("另一个", 300), now)
        .await
        .expect("新增");
    assert!(repo::mail_secret(pool, &path, other).await.is_none());

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn quota_counts_per_day_and_result_clears_cooldown() {
    let db = db().await;
    let pool = db.pool();
    let now: i64 = 1_700_000_000;
    let day = now.div_euclid(86_400) * 86_400;
    let id = repo::add_mail_account(pool, &draft("主号", 100), now)
        .await
        .expect("新增");

    repo::mark_mail_sent(pool, id, day, now)
        .await
        .expect("记一封");
    repo::mark_mail_sent(pool, id, day, now + 1)
        .await
        .expect("再记一封");
    let row = find(pool, id).await;
    assert_eq!(row.sent_today, 2);
    assert_eq!(row.quota_day, day);

    // 换一天要从头算，否则额度会永久卡死（多 key 轮换就靠这个）
    let tomorrow = day + 86_400;
    repo::mark_mail_sent(pool, id, tomorrow, tomorrow)
        .await
        .expect("隔天记一封");
    let row = find(pool, id).await;
    assert_eq!(row.sent_today, 1, "跨日归零");
    assert_eq!(row.quota_day, tomorrow);

    repo::record_mail_result(pool, id, false, "被限速", Some(tomorrow + 60), tomorrow)
        .await
        .expect("记失败");
    let row = find(pool, id).await;
    assert_eq!(row.cooldown_until, Some(tomorrow + 60));
    assert_eq!(row.last_error, "被限速");
    assert_eq!(row.last_error_at, Some(tomorrow));

    repo::record_mail_result(pool, id, true, "", None, tomorrow + 10)
        .await
        .expect("记成功");
    let row = find(pool, id).await;
    assert_eq!(row.cooldown_until, None, "成功必须解除冷却");
    assert_eq!(row.last_error, "");
    assert_eq!(row.last_ok_at, Some(tomorrow + 10));
}

#[tokio::test]
async fn email_code_links_to_a_mail_account() {
    let db = db().await;
    let pool = db.pool();
    let now = 1_700_000_000;
    let account = repo::add_mail_account(pool, &draft("主号", 100), now)
        .await
        .expect("新增");

    // 0031 里 account_id 的外键指向 smtp_accounts，写 mail_accounts 的 id 会直接失败 ——
    // 这条断言就是那个回归的守门人。
    let code_id = repo::create_email_code(
        pool,
        "a@b.c",
        "hash",
        "salt",
        "register",
        now + 600,
        Some(account),
        "203.0.113.9",
        now,
    )
    .await
    .expect("写验证码");

    let (count, last) = repo::email_codes_since(pool, "a@b.c", now - 60)
        .await
        .expect("查询");
    assert_eq!(count, 1);
    assert_eq!(last, Some(now));
    assert_eq!(
        repo::email_codes_total_since(pool, now - 60)
            .await
            .expect("查询"),
        1
    );

    let (ip,): (String,) = sqlx::query_as("SELECT request_ip FROM email_codes WHERE id = ?")
        .bind(code_id)
        .fetch_one(pool)
        .await
        .expect("读来源 IP");
    assert_eq!(ip, "203.0.113.9");

    let (id, hash, salt, attempts) = repo::newest_email_code(pool, "a@b.c", "register", now + 1)
        .await
        .expect("查询")
        .expect("应该有码");
    assert_eq!(
        (id, hash.as_str(), salt.as_str(), attempts),
        (code_id, "hash", "salt", 0)
    );

    repo::bump_email_code_attempts(pool, id)
        .await
        .expect("累加尝试次数");
    let (_, _, _, attempts) = repo::newest_email_code(pool, "a@b.c", "register", now + 1)
        .await
        .expect("查询")
        .expect("有码");
    assert_eq!(attempts, 1);

    // 过期的码取不到
    assert!(
        repo::newest_email_code(pool, "a@b.c", "register", now + 601)
            .await
            .expect("查询")
            .is_none(),
        "过期后不该再返回"
    );

    repo::consume_email_code(pool, id, now + 2)
        .await
        .expect("消费");
    assert!(
        repo::newest_email_code(pool, "a@b.c", "register", now + 1)
            .await
            .expect("查询")
            .is_none(),
        "消费后不该再返回"
    );
}
