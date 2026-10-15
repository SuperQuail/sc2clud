package aireview

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"

	"forum/internal/platform/ai"
	"forum/internal/platform/apperr"
	"forum/internal/platform/image/imgsize"
)

// D34（2026-10-15）：测试样例可自配图片。multipart 上来的 probe 文本 + 0..N 张样例图
// 只活在这一条请求里 —— 不写 topic_images、不留文件、不写 review_events、不改配额，
// 与 TestTopic「一个字不落库」同语义。上限与记账沿用带帖路径**同一份**（images.go 的
// maxImages / maxImageBytes 与 imagePayload）：分散实现 = 干跑里看到的图与真发出去的会漂。

// readErr 把部件读失败翻成对外的码：**超限是 413（ErrTooLarge）**，不是一句含糊的 400 ——
// MaxBytesReader 的错被 io.ReadAll 原样带回来，用它区分「图片真坏了」与「配额掐了流」。
func readErr(err error, msg string) *apperr.Error {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return apperr.ErrTooLarge
	}
	return apperr.Invalid(map[string]string{"_": msg})
}

// formProbe / formFile 是 multipart 的字段名（前端 lib/api/admin 的 FormData 同名绑定）。
const (
	formProbe = "probe"
	formFile  = "file"
)

// ProbeImage 是 multipart 上来的一张样例图。Name 只是回执里的来历说明，
// 嗅探看的是字节（imgsize 的铁律：不认 Content-Type / 扩展名 / 文件名）。
type ProbeImage struct {
	Name  string
	Bytes []byte
}

// readProbeMultipart 把 multipart 请求体读成 probe 文本 + 样例图切片。
// 字节全部进内存（上限单张 2 MiB × 4 张 ≈ 10.7 MiB，d5 §3.1 的同款边界），
// 所以不走 c.MultipartForm() 的临时落盘路径 —— 那会把大文件写到磁盘上，与「只在内存里走」相反。
func readProbeMultipart(r *http.Request) (probe string, files []ProbeImage, err error) {
	mr, err := r.MultipartReader()
	if err != nil {
		return "", nil, apperr.Invalid(map[string]string{"_": "multipart 请求体解析失败（缺 boundary 或不是合法的分隔表单）"})
	}
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			return probe, files, nil
		}
		if err != nil {
			return "", nil, apperr.Invalid(map[string]string{"_": "multipart 请求体读坏了"})
		}
		switch part.FormName() {
		case formProbe:
			b, err := io.ReadAll(part)
			if err != nil {
				return "", nil, readErr(err, "样例文本读不出来")
			}
			probe = string(b)
		case formFile:
			data, err := io.ReadAll(part)
			if err != nil {
				return "", nil, readErr(err, "样例图片读不出来")
			}
			name := ""
			if fn := part.FileName(); fn != "" {
				name = filepath.Base(fn) // 浏览器可能带路径，回执里只留文件名
			}
			files = append(files, ProbeImage{Name: name, Bytes: data})
		default:
			_, _ = io.Copy(io.Discard, part) // 未知字段读完即丢：解析器要走到下一个部件
		}
		_ = part.Close()
	}
}

// probeImages 给样例图记「这一次的下场」：嗅探（imgsize，判字节）→ 应用与带帖路径
// 同一套上限（maxImages / maxImageBytes）。没发的每一张 note 非空，不许静默丢。
//
// 与 loadImages 的差别只有一处，是有意的：样例不是帖子里的图，没有「转人工」的概念 ——
// 没发成的那张只影响它自己，判定照常发（ReadFailed 恒 false）。
func probeImages(files []ProbeImage) *imagePayload {
	out := &imagePayload{}
	for i, f := range files {
		fact := imageFact{Position: i, Hash: f.Name, Bytes: len(f.Bytes)}
		head := f.Bytes
		if len(head) > 512 {
			head = head[:512]
		}
		mime, ok := imgsize.Sniff(head)
		switch {
		case !ok:
			fact.Note = "不是图片（样例图只接受 PNG / JPEG / GIF / WebP）"
		case len(out.Attachments) >= maxImages:
			fact.Note = "超过 " + itoa(maxImages) + " 张上限，这一张没发"
		case len(f.Bytes) > maxImageBytes:
			fact.Note = fmt.Sprintf("单张 %.1f MB 超过上限 %.1f MB，这一张没发",
				float64(len(f.Bytes))/(1<<20), float64(maxImageBytes)/(1<<20))
		default:
			fact.Sent, fact.MIME = true, mime
			out.Attachments = append(out.Attachments, ai.Attachment{MIME: mime, Data: f.Bytes})
			out.Bytes += len(f.Bytes)
		}
		out.Facts = append(out.Facts, fact)
	}
	return out
}
