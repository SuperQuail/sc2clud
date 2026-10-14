package user

import (
	"strconv"
	"testing"

	"forum/internal/platform/mention"
)

// 「@ 提及候选」（拍板 08 §第三轮 4）的**契约**判据：候选行里的 id 必须是**数字 user id**。
//
// 为什么这条要单独立一个用例：提及的存储格式是 `[@昵称](mention:<user_id>)`，
// 而 platform/mention 的 BodyRe 只收 \d{1,18}（`mention:abc` 会被 Parse 直接跳过，
// markdown 那一步也拿它换不出 `/u/<id>`）。候选行原先回的是 **public_id（uuid）**，
// 于是「从候选里选一个人」插进正文的是 `mention:<uuid>` —— 存得下、渲染不出来、
// 通知也发不出去，而两端的测试各看各的，都不会红（交接单 §5.1 那一族）。
//
// 判据写成「拿候选的 ID 生成一条提及，再交给 mention.Parse 取回来」——
// 直接断言 wantID 只能证明这一行对，证明不了**这条 ID 真的能用在提及里**。
func TestSearchCandidatesCarryNumericMentionID(t *testing.T) {
	f := newFixture(t)
	wantID := f.insertUser("tangtian", "唐天", "active", 0)

	items, err := f.svc.Search(f.ctx, "tang", 10)
	if err != nil {
		t.Fatalf("搜索失败: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("候选数 = %d，想要 1", len(items))
	}
	if items[0].ID != wantID {
		t.Fatalf("候选 id = %v，想要**数字** user id %d（public_id 填进 mention: 渲染不出来）", items[0].ID, wantID)
	}

	// 端到端：用这一行拼出正文里那种提及，Parse 必须认得出来。
	md := "[@" + items[0].Nickname + "](mention:" + strconv.FormatInt(items[0].ID, 10) + ")"
	ids := mention.Parse(md)
	if len(ids) != 1 || ids[0] != wantID {
		t.Fatalf("mention.Parse(%q) = %v，想要 [%d] —— 候选的 id 必须能直接用在提及里", md, ids, wantID)
	}
}
