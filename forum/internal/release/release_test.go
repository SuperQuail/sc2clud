package release_test

import (
	"errors"
	"strings"
	"testing"
	"time"

	"forum/internal/platform/apperr"
	"forum/internal/release"
)

// 最新 stable：草稿与归档都不对外；返回的版本带它的全部产物。
func TestLatestOnlyPublishedStable(t *testing.T) {
	h := newHarness(t)
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)

	first := h.publish("1.0.0", now.Add(-48*time.Hour))
	second := h.publish("1.1.0", now.Add(-24*time.Hour))
	// 草稿（没发布）不该出现
	if _, err := h.svc.UpsertRelease(h.ctx, h.adminActor(), release.UpsertReleaseInput{
		Version: "9.9.9", Channel: release.ChannelStable,
	}); err != nil {
		t.Fatal(err)
	}
	// beta 通道不参与 stable 查询
	h.clk.T = now
	betaRel, err := h.svc.UpsertRelease(h.ctx, h.adminActor(), release.UpsertReleaseInput{
		Version: "2.0.0-beta.1", Channel: release.ChannelBeta,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.UpsertAsset(h.ctx, h.adminActor(), release.UpsertAssetInput{
		ReleaseID: betaRel.ID, Platform: "windows", Arch: "x86_64",
		URL: "https://example.com/beta.zip", SHA256: strings.Repeat("b", 64), Size: 10,
	}); err != nil {
		t.Fatal(err)
	}
	h.clk.T = now.Add(time.Hour)
	if err := h.svc.SetReleaseStatus(h.ctx, h.adminActor(), release.SetReleaseStatusInput{
		ID: betaRel.ID, Status: release.StatusPublished,
	}); err != nil {
		t.Fatal(err)
	}

	out, err := h.svc.Latest(h.ctx, "")
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	if out.ID != second {
		t.Fatalf("latest 应当是 1.1.0（%s），实际 %s", second, out.Version)
	}
	if len(out.Assets) != 1 || out.Assets[0].Platform != "windows" {
		t.Fatalf("latest 必须带产物: %+v", out.Assets)
	}
	_ = first

	betaOut, err := h.svc.Latest(h.ctx, release.ChannelBeta)
	if err != nil {
		t.Fatalf("latest beta: %v", err)
	}
	if betaOut.Version != "2.0.0-beta.1" {
		t.Fatalf("beta 通道应当拿到 beta 版本，实际 %s", betaOut.Version)
	}
	if _, err := h.svc.Latest(h.ctx, "nightly"); !isInvalidInput(err) {
		t.Fatalf("未知通道必须 400，实际 %v", err)
	}
}

// 一个版本都没有时：404（前端按它显示「还没有发布」）。
func TestLatestEmptyIsNotFound(t *testing.T) {
	h := newHarness(t)
	if _, err := h.svc.Latest(h.ctx, ""); !errors.Is(err, release.ErrNotFound) {
		t.Fatalf("没有版本必须 404，实际 %v", err)
	}
}

// 游标分页：不许重复或漏项；next_cursor 只在取满一页时给。
func TestListReleasesCursor(t *testing.T) {
	h := newHarness(t)
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	want := map[string]bool{}
	for i := 0; i < 5; i++ {
		v := "1." + string(rune('0'+i)) + ".0"
		h.publish(v, now.Add(time.Duration(i)*time.Hour))
		want[v] = true
	}

	seen := map[string]bool{}
	cursor := ""
	for page := 0; page < 5; page++ {
		out, err := h.svc.ListReleases(h.ctx, release.ListReleasesInput{Limit: 2, Cursor: cursor})
		if err != nil {
			t.Fatalf("第 %d 页: %v", page+1, err)
		}
		for _, it := range out.Items {
			if seen[it.ID] {
				t.Fatalf("游标翻页出现重复版本: %s", it.Version)
			}
			seen[it.ID] = true
		}
		if out.NextCursor == "" {
			break
		}
		cursor = out.NextCursor
	}
	if len(seen) != len(want) {
		t.Fatalf("翻页漏项：期望 %d 个，实际 %d", len(want), len(seen))
	}

	// 伪造的游标必须 400，不被当第一页吞掉
	if _, err := h.svc.ListReleases(h.ctx, release.ListReleasesInput{Cursor: "not-base64!!"}); !isInvalidInput(err) {
		t.Fatalf("坏游标必须 400，实际 %v", err)
	}
	// 取满一页时给 next_cursor，取不满时给空
	out, err := h.svc.ListReleases(h.ctx, release.ListReleasesInput{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	if out.NextCursor != "" {
		t.Fatalf("没取满一页时 next_cursor 必须为空，实际 %q", out.NextCursor)
	}
}

// 版本号唯一：重复的新建请求给 409，不是 500。
func TestVersionConflict(t *testing.T) {
	h := newHarness(t)
	in := release.UpsertReleaseInput{Version: "1.0.0", Channel: release.ChannelStable}
	if _, err := h.svc.UpsertRelease(h.ctx, h.adminActor(), in); err != nil {
		t.Fatal(err)
	}
	// 同一个版本号再来一次 = 更新（幂等），不是冲突
	if _, err := h.svc.UpsertRelease(h.ctx, h.adminActor(), in); err != nil {
		t.Fatalf("同版本号再次录入应当是更新: %v", err)
	}
	if n := h.scalar("SELECT count(*) FROM releases WHERE version = '1.0.0'"); n != 1 {
		t.Fatalf("同版本号只该有一行，实际 %d", n)
	}
	// 版本号格式非法 → 400
	if _, err := h.svc.UpsertRelease(h.ctx, h.adminActor(), release.UpsertReleaseInput{Version: "不是版本号"}); !isInvalidInput(err) {
		t.Fatalf("非法版本号必须 400，实际 %v", err)
	}
}

// 状态机：publish 需要至少一个产物；publish 只写一次 published_at；重复 publish / archive 幂等。
func TestReleaseStatusMachine(t *testing.T) {
	h := newHarness(t)
	actor := h.adminActor()

	rel, err := h.svc.UpsertRelease(h.ctx, actor, release.UpsertReleaseInput{Version: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	if rel.Status != release.StatusDraft || rel.PublishedAt != nil {
		t.Fatalf("新建必须是 draft 且没有发布时间: %+v", rel)
	}
	// 没有产物就发布 → 400，且状态不变
	if err := h.svc.SetReleaseStatus(h.ctx, actor, release.SetReleaseStatusInput{
		ID: rel.ID, Status: release.StatusPublished,
	}); !isInvalidInput(err) {
		t.Fatalf("没有产物必须拒绝发布，实际 %v", err)
	}
	if got := h.scalar("SELECT count(*) FROM releases WHERE public_id = $1 AND status = 'draft'", rel.ID); got != 1 {
		t.Fatal("被拒的发布不许改状态")
	}

	if _, err := h.svc.UpsertAsset(h.ctx, actor, release.UpsertAssetInput{
		ReleaseID: rel.ID, Platform: "windows", Arch: "x86_64",
		URL: "https://example.com/a.zip", SHA256: strings.Repeat("c", 64), Size: 5,
	}); err != nil {
		t.Fatal(err)
	}
	h.clk.T = time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	if err := h.svc.SetReleaseStatus(h.ctx, actor, release.SetReleaseStatusInput{
		ID: rel.ID, Status: release.StatusPublished,
	}); err != nil {
		t.Fatal(err)
	}
	first := h.textTime("SELECT published_at FROM releases WHERE public_id = $1", rel.ID)

	// 第二次 publish：published_at 不许变（d5 §5.4）
	h.clk.T = h.clk.T.Add(48 * time.Hour)
	if err := h.svc.SetReleaseStatus(h.ctx, actor, release.SetReleaseStatusInput{
		ID: rel.ID, Status: release.StatusPublished,
	}); err != nil {
		t.Fatalf("重复 publish 必须幂等: %v", err)
	}
	if again := h.textTime("SELECT published_at FROM releases WHERE public_id = $1", rel.ID); !again.Equal(first) {
		t.Fatalf("重复 publish 不许改 published_at: %v -> %v", first, again)
	}

	// archived：published_at 必须清空（ck_releases_published_at）
	if err := h.svc.SetReleaseStatus(h.ctx, actor, release.SetReleaseStatusInput{
		ID: rel.ID, Status: release.StatusArchived,
	}); err != nil {
		t.Fatal(err)
	}
	if got := h.scalar("SELECT count(*) FROM releases WHERE public_id = $1 AND published_at IS NULL", rel.ID); got != 1 {
		t.Fatal("归档必须清空 published_at")
	}
	// 重新 publish：写一个新的时间（首次那次已经作废了）
	if err := h.svc.SetReleaseStatus(h.ctx, actor, release.SetReleaseStatusInput{
		ID: rel.ID, Status: release.StatusPublished,
	}); err != nil {
		t.Fatal(err)
	}
	if got := h.scalar("SELECT count(*) FROM releases WHERE public_id = $1 AND published_at IS NOT NULL", rel.ID); got != 1 {
		t.Fatal("重新发布必须有新的 published_at")
	}
	// 状态值域
	if err := h.svc.SetReleaseStatus(h.ctx, actor, release.SetReleaseStatusInput{
		ID: rel.ID, Status: "nightly",
	}); !isInvalidInput(err) {
		t.Fatalf("未知状态必须 400，实际 %v", err)
	}
}

// 302 转链：只有 published 的版本可转，计数加在内存里。
func TestResolveAssetCounts(t *testing.T) {
	h := newHarness(t)
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	id := h.publish("1.0.0", now)
	assetID := h.text("SELECT public_id::text FROM release_assets WHERE release_id = (SELECT id FROM releases WHERE public_id = $1)", id)

	target, err := h.svc.ResolveAsset(h.ctx, assetID)
	if err != nil {
		t.Fatalf("转链: %v", err)
	}
	if target != "https://example.com/sc2clud-1.0.0.zip" {
		t.Fatalf("转链目标不对: %q", target)
	}
	if len(h.ctr.keys) != 1 || !strings.HasPrefix(h.ctr.keys[0], "download:asset:") {
		t.Fatalf("必须按 counter 的键加一次下载量，实际 %v", h.ctr.keys)
	}

	// 归档之后不再对外
	if err := h.svc.SetReleaseStatus(h.ctx, h.adminActor(), release.SetReleaseStatusInput{
		ID: id, Status: release.StatusArchived,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := h.svc.ResolveAsset(h.ctx, assetID); !errors.Is(err, release.ErrNotFound) {
		t.Fatalf("归档版本必须 404，实际 %v", err)
	}
	if len(h.ctr.keys) != 1 {
		t.Fatalf("没转成功不该计数，实际 %v", h.ctr.keys)
	}
	if _, err := h.svc.ResolveAsset(h.ctx, "not-a-uuid"); !errors.Is(err, release.ErrNotFound) {
		t.Fatalf("坏 id 必须 404，实际 %v", err)
	}
}

// 计数写回：增量而非赋值；只认 download:asset: 前缀。
func TestFlushDownloads(t *testing.T) {
	h := newHarness(t)
	id := h.publish("1.0.0", time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC))
	assetID := h.scalar("SELECT id FROM release_assets WHERE release_id = (SELECT id FROM releases WHERE public_id = $1)", id)

	key := "download:asset:" + itoa(assetID)
	if err := h.svc.FlushDownloads(h.ctx, []string{key, "view:topic:7"}, []int64{3, 5}); err != nil {
		t.Fatalf("写回: %v", err)
	}
	if got := h.scalar("SELECT download_count FROM release_assets WHERE id = $1", assetID); got != 3 {
		t.Fatalf("下载量应当是 3，实际 %d", got)
	}
	// 再来一轮：增量累加
	if err := h.svc.FlushDownloads(h.ctx, []string{key}, []int64{2}); err != nil {
		t.Fatal(err)
	}
	if got := h.scalar("SELECT download_count FROM release_assets WHERE id = $1", assetID); got != 5 {
		t.Fatalf("下载量应当累加到 5，实际 %d", got)
	}
	// 没有本模块的键：什么都不做，也不报错
	if err := h.svc.FlushDownloads(h.ctx, []string{"view:topic:1"}, []int64{1}); err != nil {
		t.Fatalf("别的域的键必须被忽略: %v", err)
	}
	if err := h.svc.FlushDownloads(h.ctx, nil, nil); err != nil {
		t.Fatalf("空批必须放行: %v", err)
	}
}

// 外部直链是信任边界：javascript:/file:/带 userinfo 的一律拒。
func TestAssetURLValidation(t *testing.T) {
	h := newHarness(t)
	rel, err := h.svc.UpsertRelease(h.ctx, h.adminActor(), release.UpsertReleaseInput{Version: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	bad := []string{
		"javascript:alert(1)",
		"file:///etc/passwd",
		"https://user:pw@example.com/a.zip",
		"ftp://example.com/a.zip",
		"not a url",
	}
	for _, u := range bad {
		_, err := h.svc.UpsertAsset(h.ctx, h.adminActor(), release.UpsertAssetInput{
			ReleaseID: rel.ID, Platform: "windows", Arch: "x86_64",
			URL: u, SHA256: strings.Repeat("d", 64),
		})
		if !isInvalidInput(err) {
			t.Fatalf("%q 必须被拒（400），实际 %v", u, err)
		}
	}
	// sha256 必须是小写 64 位
	if _, err := h.svc.UpsertAsset(h.ctx, h.adminActor(), release.UpsertAssetInput{
		ReleaseID: rel.ID, Platform: "windows", Arch: "x86_64",
		URL: "https://example.com/a.zip", SHA256: "ABC",
	}); !isInvalidInput(err) {
		t.Fatalf("坏 sha256 必须 400，实际 %v", err)
	}
}

// 权限：没有 site.setting 的普通用户四个管理端点全部 403（service 层兜底，队列/CLI 也走这条）。
func TestAdminRequiresPerm(t *testing.T) {
	h := newHarness(t)
	bob := h.plainActor()
	if _, err := h.svc.UpsertRelease(h.ctx, bob, release.UpsertReleaseInput{Version: "1.0.0"}); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("录版本必须 403，实际 %v", err)
	}
	if err := h.svc.SetReleaseStatus(h.ctx, bob, release.SetReleaseStatusInput{ID: "x", Status: release.StatusDraft}); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("改状态必须 403，实际 %v", err)
	}
	if _, err := h.svc.UpsertAsset(h.ctx, bob, release.UpsertAssetInput{}); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("加产物必须 403，实际 %v", err)
	}
	if err := h.svc.DeleteAsset(h.ctx, bob, "x"); !errors.Is(err, apperr.ErrForbidden) {
		t.Fatalf("删产物必须 403，实际 %v", err)
	}
	if _, err := h.svc.UpsertRelease(h.ctx, nil, release.UpsertReleaseInput{Version: "1.0.0"}); !errors.Is(err, apperr.ErrUnauthorized) {
		t.Fatalf("没身份必须 401，实际 %v", err)
	}
}

// 删除产物：按 public_id；重复删 404。
func TestDeleteAsset(t *testing.T) {
	h := newHarness(t)
	now := time.Date(2026, 10, 13, 12, 0, 0, 0, time.UTC)
	id := h.publish("1.0.0", now)
	asset := h.text("SELECT public_id::text FROM release_assets WHERE release_id = (SELECT id FROM releases WHERE public_id = $1)", id)
	if err := h.svc.DeleteAsset(h.ctx, h.adminActor(), asset); err != nil {
		t.Fatalf("删产物: %v", err)
	}
	if err := h.svc.DeleteAsset(h.ctx, h.adminActor(), asset); !errors.Is(err, release.ErrNotFound) {
		t.Fatalf("重复删必须 404，实际 %v", err)
	}
	if n := h.scalar("SELECT count(*) FROM release_assets"); n != 0 {
		t.Fatalf("产物应当删掉，实际剩 %d", n)
	}
}

// isInvalidInput 判 code：apperr.Invalid 造的是新值，不是 ErrInvalidInput 这个哨兵，
// 所以只能按 Code 判（handler 也是这么做的）。
func isInvalidInput(err error) bool {
	var ae *apperr.Error
	return errors.As(err, &ae) && ae.Code == apperr.CodeInvalidInput
}
