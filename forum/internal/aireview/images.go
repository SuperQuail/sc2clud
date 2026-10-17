package aireview

import (
	"context"
	"time"

	"forum/internal/platform/ai"
)

// 配图上行（D33③，2026-10-15 用户拍板）的全部决定都在这个文件里：发几张、每张多大、
// 读不到怎么办、截断怎么记账。三条路走**同一份** —— 真判定（service.go 的 ReviewTopic）、
// 管理端预览（preview.go 的 Preview）、带图试跑（service.go 的 TestTopic）。
// 分散实现 = 「预览里看到的图」与「真发出去的图」会漂，而这一屏存在的全部意义就是不漂。
//
// 传输走 **data URL 内联**（platform/ai 的 dataURL）：另一条路要「60 秒内能被服务端取回」的
// 公网图片地址，而本站的 /img/<hash> 在 dev / 内网外部取不到。代价是 base64 计入 48 MiB 请求体上限。

const (
	// maxImages 是每帖最多发几张。ck_topic_images_sort 允许一帖 9 张，但一次判定发 9 张的收益
	// 与耗时/带宽线性涨，而审核看的是「有没有问题图」—— 4 张覆盖绝大多数帖子；
	// 超了**截断并计数**（review_events.image_skipped），不许静默丢。
	maxImages = 4
	// maxImageBytes 是单张上限：与上传口同一个数（config.Image.PostMax = 2 MiB），
	// 所以**能传上来的图都过得去**，这条实际只挡「上传上限被调大过」的库。
	// 48 MiB 请求体那一笔账：4 × 2 MiB × 4/3(base64) ≈ 10.7 MiB，正文那点字忽略不计。
	maxImageBytes = 2 << 20
	// imageTimeoutFloor 是有图时的超时下限：多图更慢，而 ai_config.timeout_ms 的 CHECK 上限
	// 就是 60s（0020）—— 所以下限只能取到那个上限。超时仍然是**可重试失败**（ErrTransport），
	// 绝不落成判定（既定语义：拿不准/失败 → 转人工）。
	imageTimeoutFloor = 60 * time.Second
)

// ImageReader 是配图字节的读口，由 app 注入 media 的实现 —— 内部走 image.Store（磁盘路径由它自己拼），
// 本域**绝不自己拼路径**。读不到返回错误（含「行在文件丢」），由调用方转人工。
type ImageReader interface {
	ReadImageBytes(ctx context.Context, hash string) (data []byte, mime string, err error)
}

// imageFact 是一张配图在**这一次判定**里的下场（直接翻成线格式的 PayloadImage）。
type imageFact struct {
	Position int // topic_images.sort：该楼里的第几张（0 起）
	Floor    int // 挂在哪一楼
	Hash     string
	MIME     string
	Bytes    int
	Sent     bool
	Note     string // 没发的原因（空 = 发了）
}

// imagePayload 是「这次附到 user 消息里的图」+「每张图的下场」。
type imagePayload struct {
	Attachments []ai.Attachment
	Facts       []imageFact
	Bytes       int  // 发出去的原始字节合计（base64 后约 ×4/3）
	ReadFailed  bool // 有图读不到：调用方**转人工**（不是违规，也不让整帖判定失败）
}

func (p *imagePayload) sent() int    { return len(p.Attachments) }
func (p *imagePayload) skipped() int { return len(p.Facts) - len(p.Attachments) }

// loadImages 取一篇主题的配图并应用上限 —— **预览与真外呼走的就是这一条**。
// 顺序 = 页面顺序（楼层 → 该楼内的 sort）：审核员在帖子里看到的顺序，与模型看到的顺序一致，
// 截断也就先保住最前面的那几张（正常帖子的图都在 1 楼，而 1 楼正是我们发正文的那一楼）。
func (s *Service) loadImages(ctx context.Context, topicID int64) (*imagePayload, error) {
	out := &imagePayload{}
	rows, err := s.pool.Query(ctx, sqlTopicImages, topicID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var f imageFact
		if err := rows.Scan(&f.Hash, &f.Position, &f.Floor, &f.MIME, &f.Bytes); err != nil {
			return nil, err
		}
		out.Facts = append(out.Facts, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(out.Facts) == 0 {
		return out, nil
	}

	for i := range out.Facts {
		f := &out.Facts[i]
		switch {
		case s.imgs == nil:
			// 没接线不等于没有图：静默当成「纯文本帖」会让带图帖被判掉，而审核员以为图看过了。
			out.ReadFailed = true
			f.Note = "没有接线配图读口，这一次转人工"
		case out.ReadFailed:
			f.Note = "本次转人工（前面有图读不到），这一张也没发"
		case len(out.Attachments) >= maxImages:
			f.Note = "超过每帖 " + itoa(maxImages) + " 张的上限，这一张没发"
		case f.Bytes > maxImageBytes:
			// 先用**库里登记的字节数**挡一道：不为一张注定不发的图去读盘。
			f.Note = "单张超过 " + itoa(maxImageBytes>>20) + " MiB 上限，这一张没发"
		default:
			data, mime, err := s.imgs.ReadImageBytes(ctx, f.Hash)
			if err != nil {
				// 读不到（文件丢了 / 解码失败）→ 转人工：既不是违规，也不该让整帖判定失败。
				out.ReadFailed = true
				f.Note = "读不到：" + err.Error()
				continue
			}
			if len(data) > maxImageBytes {
				f.Note = "单张超过 " + itoa(maxImageBytes>>20) + " MiB 上限，这一张没发"
				continue
			}
			if mime != "" {
				f.MIME = mime
			}
			f.Bytes, f.Sent = len(data), true
			out.Attachments = append(out.Attachments, ai.Attachment{MIME: f.MIME, Data: data})
			out.Bytes += len(data)
		}
	}
	return out, nil
}
