package aireview_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"forum/internal/aireview"
)

// D34（2026-10-15 用户实测「测试样例无法自己配置图片，无法带图测试」）：
// /admin/ai/test 与 /admin/ai/payload 接受 multipart（probe 文本 + 0..4 张 file 部件），
// 图片**只在内存里走**（不写 topic_images、不留文件、不写 review_events、不改配额）——
// 上限/记账沿用带帖路径同一套常量（aireview/images.go 的 maxImages / maxImageBytes），
// 没发的每张 images[i].note 非空，不许静默丢。**旧 JSON 路径一字不改**（本文件不锁它，
// preview_test.go 与 aireview_test.go 的既有用例原样绿就是它的护栏）。
//
// 先红：handler 只绑 JSON 时，multipart 打进来的是 400 —— 下面的 code==200 断言全会红。

// pngSample 合成一张**真 PNG**（有魔数 + IHDR）：imgsize.Sniff 的判据是字节，不是扩展名。
func pngSample() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 8, 8))
	for x := 0; x < 8; x++ {
		for y := 0; y < 8; y++ {
			img.Set(x, y, color.RGBA{R: uint8(x * 31), G: uint8(y * 31), B: 255, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

// textFile 就是一段文本字节：嗅探不认 —— 回执必须给出「不是图片」的 note。
func textFile() []byte {
	return []byte("这只是个文本文件的内容，不是任何图片格式。")
}

type probeFile struct {
	name string
	data []byte
}

// postMultipart 手拼一个 multipart 请求（probe 文本字段 + 任意条 file 部件），收状态码与包络。
func postMultipart(t *testing.T, r *gin.Engine, path, probe string, files []probeFile) (int, map[string]any) {
	t.Helper()
	body := &bytes.Buffer{}
	w := multipart.NewWriter(body)
	if err := w.WriteField("probe", probe); err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		fw, err := w.CreateFormFile("file", f.name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fw.Write(f.data); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, path, body)
	req.Header.Set("Content-Type", w.FormDataContentType())
	req.Header.Set("X-Test-Actor", "1")
	req.Header.Set("X-Test-Perm", "site.setting")
	wr := httptest.NewRecorder()
	r.ServeHTTP(wr, req)
	var out map[string]any
	if wr.Body.Len() > 0 {
		if err := json.Unmarshal(wr.Body.Bytes(), &out); err != nil {
			t.Fatalf("回执不是 JSON（%d）: %s", wr.Code, wr.Body.String())
		}
	}
	return wr.Code, out
}

// mustList 拿回执里的 images 数组（断言失败直接 Fatal，错误信息可读）。
func mustList(t *testing.T, out map[string]any) []map[string]any {
	t.Helper()
	data, _ := out["data"].(map[string]any)
	if data == nil {
		t.Fatalf("回执没有 data 包络: %v", out)
	}
	raw, _ := data["images"].([]any)
	if raw == nil {
		t.Fatalf("回执没有 images：probe 带图时必须有逐张记账: %v", data)
	}
	imgs := make([]map[string]any, 0, len(raw))
	for _, r := range raw {
		row, _ := r.(map[string]any)
		imgs = append(imgs, row)
	}
	return imgs
}

func dataOf(t *testing.T, out map[string]any) map[string]any {
	t.Helper()
	data, _ := out["data"].(map[string]any)
	if data == nil {
		t.Fatalf("回执没有 data 包络: %v", out)
	}
	return data
}

// ① multipart 1 图：回执 images[0].sent=true，外呼口收到同一块原样字节。
func TestTestEndpointMultipartCarriesSampleImage(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	r := newTestEngine(h)

	img := pngSample()
	code, out := postMultipart(t, r, "/api/v1/admin/ai/test", "标题：自定义样例附一张图", []probeFile{{name: "样例一.png", data: img}})
	if code != http.StatusOK {
		t.Fatalf("multipart 该 200（先红时这里是 绑定 JSON 失败的 400），实际 %d %v", code, out)
	}
	if h.judge.text != "标题：自定义样例附一张图" {
		t.Fatalf("probe 字段没生效，发出去的是 %q", h.judge.text)
	}
	if len(h.judge.images) != 1 {
		t.Fatalf("该附 1 张图给外呼口，实际 %d 张", len(h.judge.images))
	}
	if !bytes.Equal(h.judge.images[0].Data, img) || h.judge.images[0].MIME != "image/png" {
		t.Fatalf("上行字节与 multipart 里的那一份不符: mime=%q bytes=%d", h.judge.images[0].MIME, len(h.judge.images[0].Data))
	}

	imgs := mustList(t, out)
	if len(imgs) != 1 {
		t.Fatalf("回执该记账 1 张，实际 %d", len(imgs))
	}
	if imgs[0]["sent"] != true {
		t.Fatalf("images[0].sent 该是 true: %v", imgs[0])
	}
	if imgs[0]["mime"] != "image/png" || int(imgs[0]["bytes"].(float64)) != len(img) {
		t.Fatalf("images[0] 的 mime/bytes 不对: %v", imgs[0])
	}
	if n, _ := imgs[0]["note"].(string); n != "" {
		t.Fatalf("发出去的那张 note 该为空: %v", imgs[0])
	}
	data := dataOf(t, out)
	if data["image_count"] != float64(1) || data["image_skipped"] != float64(0) {
		t.Fatalf("image_count/skipped 与带帖路径同语义：实际 %v / %v", data["image_count"], data["image_skipped"])
	}
	if data["topic_id"] != float64(0) {
		t.Fatalf("样例那一路没有帖子，topic_id 该是 0: %v", data)
	}
}

// ② 上限截断：6 张发 4 张、记 2 张 —— 回执的 note 必须说出原因，不许静默丢。
func TestTestEndpointMultipartTruncatesAtLimit(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	r := newTestEngine(h)

	files := make([]probeFile, 0, 6)
	for i := 0; i < 6; i++ {
		files = append(files, probeFile{name: fmt.Sprintf("图%d.png", i+1), data: pngSample()})
	}
	code, out := postMultipart(t, r, "/api/v1/admin/ai/test", "", files)
	if code != http.StatusOK {
		t.Fatalf("multipart 该 200，实际 %d %v", code, out)
	}
	if len(h.judge.images) != 4 {
		t.Fatalf("该只附 4 张（上限 4），实际 %d", len(h.judge.images))
	}
	imgs := mustList(t, out)
	if len(imgs) != 6 {
		t.Fatalf("6 张都要在回执里逐张记账，实际 %d", len(imgs))
	}
	sent, skipped := 0, 0
	for i, row := range imgs {
		if row["sent"] == true {
			sent++
			continue
		}
		skipped++
		if note, _ := row["note"].(string); !strings.Contains(note, "超过 4 张上限") {
			t.Fatalf("第 %d 张没发的 note 该说明「超过 4 张上限」，实际 %q", i+1, note)
		}
	}
	if sent != 4 || skipped != 2 {
		t.Fatalf("该是 发 4 / 截 2，实际 %d / %d", sent, skipped)
	}
	data := dataOf(t, out)
	if data["image_count"] != float64(4) || data["image_skipped"] != float64(2) {
		t.Fatalf("计数该与带帖路径一致（4 / 2），实际 %v / %v", data["image_count"], data["image_skipped"])
	}
	// 空 probe = 默认样例（与 JSON 路径同一条 probeText 口）
	if h.judge.text != aireview.DefaultProbeSample {
		t.Fatalf("空 probe 该发默认样例，实际 %q", h.judge.text)
	}
}

// ③ 非图片与单张超上限：**不是**违规、也**不让判定失败**（样例没有「转人工」概念），
// 每张的下场都在回执里说清 —— 嗅探是字节的判据（imgsize 与 media 同一个）。
func TestTestEndpointMultipartRejectsNonImageAndOversize(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	r := newTestEngine(h)

	// 3.1 MB（3.1 × 1048576 = 3250586 字节）：超过单张上限 2.0 MB
	oversize := append(append([]byte(nil), pngSample()...), bytes.Repeat([]byte{0x00}, 3_250_586-len(pngSample()))...)
	code, out := postMultipart(t, r, "/api/v1/admin/ai/test", "带一张超大图",
		[]probeFile{{name: "说明.txt", data: textFile()}, {name: "超大的.png", data: oversize}})
	if code != http.StatusOK {
		t.Fatalf("multipart 该 200（没发成的那张只是记账，不是错误），实际 %d %v", code, out)
	}
	if len(h.judge.images) != 0 {
		t.Fatalf("两张都该没发，实际外呼口收到 %d 张", len(h.judge.images))
	}
	imgs := mustList(t, out)
	if note, _ := imgs[0]["note"].(string); !strings.Contains(note, "不是图片") {
		t.Fatalf("文本文件的 note 该说明「不是图片」，实际 %q", note)
	}
	if imgs[0]["sent"] != false {
		t.Fatalf("不是图片的那张 sent 该是 false: %v", imgs[0])
	}
	if note, _ := imgs[1]["note"].(string); !strings.Contains(note, "单张 3.1 MB 超过上限 2.0 MB") {
		t.Fatalf("超大图的 note 该带上体积数字，实际 %q", note)
	}
	data := dataOf(t, out)
	if data["image_count"] != float64(0) || data["image_skipped"] != float64(2) {
		t.Fatalf("计数该是 0 / 2，实际 %v / %v", data["image_count"], data["image_skipped"])
	}
	// 判定照常出结果（两张都没发 ≠ 失败）：不把「没图可发」当成一次故障
	if h.judge.calls != 1 {
		t.Fatalf("没发图的样例照样判定，实际外呼 %d 次", h.judge.calls)
	}
}

// ④ payload（dry-run）：multipart 2 图 → 回执里逐张下场 + 计数 + 词表，**一次外呼都不发**。
func TestPayloadEndpointMultipartDryRunCarriesTwoImages(t *testing.T) {
	h := newHarness(t)
	h.putKey()
	r := newTestEngine(h)

	code, out := postMultipart(t, r, "/api/v1/admin/ai/payload", "标题：干跑样例",
		[]probeFile{{name: "其一.png", data: pngSample()}, {name: "其二.png", data: pngSample()}})
	if code != http.StatusOK {
		t.Fatalf("payload multipart 该 200，实际 %d %v", code, out)
	}
	data := dataOf(t, out)
	if data["source"] != "probe" {
		t.Fatalf("样例那一路 source=probe，实际 %v", data["source"])
	}
	imgs := mustList(t, out)
	if len(imgs) != 2 {
		t.Fatalf("payload 该回 2 张图，实际 %d", len(imgs))
	}
	for i, row := range imgs {
		if row["sent"] != true {
			t.Fatalf("第 %d 张该发出去，实际 %v", i+1, row)
		}
	}
	if data["image_count"] != float64(2) || data["image_skipped"] != float64(0) {
		t.Fatalf("干跑计数不对: %v / %v", data["image_count"], data["image_skipped"])
	}
	if data["image_limit"] != float64(4) || data["image_max_bytes"] != float64(2<<20) {
		t.Fatalf("上限该照 images.go 的常量给，实际 %v", data)
	}
	if b, _ := data["image_bytes"].(float64); b <= 0 {
		t.Fatalf("发出去的字节合计该大于 0，实际 %v", data["image_bytes"])
	}
	if h.judge.calls != 0 {
		t.Fatalf("payload 是 dry-run，一次外呼都不该发，实际 %d 次", h.judge.calls)
	}
	if data["tool_name"] != "submit_review" {
		t.Fatalf("tool_name=%v", data["tool_name"])
	}
}
