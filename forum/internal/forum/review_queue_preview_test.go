package forum

import (
	"strings"
	"testing"
	"time"

	"forum/internal/authz"
	"forum/internal/forum/pgsql"
)

// D25① 审核屏的**就地预览**：被审内容要能在队列里读到 —— 标题、正文全文、作者、来源四样齐。
//
// 旧行为下这条用例必红在第一句上：队列只带 topics.excerpt（clipExcerpt 到 200 字），
// 审核员面对一篇正文上千字的帖子只能看到开头一句，剩下全靠猜。
//
// 另有一条**产品事实**钉在这里：正文里的图片是 Markdown 字面量（`![封面](/img/<hash>)`），
// 图片字节既不上行给模型（aireview 的 TestOutboundPayloadHasNoImageField）也不在本 DTO 里，
// 所以审核员看到的是「有一张图」这件事，不是图本身。预览必须让这件事一眼可见。
func TestReviewQueueCarriesBodyForPreview(t *testing.T) {
	h := newHarness(t)
	h.clk.T = time.Now().UTC() // 队列游标吃时钟（陷阱 §5）
	// trusted=false 的作者发的帖才留在 pending；带 post.review 的作者会直接过审。
	author, _ := h.author("alice", 1, false, authz.PermTopicCreate)
	h.seedBoard("general", 0, false)

	// 正文远超 200 字的摘要，且带一张图：摘要看不全、图也不在 DTO 里 —— 两样都要能测出来。
	body := "开头一句。" + strings.Repeat("正文段落，很长。", 160) + "\n\n![封面](/img/0123456789abcdef)\n\n结尾。"
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "带图的长帖", ContentMD: body})
	if len([]rune(d.Excerpt)) >= len([]rune(body)) {
		t.Fatalf("前提不成立：excerpt 没有被截断（%d 字 vs 正文 %d 字）", len([]rune(d.Excerpt)), len([]rune(body)))
	}

	reviewer, _ := h.author("mod", 1, false, authz.PermTopicCreate, authz.PermPostReview)
	page, err := h.svc.ListReviewQueue(h.ctx, reviewer, ReviewQueueInput{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("队列应当有且只有这一条，实际 %d 条", len(page.Items))
	}
	got := page.Items[0]

	// ① 正文**全文**（不是摘要）：一个字都不许少
	if got.BodyMD != body {
		t.Fatalf("预览正文应当是 1 楼全文：得到 %d 字，原文 %d 字", len([]rune(got.BodyMD)), len([]rune(body)))
	}
	if got.BodyTruncated {
		t.Fatal("正文没过上限，不该说被截断")
	}
	// ② 图片只是 Markdown 字面量 —— 这是「有图」唯一的可见证据
	if !strings.Contains(got.BodyMD, "![封面](/img/0123456789abcdef)") {
		t.Fatal("正文里的图片 Markdown 没进预览")
	}
	// ③ 作者与来源（标题就是 got.Title）
	if got.Author.Handle != "alice" || got.Title != "带图的长帖" || got.Board.Name == "" {
		t.Fatalf("预览四样里缺东西：title=%q author=%q board=%q", got.Title, got.Author.Handle, got.Board.Name)
	}
}

// 草稿档（已发布 + 有改动等着替换上线）要预览**作者那一版**，不是线上旧版：
// 这一档判的就是「这份改动替不替换上线」，给线上那一份等于让审核员看错那一份。
func TestReviewQueueDraftPreviewShowsPendingVersion(t *testing.T) {
	h := newHarness(t)
	h.clk.T = time.Now().UTC()
	author, _ := h.author("alice", 5, true, authz.PermTopicCreate, authz.PermTopicEditOwn)
	h.seedBoard("general", 0, false)
	d := h.mustTopic(author, CreateTopicInput{BoardSlug: "general", Title: "教程", ContentMD: "V1 线上版"})

	if err := h.svc.UpdateTopic(h.ctx, author, d.ID, UpdateTopicInput{ContentMD: ptrStr("V2 待审改动")}); err != nil {
		t.Fatal(err)
	}
	if got := h.postMD(t, d.ID); got != "V1 线上版" {
		t.Fatalf("前提不成立：线上版应当是 V1，实际 %q", got)
	}

	reviewer, _ := h.author("mod", 5, true, authz.PermTopicCreate, authz.PermPostReview)
	page, err := h.svc.ListReviewQueue(h.ctx, reviewer, ReviewQueueInput{State: ReviewQueueDraft})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 {
		t.Fatalf("草稿档应当有 1 条，实际 %d 条", len(page.Items))
	}
	if page.Items[0].BodyMD != "V2 待审改动" {
		t.Fatalf("草稿档预览的是 %q，要作者那一版（V2 待审改动）", page.Items[0].BodyMD)
	}
}

// 上限那一档走**映射层单测**，不用真库：上限就是发帖上限（MaxTopicContent），
// 正常路径到不了，所以它只能直接喂一个超长的行来证明「切了必须说出来」。
func TestReviewQueueBodyOverCapIsFlaggedNotSilentlyCut(t *testing.T) {
	long := strings.Repeat("很", MaxTopicContent+50)
	got := reviewQueueItemDTO(pgsql.ReviewQueueRow{
		PublicID: "p", Title: "超长帖", Excerpt: "摘要", BodyMD: long, ReviewState: "pending",
	})
	if !got.BodyTruncated {
		t.Fatal("正文超过上限却没打截断标记：屏幕会把半篇当全文显示")
	}
	if n := len([]rune(got.BodyMD)); n != MaxTopicContent {
		t.Fatalf("截断后的长度 = %d，想要 %d", n, MaxTopicContent)
	}
	if got.Excerpt != "摘要" {
		t.Fatalf("摘要不该因为有了全文就消失（列表行要梗概），实际 %q", got.Excerpt)
	}
}
