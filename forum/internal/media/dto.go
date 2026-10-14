package media

import "io"

// 本模块的请求 / 响应形状。字段名即 JSON 名（v2 §21.5），与 d5 §4.2 / §9.1 逐字对应。

// UploadAvatarInput：Body 是**已经整块读进内存**的图片字节（上限 64KiB，d5 §3.1）。
type UploadAvatarInput struct {
	Body []byte
}

// AvatarResult：重复上传同一张图返回 200（Created=false），内容变了才是 201。
type AvatarResult struct {
	Hash    string `json:"hash"`
	URL     string `json:"url"`
	Width   int    `json:"width"`
	Height  int    `json:"height"`
	Size    int64  `json:"size"`
	Created bool   `json:"created"`
}

// AttachTopicImageInput：TopicPublicID 来自路径参数，Body 是已读进内存的图片字节。
type AttachTopicImageInput struct {
	TopicPublicID string
	Body          []byte
}

// AttachedImage 是配图项（详情页 images: [{hash,url,width,height,sort}]）。
type AttachedImage struct {
	Hash   string `json:"hash"`
	URL    string `json:"url"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Sort   int    `json:"sort"`
}

// DetachTopicImageInput：Hash 来自路径参数（64 位小写 hex）。
type DetachTopicImageInput struct {
	TopicPublicID string
	Hash          string
}

// AddPaymentChannelInput：Label 空则用「收款码」，Body 是已读进内存的图片字节。
type AddPaymentChannelInput struct {
	Label string
	Body  []byte
}

// PaymentChannel 是收款码渠道（图的可见性由服务端定成 public，不接受请求里传）。
type PaymentChannel struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Image string `json:"image"`
	Sort  int    `json:"sort"`
}

// ImageResponse 是 GET /img/{hash} 的落点。权限不足时 Placeholder 非空、Body 为空。
type ImageResponse struct {
	Mime        string
	Size        int64
	Path        string        // 生产：X-Accel-Redirect 的相对路径 "<ab>/<cd>/<hash>"
	Placeholder []byte        // 非空 = 权限不足：写它 + no-store + X-Img-Denied
	Body        io.ReadCloser // 仅 serve_locally=true 时非空，handler 负责 Close
	Cache       bool          // true = immutable，false = no-store
}

// urlOf 是**唯一**的图片 URL 拼接点（U15：响应里给完整路径，前端直接当 src 用）。
func urlOf(hash string) string {
	if hash == "" {
		return ""
	}
	return "/img/" + hash
}
