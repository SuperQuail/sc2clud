package reward_test

import (
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"forum/internal/authz"
	"forum/internal/platform/apperr"
	"forum/internal/platform/queue"
	"forum/internal/reward"
)

func mustCode(err error) string {
	var ae *apperr.Error
	if errors.As(err, &ae) {
		return ae.Code
	}
	return ""
}

// code 取错误的业务码；不是 *apperr.Error 就失败。
func code(t *testing.T, err error) string {
	t.Helper()
	var ae *apperr.Error
	if !errors.As(err, &ae) {
		t.Fatalf("期望业务错误，实际 %v", err)
	}
	return ae.Code
}

// ---- 申报 ----

func TestCreateDonationPending(t *testing.T) {
	h := newHarness(t)
	out, err := h.svc().CreateDonation(h.ctx, h.actor(h.alice), reward.CreateDonationInput{
		ToHandle: "bob", AmountCents: 500, TxnID: "TX-1", Note: "加油",
	})
	if err != nil {
		t.Fatalf("申报: %v", err)
	}
	if out.State != reward.StatePending || out.AmountCents != 500 {
		t.Fatalf("出参不对: %+v", out)
	}
	if out.Donor.Handle != "alice" || out.Recipient.Handle != "bob" {
		t.Fatalf("双方画像不对: %+v", out)
	}
	if out.Verifier != nil || out.VerifiedAt != nil {
		t.Fatal("pending 的申报不该有核验人")
	}
	if h.scalar("SELECT count(*) FROM donation_records WHERE state = 'pending'") != 1 {
		t.Fatal("库里应当有一行 pending")
	}
	if h.scalar("SELECT count(*) FROM donation_records WHERE verified_by IS NULL AND verified_at IS NULL") != 1 {
		t.Fatal("pending 行的 verified_by/verified_at 必须是 NULL")
	}
}

func TestCreateDonationToSelfRejected(t *testing.T) {
	h := newHarness(t)
	_, err := h.svc().CreateDonation(h.ctx, h.actor(h.alice), reward.CreateDonationInput{
		ToHandle: "alice", AmountCents: 100,
	})
	if code(t, err) != apperr.CodeInvalidInput {
		t.Fatalf("给自己打赏必须 400，实际 %v", err)
	}
	if h.scalar("SELECT count(*) FROM donation_records") != 0 {
		t.Fatal("被拒的申报不该落库")
	}
}

func TestCreateDonationDisabled(t *testing.T) {
	h := newHarness(t)
	h.set.values["donation.enabled"] = "off"
	_, err := h.svc().CreateDonation(h.ctx, h.actor(h.alice), reward.CreateDonationInput{
		ToHandle: "bob", AmountCents: 100,
	})
	if code(t, err) != "reward.disabled" {
		t.Fatalf("关站后必须 403 reward.disabled，实际 %v", err)
	}
}

func TestCreateDonationRejectsForeignPostAndChannel(t *testing.T) {
	h := newHarness(t)
	// 帖子的作者是 bob，收款人却是 alice：在别人帖子里给第三者打赏是数据错
	postID, _ := h.newTopic(h.bob)
	_, err := h.svc().CreateDonation(h.ctx, h.actor(h.bob), reward.CreateDonationInput{
		ToHandle: "alice", AmountCents: 100, PostID: postID,
	})
	if code(t, err) != apperr.CodeInvalidInput {
		t.Fatalf("帖子作者不是收款人必须 400，实际 %v", err)
	}
	// 收款码不属于收款人：0010 的 payment_channels 还没有 public_id 列（见 patchMigration），
	// 所以「拿别人的码」在当前迁移下解析不出对外 id，只会得到 invalid_input。
	// 列补上之后这里应当改成断言「码不属于收款人」的那条分支。
	_, err = h.svc().CreateDonation(h.ctx, h.actor(h.alice), reward.CreateDonationInput{
		ToHandle: "bob", AmountCents: 100, ChannelID: "00000000-0000-7000-8000-000000000000",
	})
	if code(t, err) != apperr.CodeNotFound {
		t.Fatalf("不存在的收款码必须 404，实际 %v", err)
	}
	if h.scalar("SELECT count(*) FROM donation_records") != 0 {
		t.Fatal("被拒的申报不该落库")
	}
}

