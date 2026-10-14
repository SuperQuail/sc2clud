package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/platform/db"
	"forum/migrations"
)

// board_covers_test.go：内置分区图标导入（forum board-covers）的验收。
//
// 钉三件事，都是「跑一次就对、跑两次会露馅」的那种：
//  1. **接口看得见**：GET /api/v1/boards 的五个 cover_hash 非空（以前全空，左栏就没图）；
//  2. **重复执行无变化**：第二遍 mounted=0 unchanged=5、refcount 不变、盘上文件不多一个；
//  3. **引用计数接对了**：每个封面恰好 1 次引用（images.refcount=1）——接错的方向是每跑一次 +1，
//     而那种漂移只有数库才看得出来。

// TestBoardCoversImportIsVisibleAndIdempotent 走的是真那条路：真库 → 迁移 → newModules →
// 真 HTTP handler。素材来自仓库里的 manifest（新站自己的产物），不是夹具。
func TestBoardCoversImportIsVisibleAndIdempotent(t *testing.T) {
	if testing.Short() {
		t.Skip("要起真库，-short 跳过")
	}
	ctx := context.Background()
	cfg := e2eConfig(t)
	cfg.Web.DistDir = repoWebDist(t)
	if err := db.Migrate(ctx, cfg.DB.DSN, migrations.FS()); err != nil {
		t.Fatalf("跑迁移失败: %v", err)
	}
	in, err := NewInfra(ctx, cfg, discardLogger())
	if err != nil {
		t.Fatalf("NewInfra: %v", err)
	}
	defer in.Close()
	if _, err := newModules(ctx, cfg, in); err != nil {
		t.Fatalf("newModules: %v", err)
	}
	// 分区是运营数据（迁移里没有），照 seed 那五行的 slug 建。
	// ON CONFLICT DO NOTHING：同包的用例共用这一个库，任何先跑过 `Seed` 的用例都已经把这五个分区建好了
	// （2026-10-14：加公告区 ACL 用例时踩到 —— 全包一起跑必炸，单跑那条则看不到）。
	for _, slug := range []string{"announcement", "vanilla-mod", "custom-campaign", "tool-player", "tool-dev"} {
		if _, err := in.Pool.Exec(ctx,
			"INSERT INTO boards (slug, name, description) VALUES ($1, $1, '导入用例的分区') "+
				"ON CONFLICT (slug) DO NOTHING", slug); err != nil {
			t.Fatalf("建分区 %s: %v", slug, err)
		}
	}

	manifest := filepath.Join(repoDir(t), "完全重构", "迁移素材", "board-covers.json")
	want := manifestHashes(t, manifest)

	// 干跑：不写盘、不碰库（所以先数一次盘上的文件）。
	before := countFiles(t, cfg.Image.Root)
	if err := BoardCovers(ctx, cfg, manifest, true); err != nil {
		t.Fatalf("干跑失败: %v", err)
	}
	if got := countFiles(t, cfg.Image.Root); got != before {
		t.Fatalf("干跑不该落盘：之前 %d 个文件，之后 %d 个", before, got)
	}

	if err := BoardCovers(ctx, cfg, manifest, false); err != nil {
		t.Fatalf("第一次导入失败: %v", err)
	}
	assertCovers(t, ctx, in, want)
	assertRefcounts(t, ctx, in, want, 1)
	afterFirst := countFiles(t, cfg.Image.Root)

	// 第二遍：同样的输入，库里与盘上都必须是同一个结果。
	if err := BoardCovers(ctx, cfg, manifest, false); err != nil {
		t.Fatalf("第二次导入失败: %v", err)
	}
	assertCovers(t, ctx, in, want)
	assertRefcounts(t, ctx, in, want, 1)
	if got := countFiles(t, cfg.Image.Root); got != afterFirst {
		t.Fatalf("第二遍不该再落盘：第一遍后 %d 个文件，第二遍后 %d 个", afterFirst, got)
	}

	// 出接口：左侧栏读的就是它（forum/internal/forum/dto.go 的 BoardDTO.cover_hash）。
	gin.SetMode(gin.TestMode)
	m, err := newModules(ctx, cfg, in)
	if err != nil {
		t.Fatalf("newModules: %v", err)
	}
	srv, err := newHTTPServer(cfg, in, m, BuildInfo{Version: "cover-test"})
	if err != nil {
		t.Fatalf("newHTTPServer: %v", err)
	}
	ts := httptest.NewServer(srv.Engine)
	defer ts.Close()
	res, err := http.Get(ts.URL + "/api/v1/boards")
	if err != nil {
		t.Fatalf("GET /api/v1/boards: %v", err)
	}
	defer func() { _ = res.Body.Close() }()
	var body struct {
		Data []struct {
			Slug      string `json:"slug"`
			CoverHash string `json:"cover_hash"`
		} `json:"data"`
	}
	if err := json.NewDecoder(res.Body).Decode(&body); err != nil {
		t.Fatalf("解析 /api/v1/boards: %v", err)
	}
	got := map[string]string{}
	for _, b := range body.Data {
		got[b.Slug] = b.CoverHash
	}
	for slug, hash := range want {
		if got[slug] != hash {
			t.Errorf("GET /api/v1/boards 的 %s.cover_hash = %q，期望 %q（左栏的图就是靠它）", slug, got[slug], hash)
		}
	}
	if len(want) != 5 {
		t.Fatalf("manifest 应当是五个分区，实际 %d 个", len(want))
	}
}

