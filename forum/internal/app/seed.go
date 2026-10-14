package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"time"

	"forum/internal/auth"
	authpgsql "forum/internal/auth/pgsql"
	"forum/internal/authz"
	"forum/internal/config"
	"forum/internal/ent"
	"forum/internal/ent/board"
	"forum/internal/ent/post"
	"forum/internal/ent/user"
	"forum/internal/forum"
	"forum/internal/platform/clock"
	"forum/internal/platform/idgen"
	"forum/internal/title"
)

// seedNoLoginHash 是种子账号的口令位。它不是 argon2id PHC 串，所以 auth 的 Verify 恒返回 false
// （见 auth/password.go 的 parsePHC）——**这些账号不能登录**，它们只是给页面提供内容的展示账号。
// 这是刻意的：dev 站是公开可达的，种子数据不该顺带造出一批可登录的身份。
const seedNoLoginHash = "!"

// seedModeratorHandle 是给主题打置顶 / 精华的那个人（PinTopic 要 topic.pin 权限）。
const seedModeratorHandle = "demo-admin"

// Seed 把演示数据写进当前库（dev 用）。三条约定：
//
//  1. **不是迁移**：迁移管 schema，这份数据随时可以重来，所以它必须是可重复执行的 ——
//     每一行都按自然键收敛（boards.slug / users.username / topics.client_token / posts.client_token），
//     跑第二遍是空操作，而不是长出一份重复的站；
//  2. **走生产路径**：主题与回复一律经过 forum.Service 的 CreateTopic / CreatePost / PinTopic，
//     所以 excerpt 截断、floor 取号、reply_count 与 last_reply_at 重算、搜索索引入队
//     与真实发帖逐字相同。「种子数据」与「用户数据」不会长成两种形状；
//  3. **失败即非 0 退出**（由 Main 负责退出码），任何一条写不进去都要在部署日志里看得见。
//
// 为什么是一个子命令而不是 SQL 文件：SQL 文件要重写一遍 InsertTopic / InsertPost 的列清单与
// 派生列算法，那是第二份写路径 —— 它今天能跑对，明天 schema 改了就静默地跑歪。
func Seed(ctx context.Context, cfg *config.Config) error {
	log, err := newLogger(cfg.Log)
	if err != nil {
		return err
	}
	in, err := NewInfra(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer in.Close()
	// newModules 是为了拿到 fstore 与 indexTopic（搜索索引的写入口，与 worker 消费 search:index 时同一个函数）。
	m, err := newModules(ctx, cfg, in)
	if err != nil {
		return err
	}

	// 时钟换成可拨动的：论坛的真实感有一半在时间上（「3 小时前」与「刚刚」看起来是两个站）。
	// 除时钟以外，依赖与 newModules 装出来的那一份逐字相同（同一个构造函数、同一个事务入口）。
	clk := &clock.Fake{}
	// 站点时区与请求路径同一份来源（D7）：种子的「今日」统计不能是另一套算法。
	siteTZ, err := cfg.Site.Location()
	if err != nil {
		return err
	}
	fs := forum.NewService(in.DB, clk, in.Counter, entQueue{in.Queue}, forum.Deps{
		Render: mdRenderer{}, Queue: entQueue{in.Queue}, Counter: in.Counter, Limit: in.Limiter, TZ: siteTZ,
	})

	base := time.Now().UTC().Truncate(time.Second)
	if err := seedBoards(ctx, in.DB, base); err != nil {
		return err
	}
	accounts, err := seedUsers(ctx, in.DB, base)
	if err != nil {
		return err
	}
	topics, posts, err := seedTopics(ctx, m, fs, clk, base, accounts)
	if err != nil {
		return err
	}
	if err := assertNoDuplicateTokens(ctx, in.DB); err != nil {
		return err
	}
	fmt.Printf("seed: ok, boards=%d users=%d topics=%d posts=%d\n",
		len(seedBoardRows), len(accounts), topics, posts)
	return nil
}

// assertNoDuplicateTokens 是 seed 的自查：同一个 (作者, client_token) 不允许有两行。
//
// 这条不变量本该由部分唯一索引 uq_posts_author_client_token 保证，而它现在**没有建**
// （0004 建的是普通索引，见回报的缺陷 2）。在索引补上之前，这一步让「重放不涨数据」这件事
// 当场失败，而不是等下一次有人去数行数 —— 检查必须会红，才算检查。
func assertNoDuplicateTokens(ctx context.Context, db *ent.Client) error {
	rows, err := db.Post.Query().Where(post.ClientTokenNEQ("")).
		Select(post.FieldAuthorID, post.FieldClientToken).All(ctx)
	if err != nil {
		return fmt.Errorf("seed: 自查读楼层: %w", err)
	}
	seen := make(map[string]struct{}, len(rows))
	for _, r := range rows {
		k := strconv.FormatInt(r.AuthorID, 10) + ":" + r.ClientToken
		if _, dup := seen[k]; dup {
			return fmt.Errorf("seed: 幂等键重复：作者 %d 的 token %q 在 posts 里有两行"+
				"（先补上 uq_posts_author_client_token 索引，或清掉重复行，再跑 seed）", r.AuthorID, r.ClientToken)
		}
		seen[k] = struct{}{}
	}
	return nil
}

// seedBoards 按 slug 收敛分区：分区是表驱动数据（d3 §2.1），挪动 sort 只是改一行。
func seedBoards(ctx context.Context, db *ent.Client, now time.Time) error {
	for i, b := range seedBoardRows {
		existing, err := db.Board.Query().Where(board.SlugEQ(b.slug)).Only(ctx)
		switch {
		case ent.IsNotFound(err):
			_, err = db.Board.Create().
				SetSlug(b.slug).SetName(b.name).SetDescription(b.description).
				SetSort(int32(i)).SetStatus("active").
				SetCreatedAt(now).SetUpdatedAt(now).Save(ctx)
		case err != nil:
			// 落到下面统一的错误包装
		default:
			// slug 是自然键，改它就是废掉所有外链，所以更新只碰展示字段。
			_, err = existing.Update().
				SetName(b.name).SetDescription(b.description).SetSort(int32(i)).
				SetUpdatedAt(now).Save(ctx)
		}
		if err != nil {
			return fmt.Errorf("seed: 分区 %s: %w", b.slug, err)
		}
	}
	return nil
}

// seedAccount 是一个种子用户的 id 与「请求路径上那种 Actor」。
type seedAccount struct {
	id    int64
	actor *authz.Actor
}

// seedUsers 按 username 收敛用户。角色从 roles 表按 key 取（0017 种下的四个内置角色），
// 权限集合由 auth/pgsql.LoadActor 从真实角色矩阵算出来 —— 这里不写死任何权限点。
func seedUsers(ctx context.Context, db *ent.Client, now time.Time) (map[string]*seedAccount, error) {
	roleIDs := map[string]int64{}
	roles, err := db.Role.Query().All(ctx)
	if err != nil {
		return nil, fmt.Errorf("seed: 读角色: %w", err)
	}
	for _, r := range roles {
		roleIDs[r.Key] = r.ID
	}

	out := make(map[string]*seedAccount, len(seedUserRows))
	for _, u := range seedUserRows {
		roleID, ok := roleIDs[u.roleKey]
		if !ok {
			return nil, fmt.Errorf("seed: 角色 %q 不存在（先跑 forum migrate）", u.roleKey)
		}
		row, err := db.User.Query().Where(user.UsernameEQ(u.handle)).Only(ctx)
		switch {
		case ent.IsNotFound(err):
			pub, perr := idgen.NewPublicID()
			if perr != nil {
				return nil, perr
			}
			row, err = db.User.Create().
				SetPublicID(pub).
				SetRoleID(roleID).
				SetUsername(u.handle).
				SetEmail(u.handle + "@example.com"). // RFC 2606 的保留示例域，永远不是真人
				SetPasswordHash(seedNoLoginHash).
				SetNickname(u.nickname).
				SetBio(u.bio).
				SetStatus("active").
				// trusted = 发帖跳过人工审核。种子用户不 trusted 的话，下面每一篇都是 pending，
				// 公开列表里一篇都看不到 —— 那是「seed 跑成功了但站还是空的」的经典形状。
				SetTrusted(true).
				SetExp(u.exp).
				SetLevel(title.LevelForExp(u.exp)). // 等级公式的唯一实现，不在这里再抄一遍
				SetEmailVerifiedAt(now).
				SetActivatedAt(now).
				SetCreatedAt(now.AddDate(0, 0, -u.daysAgo)).
				SetUpdatedAt(now).
				Save(ctx)
		case err != nil:
			// 落到下面统一的错误包装
		default:
			// 已存在：只刷新展示字段与经验（让人改种子文案后重跑能生效）
			row, err = row.Update().
				SetNickname(u.nickname).SetBio(u.bio).
				SetExp(u.exp).SetLevel(title.LevelForExp(u.exp)).
				SetTrusted(true).SetUpdatedAt(now).Save(ctx)
		}
		if err != nil {
			return nil, fmt.Errorf("seed: 用户 %s: %w", u.handle, err)
		}
		actor, err := seedActorOf(ctx, db, row.ID, row.RoleID, now)
		if err != nil {
			return nil, fmt.Errorf("seed: 用户 %s 的权限: %w", u.handle, err)
		}
		out[u.handle] = &seedAccount{id: row.ID, actor: actor}
	}
	return out, nil
}

// seedActorOf 造一个与线上请求同形的 Actor：权限闭包来自 auth/pgsql.LoadActor（唯一的实现），
// 投影用 auth.Principal.Actor()（与中间件同一条路）。本包不自己判权限点。
func seedActorOf(ctx context.Context, db *ent.Client, userID, roleID int64, now time.Time) (*authz.Actor, error) {
	ar, err := authpgsql.LoadActor(ctx, db, roleID, userID, now)
	if err != nil {
		return nil, err
	}
	p := &auth.Principal{
		UserID: ar.UserID, PublicID: ar.PublicID, Status: ar.Status,
		EmailVerified: ar.EmailVerified != nil, Activated: ar.ActivatedAt != nil,
		RoleID: ar.RoleID, RoleKey: ar.RoleKey, RoleName: ar.RoleName,
		IsSuper: ar.IsSuper, Perms: authz.NewSet(ar.PermKeys...), BoardIDs: ar.BoardIDs,
	}
	if ar.RoleBadge != nil {
		p.RoleBadge = *ar.RoleBadge
	}
	return p.Actor(), nil
}

// seedTopics 写主题与回复，返回实际处理的主题数与回复数。
//
// 幂等靠 client_token：CreateTopic / CreatePost 命中已存在的 token 时返回那一行
// （d3 §4.3 的幂等路径），所以重跑既不会重复发帖，也不会把时间戳推到现在。
//
// shortcut: 已存在的行不会按新文案更新（token 命中即返回原行）。
// 改了 seed_data.go 的正文要让它在库里生效，得先删掉那一行再跑 seed —— 改文案是低频动作。
func seedTopics(ctx context.Context, m *Modules, fs *forum.Service, clk *clock.Fake, base time.Time,
	accts map[string]*seedAccount) (int, int, error) {
	mod, ok := accts[seedModeratorHandle]
	if !ok {
		return 0, 0, fmt.Errorf("seed: 找不到 %s（置顶 / 精华要用它的权限）", seedModeratorHandle)
	}
	var nTopics, nPosts int
	for _, t := range seedTopicRows {
		if t.body == "" {
			return nTopics, nPosts, fmt.Errorf("seed: 主题 %q 没有正文", t.title)
		}
		author, ok := accts[t.author]
		if !ok {
			return nTopics, nPosts, fmt.Errorf("seed: 主题 %q 的作者 %s 不在名单里", t.title, t.author)
		}
		at := base.Add(-time.Duration(t.hoursAgo) * time.Hour)
		clk.T = at
		out, err := fs.CreateTopic(ctx, author.actor, forum.CreateTopicInput{
			BoardSlug: t.board, Kind: t.kind, Title: t.title, ContentMD: t.body, ClientToken: t.token,
		})
		if err != nil {
			return nTopics, nPosts, fmt.Errorf("seed: 主题 %q: %w", t.title, err)
		}
		nTopics++
		// 置顶 / 精华也走端点背后的那个 service 方法；转载帖不能置顶（那里会拒绝）。
		if t.pinned {
			if err := fs.PinTopic(ctx, mod.actor, out.ID, "pin", true); err != nil {
				return nTopics, nPosts, fmt.Errorf("seed: 置顶 %q: %w", t.title, err)
			}
		}
		if t.featured {
			if err := fs.PinTopic(ctx, mod.actor, out.ID, "feature", true); err != nil {
				return nTopics, nPosts, fmt.Errorf("seed: 精华 %q: %w", t.title, err)
			}
		}
		postIDs := make(map[int]string, len(t.replies))
		for i, r := range t.replies {
			who, ok := accts[r.author]
			if !ok {
				return nTopics, nPosts, fmt.Errorf("seed: %q 的回复作者 %s 不在名单里", t.title, r.author)
			}
			clk.T = at.Add(time.Duration(r.hoursAfter) * time.Hour)
			in := forum.CreatePostInput{ContentMD: r.body, ClientToken: fmt.Sprintf("%s-r%d", t.token, i+1)}
			// 先按 token 回查一次。CreatePost 的幂等**完全依赖** posts 上的部分唯一索引
			// uq_posts_author_client_token，而那条索引库里还没有（0004 建的是普通索引，见回报的缺陷 2）——
			// 缺了它，重放会把每条回复再插一遍（实测第二遍 +75 行）。
			// 这一查与 CreateTopic 开头那次回查是同一个形状；索引补上之后它只是少开一个事务。
			if _, publicID, err := m.fstore.PostIDByClientToken(ctx, who.id, in.ClientToken); err == nil {
				postIDs[i] = publicID
				nPosts++
				continue
			}
			if r.parent >= 0 {
				parentID, ok := postIDs[r.parent]
				if !ok {
					return nTopics, nPosts, fmt.Errorf("seed: %q 的楼中楼指向前一条不存在的回复", t.title)
				}
				in.ParentID = parentID
			}
			post, err := fs.CreatePost(ctx, who.actor, out.ID, in)
			if err != nil {
				return nTopics, nPosts, fmt.Errorf("seed: %q 的第 %d 条回复: %w", t.title, i+1, err)
			}
			postIDs[i] = post.ID
			nPosts++
		}
		// 搜索索引：调的**就是** worker 消费 search:index 时那个函数（payload 形状也一样），
		// 否则「seed 出来的帖子搜不到」—— topic_search 是派生表，不会自己长出来。
		ref, err := m.fstore.TopicRef(ctx, out.ID, 0, true)
		if err != nil {
			return nTopics, nPosts, fmt.Errorf("seed: 取主题 %q 的内部 id: %w", t.title, err)
		}
		payload, err := json.Marshal(map[string]int64{"id": ref.ID})
		if err != nil {
			return nTopics, nPosts, err
		}
		if err := m.indexTopic(ctx, payload); err != nil {
			return nTopics, nPosts, fmt.Errorf("seed: 建搜索索引 %q: %w", t.title, err)
		}
	}
	return nTopics, nPosts, nil
}