// ---- 撤回 ----

func TestWithdrawOwnPendingIsIdempotent(t *testing.T) {
	h := newHarness(t)
	pid, id := h.donation(h.alice, h.bob, 100, reward.StatePending)
	svc := h.svc()

	if err := svc.WithdrawDonation(h.ctx, h.actor(h.alice), pid); err != nil {
		t.Fatalf("撤回: %v", err)
	}
	if got := h.state(id); got != reward.StateWithdrawn {
		t.Fatalf("撤回后状态应为 withdrawn，实际 %s", got)
	}
	if h.audit.count() != 1 {
		t.Fatalf("撤回应写一条审计，实际 %d", h.audit.count())
	}
	// 再撤一次：幂等，不写第二条审计
	if err := svc.WithdrawDonation(h.ctx, h.actor(h.alice), pid); err != nil {
		t.Fatalf("重复撤回必须成功（幂等），实际 %v", err)
	}
	if h.audit.count() != 1 {
		t.Fatalf("重复撤回不该再写审计，实际 %d", h.audit.count())
	}
}

func TestWithdrawOthersIsNotFound(t *testing.T) {
	h := newHarness(t)
	pid, id := h.donation(h.alice, h.bob, 100, reward.StatePending)
	err := h.svc().WithdrawDonation(h.ctx, h.actor(h.bob), pid)
	if code(t, err) != apperr.CodeNotFound {
		t.Fatalf("撤别人的必须 404（不泄露存在性），实际 %v", err)
	}
	if h.state(id) != reward.StatePending {
		t.Fatal("别人的申报不该被改动")
	}
}

func TestWithdrawHandledIsForbidden(t *testing.T) {
	h := newHarness(t)
	pid, id := h.donation(h.alice, h.bob, 100, reward.StateApproved)
	err := h.svc().WithdrawDonation(h.ctx, h.actor(h.alice), pid)
	if code(t, err) != apperr.CodeForbidden {
		t.Fatalf("撤已核验的必须 403，实际 %v", err)
	}
	if h.state(id) != reward.StateApproved {
		t.Fatal("已核验的申报不该被撤回")
	}
}

// ---- 核验 ----

func TestVerifyThenReplayConflicts(t *testing.T) {
	h := newHarness(t)
	pid, id := h.donation(h.alice, h.bob, 300, reward.StatePending)
	svc := h.svc()

	out, err := svc.Verify(h.ctx, h.adminActor(), pid, reward.VerifyInput{State: reward.StateApproved})
	if err != nil {
		t.Fatalf("核验: %v", err)
	}
	if out.State != reward.StateApproved || out.Verifier == nil {
		t.Fatalf("核验出参不对: %+v", out)
	}
	verifiedAt := h.scalar("SELECT extract(epoch FROM verified_at)::bigint FROM donation_records WHERE id = " + itoa(id))
	if h.audit.count() != 1 {
		t.Fatalf("核验应写一条审计，实际 %d", h.audit.count())
	}
	if h.queue.count() != 1 {
		t.Fatalf("核验应入队一条 notify:reward，实际 %d", h.queue.count())
	}

	// 同态重放：409，且 verified_at 不被改写、审计不增加
	_, err = svc.Verify(h.ctx, h.adminActor(), pid, reward.VerifyInput{State: reward.StateApproved})
	if code(t, err) != "reward.already_handled" {
		t.Fatalf("重复核验必须 409 already_handled，实际 %v", err)
	}
	if got := h.scalar("SELECT extract(epoch FROM verified_at)::bigint FROM donation_records WHERE id = " + itoa(id)); got != verifiedAt {
		t.Fatal("重放不该改写 verified_at")
	}
	if h.audit.count() != 1 {
		t.Fatalf("重放不该写第二条审计，实际 %d", h.audit.count())
	}
	if h.queue.count() != 1 {
		t.Fatalf("重放不该再入队，实际 %d", h.queue.count())
	}
}