// assertCovers 逐个比对库里那一列（空串 = 没有封面，这是接口与前端共同的判据）。
func assertCovers(t *testing.T, ctx context.Context, in *Infra, want map[string]string) {
	t.Helper()
	for slug, hash := range want {
		var got *string
		if err := in.Pool.QueryRow(ctx, "SELECT cover_hash FROM boards WHERE slug = $1", slug).Scan(&got); err != nil {
			t.Fatalf("读分区 %s 的封面: %v", slug, err)
		}
		if got == nil || *got != hash {
			t.Fatalf("分区 %s 的 cover_hash = %v，期望 %s", slug, got, hash)
		}
	}
}

// assertRefcounts 钉「挂一个封面 = 一次引用」。接错的方向是每跑一次导入就 +1，而 refcount 只增不减
// 会让那张图永远不被 image:gc 回收（= 盘上永远留着）。
func assertRefcounts(t *testing.T, ctx context.Context, in *Infra, want map[string]string, n int) {
	t.Helper()
	for slug, hash := range want {
		var got int
		if err := in.Pool.QueryRow(ctx, "SELECT refcount FROM images WHERE hash = $1", hash).Scan(&got); err != nil {
			t.Fatalf("读 %s（分区 %s）的引用计数: %v", hash, slug, err)
		}
		if got != n {
			t.Fatalf("分区 %s 的封面 %s refcount = %d，期望 %d", slug, hash, got, n)
		}
	}
}

// manifestHashes 读 manifest 并把每个素材的 sha256 算出来 —— 期望值来自**文件字节**，
// 不是往用例里抄五串常量（抄了就变成「测试与实现一起错」）。
func manifestHashes(t *testing.T, path string) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读 manifest %s: %v", path, err)
	}
	var m struct {
		Covers []struct {
			Slug string `json:"slug"`
			File string `json:"file"`
		} `json:"covers"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("解析 manifest: %v", err)
	}
	dist := repoWebDist(t)
	out := make(map[string]string, len(m.Covers))
	for _, c := range m.Covers {
		b, err := os.ReadFile(filepath.Join(dist, filepath.FromSlash(c.File)))
		if err != nil {
			t.Fatalf("读素材 %s: %v", c.File, err)
		}
		out[c.Slug] = sha256Hex(b)
	}
	return out
}

func countFiles(t *testing.T, root string) int {
	t.Helper()
	n := 0
	err := filepath.WalkDir(root, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			n++
		}
		return nil
	})
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("遍历 %s: %v", root, err)
	}
	return n
}

// repoDir / repoWebDist 把用例锚在仓库上：测试工作目录是包目录（forum/internal/app），往上找到 go.mod。
func repoDir(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("取工作目录: %v", err)
	}
	for i := 0; i < 8; i++ {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return filepath.Dir(dir) // go.mod 在 forum/ 下，仓库根是它的上一级
		}
		dir = filepath.Dir(dir)
	}
	t.Fatal("找不到 go.mod（用例要按仓库根定位 manifest）")
	return ""
}

func repoWebDist(t *testing.T) string {
	t.Helper()
	root := repoDir(t)
	// 素材在产物根下（web.dist_dir）：先看构建产物，没有再回 public/ —— 出图/导入都不该强制先 build。
	dist := filepath.Join(root, "web", "dist")
	if _, err := os.Stat(filepath.Join(dist, "art", "starcraft", "nav-announcement.webp")); err == nil {
		return dist
	}
	return filepath.Join(root, "web", "public")
}

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
