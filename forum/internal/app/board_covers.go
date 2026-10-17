package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"forum/internal/config"
	"forum/internal/ent"
	"forum/internal/ent/board"
	"forum/internal/platform/db"
	"forum/internal/platform/image"
)

// BoardCovers 把内置分区图标（老站硬编码分区 PostSection 的那五张）导入图片存储并挂到分区上。
//
// 为什么是一条命令而不是一段 SQL：分区封面的引用计数只有**一个**入口（media.IncRefTx，d5 §4.3），
// 而图片字节必须过内容寻址存储（safety 与 hash 格式都由它保证）。SQL 文件两者都绕不过去。
//
// 幂等靠「现状与目标比对」：cover_hash 已经是目标图 → 不动（不 +1、不写 updated_at、不重算 hash），
// 所以跑第二遍输出 unchanged=N，refcount 不长。这正是重复执行的全部要求。
//
// 这一步就是「生产端完全迁移」的落点：manifest 是资料，这条命令是落地动作。
func BoardCovers(ctx context.Context, cfg *config.Config, manifestPath string, dryRun bool) error {
	man, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("board-covers: 读 manifest: %w", err)
	}
	var m boardCoverManifest
	if err := json.Unmarshal(man, &m); err != nil {
		return fmt.Errorf("board-covers: 解析 manifest %s: %w", manifestPath, err)
	}
	if len(m.Covers) == 0 {
		return fmt.Errorf("board-covers: manifest %s 里一条 covers 都没有", manifestPath)
	}
	seen := make(map[string]bool, len(m.Covers))
	for _, c := range m.Covers {
		if c.Slug == "" || c.File == "" {
			return fmt.Errorf("board-covers: manifest 里有 slug/file 为空的条目: %+v", c)
		}
		if seen[c.Slug] {
			return fmt.Errorf("board-covers: 分区 %s 在 manifest 里出现两次", c.Slug)
		}
		seen[c.Slug] = true
	}

	// dry-run 要在**不接库**的前提下也能跑（自检是上线前的动作，那时未必连得上线上库）：
	// 配置里只用到 web.dist_dir，所以配置加载失败就退回内置默认值，绝不因此拦下一次干跑。
	distDir := cfg.Web.DistDir
	if distDir == "" {
		distDir = "web/dist"
	}

	// 素材路径相对**前端产物根**（web.dist_dir）：dev 是 web/dist，线上是 <实例>/current/web/dist。
	// 用配置而不是多路兜底 —— 找不到时给的是唯一那个该改的值。
	type item struct {
		cover boardCoverEntry
		body  []byte
		hash  string
		info  os.FileInfo
	}
	items := make([]item, 0, len(m.Covers))
	for _, c := range m.Covers {
		p := filepath.Join(distDir, filepath.FromSlash(c.File))
		body, err := os.ReadFile(p)
		if err != nil {
			return fmt.Errorf("board-covers: 读素材 %s（分区 %s）: %w", p, c.Slug, err)
		}
		sum := sha256.Sum256(body)
		fi, err := os.Stat(p)
		if err != nil {
			return fmt.Errorf("board-covers: stat %s: %w", p, err)
		}
		items = append(items, item{cover: c, body: body, hash: hex.EncodeToString(sum[:]), info: fi})
	}

	if dryRun {
		fmt.Printf("board-covers: dry-run, manifest=%s dist=%s\n", manifestPath, distDir)
		for _, it := range items {
			fmt.Printf("  would set  %-16s → %s (%s, %s, %d 字节)  %s\n",
				it.cover.Slug, it.hash, it.cover.File, it.cover.LegacySection, it.info.Size(), it.cover.Source)
		}
		return nil
	}

	log, err := newLogger(cfg.Log)
	if err != nil {
		return err
	}
	in, err := NewInfra(ctx, cfg, log)
	if err != nil {
		return err
	}
	defer in.Close()
	mp, err := newModules(ctx, cfg, in)
	if err != nil {
		return err
	}

	created, mounted, unchanged := 0, 0, 0
	for _, it := range items {
		// 落盘（内容寻址，重复内容直接去重）+ 登记 images 行。两者都在事务外/事务内各做一次
		// 是刻意的：字节不进事务（拍板 §5.4），行在下面那个事务里只是「挂载它」的前置。
		hash, isNew, err := mp.Media.EnsureAsset(ctx, it.body, maxCoverBytes)
		if err != nil {
			return fmt.Errorf("board-covers: 素材 %s: %w", it.cover.File, err)
		}
		if string(hash) != it.hash {
			return fmt.Errorf("board-covers: 素材 %s 的 hash 漂了（期望 %s，实际 %s）——"+
				"文件内容变了就更新 manifest 并核对素材来源", it.cover.File, it.hash, hash)
		}
		if isNew {
			created++
		}
		did, err := mountBoardCover(ctx, in, mp, it.cover.Slug, string(hash))
		if err != nil {
			return err
		}
		if did {
			mounted++
			fmt.Printf("  set        %-16s → %s\n", it.cover.Slug, hash)
		} else {
			unchanged++
			fmt.Printf("  unchanged  %-16s → %s\n", it.cover.Slug, hash)
		}
	}
	fmt.Printf("board-covers: ok, mounted=%d unchanged=%d images_created=%d\n", mounted, unchanged, created)
	return nil
}