func TestVerifyRescoreWritesSecondAudit(t *testing.T) {
	h := newHarness(t)
	pid, _ := h.donation(h.alice, h.bob, 300, reward.StatePending)
	svc := h.svc()
	if _, err := svc.Verify(h.ctx, h.adminActor(), pid, reward.VerifyInput{State: reward.StateApproved}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Verify(h.ctx, h.adminActor(), pid, reward.VerifyInput{State: reward.StateRejected}); err != nil {
		t.Fatalf("改判必须成功，实际 %v", err)
	}
	if h.audit.count() != 2 {
		t.Fatalf("改判应写第二条审计，实际 %d", h.audit.count())
	}
	last := h.audit.last()
	before, _ := last.Detail["before"].(map[string]any)
	if before["state"] != reward.StateApproved {
		t.Fatalf("第二条审计的 before 必须是 approved，实际 %+v", last.Detail)
	}
}

func TestVerifyWithdrawnIsInvalidTransition(t *testing.T) {
	h := newHarness(t)
	pid, _ := h.donation(h.alice, h.bob, 100, reward.StateWithdrawn)
	_, err := h.svc().Verify(h.ctx, h.adminActor(), pid, reward.VerifyInput{State: reward.StateApproved})
	if code(t, err) != "reward.invalid_transition" {
		t.Fatalf("核验已撤回必须 409 invalid_transition，实际 %v", err)
	}
}

func TestVerifyConcurrentSameTarget(t *testing.T) {
	h := newHarness(t)
	pid, _ := h.donation(h.alice, h.bob, 100, reward.StatePending)
	svc := h.svc()

	var wg sync.WaitGroup
	codes := make([]string, 2)
	for i := range codes {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, err := svc.Verify(h.ctx, h.adminActor(), pid, reward.VerifyInput{State: reward.StateApproved})
			if err != nil {
				codes[i] = code(t, err)
			}
		}(i)
	}
	wg.Wait()

	ok, conflict := 0, 0
	for _, c := range codes {
		switch c {
		case "":
			ok++
		case "reward.already_handled":
			conflict++
		default:
			t.Fatalf("并发核验出现意外结果: %s", c)
		}
	}
	if ok != 1 || conflict != 1 {
		t.Fatalf("并发同态核验必须一个成功一个 409，实际 ok=%d conflict=%d", ok, conflict)
	}
	if h.audit.count() != 1 {
		t.Fatalf("并发核验的审计必须恰好一条，实际 %d", h.audit.count())
	}
	if got := h.scalar("SELECT count(*) FROM donation_records WHERE state = 'approved'"); got != 1 {
		t.Fatalf("状态必须恰好是目标态，实际 approved 行数 %d", got)
	}
}

// ---- 批量 ----

func TestVerifyBatchPartialSuccess(t *testing.T) {
	h := newHarness(t)
	ids := make([]string, 0, 4)
	rows := make([]int64, 0, 4)
	for i := 0; i < 4; i++ {
		pid, id := h.donation(h.alice, h.bob, int64(100+i), reward.StatePending)
		ids = append(ids, pid)
		rows = append(rows, id)
	}
	// 第五条已经是 approved：逐条结果里它应当是 already_handled
	donePID, _ := h.donation(h.bob, h.alice, 999, reward.StateApproved)
	ids = append(ids, donePID)

	out, err := h.svc().VerifyBatch(h.ctx, h.adminActor(), reward.BatchVerifyInput{IDs: ids, State: reward.StateApproved})
	if err != nil {
		t.Fatalf("批量核验: %v", err)
	}
	if len(out.Results) != 5 {
		t.Fatalf("逐条结果必须 5 项，实际 %d", len(out.Results))
	}
	okN, failN := 0, 0
	for _, r := range out.Results {
		if r.OK {
			okN++
		} else {
			failN++
			if r.Code != "reward.already_handled" {
				t.Fatalf("失败项的错误码应为 already_handled，实际 %s", r.Code)
			}
		}
	}
	if okN != 4 || failN != 1 {
		t.Fatalf("应为 4 成功 1 失败，实际 %d/%d", okN, failN)
	}
	for _, id := range rows {
		if h.state(id) != reward.StateApproved {
			t.Fatalf("成功项必须落成 approved，实际 %s", h.state(id))
		}
	}
	if h.audit.count() != 4 || h.queue.count() != 4 {
		t.Fatalf("审计与任务应各 4 条，实际 %d/%d", h.audit.count(), h.queue.count())
	}
}

func TestVerifyBatchRollsBackOnQueueFailure(t *testing.T) {
	h := newHarness(t)
	ids := make([]string, 0, 3)
	rows := make([]int64, 0, 3)
	for i := 0; i < 3; i++ {
		pid, id := h.donation(h.alice, h.bob, 100, reward.StatePending)
		ids = append(ids, pid)
		rows = append(rows, id)
	}
	_, err := h.svcFailingQueue().VerifyBatch(h.ctx, h.adminActor(), reward.BatchVerifyInput{IDs: ids, State: reward.StateApproved})
	if err == nil {
		t.Fatal("入队失败必须让整批报错")
	}
	for _, id := range rows {
		if h.state(id) != reward.StatePending {
			t.Fatalf("整批必须回滚，行 %d 实际 %s", id, h.state(id))
		}
	}
	if n := h.scalar("SELECT count(*) FROM donation_records WHERE verified_by IS NOT NULL"); n != 0 {
		t.Fatalf("回滚后不该留下核验人，实际 %d 行", n)
	}
}

// ---- 权限 ----

func TestVerifyRequiresPerm(t *testing.T) {
	h := newHarness(t)
	pid, id := h.donation(h.alice, h.bob, 100, reward.StatePending)
	svc := h.svc()

	if _, err := svc.Verify(h.ctx, h.actor(h.alice), pid, reward.VerifyInput{State: reward.StateApproved}); code(t, err) != apperr.CodeForbidden {
		t.Fatalf("无 reward.verify 必须 403，实际 %v", err)
	}
	// 有别的权限点但没这个：也不能过（权限点不串）
	if _, err := svc.Verify(h.ctx, h.actor(h.alice, authz.PermReportHandle), pid, reward.VerifyInput{State: reward.StateApproved}); code(t, err) != apperr.CodeForbidden {
		t.Fatalf("持别的权限点必须 403，实际 %v", err)
	}
	if _, err := svc.Verify(h.ctx, nil, pid, reward.VerifyInput{State: reward.StateApproved}); code(t, err) != apperr.CodeUnauthorized {
		t.Fatalf("nil actor 必须 401，实际 %v", err)
	}
	if _, err := svc.ListQueue(h.ctx, h.actor(h.alice), reward.QueueInput{}); code(t, err) != apperr.CodeForbidden {
		t.Fatalf("普通用户读队列必须 403，实际 %v", err)
	}
	if _, err := svc.Stats(h.ctx, h.actor(h.alice), reward.StatsInput{}); code(t, err) != apperr.CodeForbidden {
		t.Fatalf("普通用户读统计必须 403，实际 %v", err)
	}
	if _, err := svc.UpdateNoticeDefaults(h.ctx, h.actor(h.alice), reward.NoticeDefaultsInput{}); code(t, err) != apperr.CodeForbidden {
		t.Fatalf("普通用户改默认文案必须 403，实际 %v", err)
	}
	if h.state(id) != reward.StatePending {
		t.Fatal("被拒的核验不该改动数据")
	}
}

func TestSuperAdminBypassesPerm(t *testing.T) {
	h := newHarness(t)
	pid, _ := h.donation(h.alice, h.bob, 100, reward.StatePending)
	super := &authz.Actor{UserID: h.admin.ID, IsSuper: true, Status: "active"}
	if _, err := h.svc().Verify(h.ctx, super, pid, reward.VerifyInput{State: reward.StateApproved}); err != nil {
		t.Fatalf("超管必须能核验，实际 %v", err)
	}
}

// ---- 收款码与公开记录 ----