// mountBoardCover 挂一个封面：返回 true = 这次真的改了（false = 现状已经是它）。
//
// 引用计数（d5 §4.3）：换图/首次挂 = 旧的 −1、新的 +1；同一张重复挂**不加减**，
// 与 forum.UpdateBoard 里那段逐字同一条规则 —— 否则每跑一次导入就多欠一次，refcount 会漂。
func mountBoardCover(ctx context.Context, in *Infra, mp *Modules, slug, hash string) (bool, error) {
	changed := false
	err := db.WithTx(ctx, in.DB, func(tx *ent.Tx) error {
		row, err := tx.Board.Query().Where(board.SlugEQ(slug)).Only(ctx)
		if ent.IsNotFound(err) {
			return fmt.Errorf("board-covers: 分区 %q 不在库里（先跑 forum seed 或 forum migrate）", slug)
		}
		if err != nil {
			return fmt.Errorf("board-covers: 读分区 %s: %w", slug, err)
		}
		old := ""
		if row.CoverHash != nil {
			old = *row.CoverHash
		}
		if old == hash {
			return nil
		}
		changed = true
		if err := tx.Board.UpdateOneID(row.ID).SetCoverHash(hash).SetUpdatedAt(in.Clock.Now()).Exec(ctx); err != nil {
			return fmt.Errorf("board-covers: 设分区 %s 的封面: %w", slug, err)
		}
		if old != "" {
			if err := mp.Media.DecRefTx(ctx, tx, image.Hash(old)); err != nil {
				return err
			}
		}
		// 唯一允许的 +1 路径（media.IncRefTx）：与 boards.cover_hash 同一个事务。
		return mp.Media.IncRefTx(ctx, tx, image.Hash(hash))
	})
	if err != nil {
		return false, err
	}
	return changed, nil
}

// maxCoverBytes 是内置素材的大小上限：这些是 48×48 的图标（最大 2.4 KB），
// 给 512 KiB 是「明显不对就报错」的边界，不是业务限额。
const maxCoverBytes = 512 << 10

// boardCoverManifest 是 完全重构/迁移素材/board-covers.json 的形状。
// file 相对 web.dist_dir；legacy_section 与 source 只用于出证据（不在库里写任何东西）。
type boardCoverManifest struct {
	Covers []boardCoverEntry `json:"covers"`
}

type boardCoverEntry struct {
	Slug          string `json:"slug"`
	File          string `json:"file"`
	LegacySection string `json:"legacy_section"`
	Source        string `json:"source"`
}