func TestChannelsRespectsSwitch(t *testing.T) {
	h := newHarness(t)
	h.newChannel(h.bob, "微信")
	svc := h.svc()

	got, err := svc.Channels(h.ctx, nil, "bob")
	if err != nil {
		t.Fatalf("游客读收款码: %v", err)
	}
	if got == nil || len(got) != 0 {
		t.Fatalf("默认关必须返回空数组（不是 null），实际 %#v", got)
	}

	h.setUser(h.bob, true, false)
	got, err = svc.Channels(h.ctx, nil, "bob")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Label != "微信" || !strings.HasPrefix(got[0].Image, "/img/") {
		t.Fatalf("开的用户应看到收款码，实际 %+v", got)
	}
	if _, err := uuid.Parse(got[0].ID); err != nil {
		t.Fatalf("收款码 id 必须是对外 uuid，不是自增 id: %q", got[0].ID)
	}
}

func TestChannelsNotFoundForBannedUser(t *testing.T) {
	h := newHarness(t)
	h.setUser(h.bob, true, false)
	b := h.users.byID[h.bob.ID]
	b.Status = "banned"
	h.users.byID[h.bob.ID] = b
	_, err := h.svc().Channels(h.ctx, nil, "bob")
	if code(t, err) != apperr.CodeNotFound {
		t.Fatalf("封号用户必须 404，实际 %v", err)
	}
}

func TestUserDonationsOnlyPublic(t *testing.T) {
	h := newHarness(t)
	h.setUser(h.bob, true, false) // 收款人开、打赏人 alice 关 → 私有
	h.donation(h.alice, h.bob, 100, reward.StateApproved)
	h.donation(h.alice, h.bob, 200, reward.StatePending)
	svc := h.svc()

	page, err := svc.ListUserDonations(h.ctx, nil, reward.UserDonationsInput{Handle: "bob"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 0 {
		t.Fatalf("打赏人没公开就该看不到，实际 %d 条", len(page.Items))
	}

	// 两个开关都开 → 只看到 approved
	h.setUser(h.alice, false, true)
	h.setUser(h.bob, true, false)
	h.setUser(h.admin, false, true)
	h.donation(h.admin, h.bob, 300, reward.StateApproved)
	page, err = svc.ListUserDonations(h.ctx, nil, reward.UserDonationsInput{Handle: "bob"})
	if err != nil {
		t.Fatal(err)
	}
	// alice 与 admin 都公开且 approved → 两条；pending 那条与不公开的那些都不出现
	if len(page.Items) != 2 {
		t.Fatalf("只应返回双方都公开的 approved，实际 %d 条: %+v", len(page.Items), page.Items)
	}
}

func TestMyDonationsCursorPaging(t *testing.T) {
	h := newHarness(t)
	for i := 0; i < 25; i++ {
		h.donation(h.alice, h.bob, int64(i+1), reward.StatePending)
	}
	svc := h.svc()
	seen := map[string]bool{}
	page, err := svc.ListMyDonations(h.ctx, h.actor(h.alice), reward.CursorInput{Limit: 21})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 21 || page.NextCursor == "" {
		t.Fatalf("第一页应 21 条且带游标，实际 %d / %q", len(page.Items), page.NextCursor)
	}
	for _, it := range page.Items {
		seen[it.ID] = true
	}
	next, err := svc.ListMyDonations(h.ctx, h.actor(h.alice), reward.CursorInput{Limit: 21, Cursor: page.NextCursor})
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Items) != 4 || next.NextCursor != "" {
		t.Fatalf("第二页应 4 条且无游标，实际 %d / %q", len(next.Items), next.NextCursor)
	}
	for _, it := range next.Items {
		if seen[it.ID] {
			t.Fatalf("两页不该有重复行: %s", it.ID)
		}
	}
	if _, err := svc.ListMyDonations(h.ctx, h.actor(h.alice), reward.CursorInput{Cursor: "!!!not-base64!!!"}); code(t, err) != apperr.CodeInvalidInput {
		t.Fatalf("坏游标必须 400，实际 %v", err)
	}
}

func TestListQueueFiltersState(t *testing.T) {
	h := newHarness(t)
	h.donation(h.alice, h.bob, 100, reward.StatePending)
	h.donation(h.alice, h.bob, 200, reward.StateApproved)
	page, err := h.svc().ListQueue(h.ctx, h.adminActor(), reward.QueueInput{State: reward.StatePending})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].State != reward.StatePending {
		t.Fatalf("队列按 state 过滤失败: %+v", page.Items)
	}
}

// ---- 设置与默认文案 ----

func TestSettingsDefaultsAndPatch(t *testing.T) {
	h := newHarness(t)
	svc := h.svc()

	got, err := svc.GetMySettings(h.ctx, h.actor(h.alice))
	if err != nil {
		t.Fatal(err)
	}
	if got.ShowChannels || got.RecordsPublic || !got.NoticeVisible || got.NoticeText != "" {
		t.Fatalf("默认值不对: %+v", got)
	}

	yes := true
	got, err = svc.UpdateMySettings(h.ctx, h.actor(h.alice), reward.UpdateDonationSettingsInput{ShowChannels: &yes})
	if err != nil {
		t.Fatal(err)
	}
	if !got.ShowChannels || got.RecordsPublic || !got.NoticeVisible {
		t.Fatalf("部分更新只该改传进来的字段: %+v", got)
	}
	text := "谢谢"
	got, err = svc.UpdateMySettings(h.ctx, h.actor(h.alice), reward.UpdateDonationSettingsInput{NoticeText: &text})
	if err != nil {
		t.Fatal(err)
	}
	if got.NoticeText != "谢谢" || !got.ShowChannels {
		t.Fatalf("第二次更新不该回退第一个开关: %+v", got)
	}
	if h.scalar("SELECT count(*) FROM user_donation_settings") != 1 {
		t.Fatal("同一人只该有一行设置")
	}
}

func TestNoticeDefaultsReplaceWholeTable(t *testing.T) {
	h := newHarness(t)
	admin := h.actor(h.admin, authz.PermSiteSetting)
	svc := h.svc()

	out, err := svc.UpdateNoticeDefaults(h.ctx, admin, reward.NoticeDefaultsInput{Items: []reward.NoticeDefaultInput{
		{Channel: "default", Text: "默认"},
		{Channel: "wechat", Text: "微信"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 {
		t.Fatalf("应写入两条，实际 %d", len(out))
	}
	out, err = svc.UpdateNoticeDefaults(h.ctx, admin, reward.NoticeDefaultsInput{Items: []reward.NoticeDefaultInput{
		{Channel: "alipay", Text: "支付宝"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 1 || out[0].Channel != "alipay" {
		t.Fatalf("整表替换后只该剩一条 alipay，实际 %+v", out)
	}
	if h.scalar("SELECT count(*) FROM donation_notice_defaults") != 1 {
		t.Fatal("整表替换必须真的删掉旧行")
	}
}

// ---- 统计 ----

func TestStatsTwoScopes(t *testing.T) {
	h := newHarness(t)
	h.setUser(h.bob, true, false)
	h.setUser(h.alice, false, true)
	h.donation(h.alice, h.bob, 100, reward.StateApproved)
	h.donation(h.alice, h.bob, 200, reward.StatePending)
	// 第三人给 bob 打赏但不公开 → 不进 public 口径
	h.donation(h.admin, h.bob, 400, reward.StateApproved)

	out, err := h.svc().Stats(h.ctx, h.adminActor(), reward.StatsInput{})
	if err != nil {
		t.Fatal(err)
	}
	if out.AllTotalCents != 500 || out.AllCount != 2 {
		t.Fatalf("全部口径应为 500/2，实际 %d/%d", out.AllTotalCents, out.AllCount)
	}
	if out.PublicTotalCents != 100 || out.PublicCount != 1 {
		t.Fatalf("公开口径应为 100/1，实际 %d/%d", out.PublicTotalCents, out.PublicCount)
	}
	if len(out.Leaderboard) != 1 || out.Leaderboard[0].User.Handle != "bob" || out.Leaderboard[0].TotalCents != 100 {
		t.Fatalf("排行榜不对: %+v", out.Leaderboard)
	}
}

// itoa 只在测试里用，省得为一行引入 strconv。
func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

var _ = queue.TypeNotifyReward
