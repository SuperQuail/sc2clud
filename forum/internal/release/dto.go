package release

import "time"

// 本模块的请求 / 响应形状。字段名即 JSON 名。

// Asset 是一个平台/架构的产物。本站不存字节，url 是外部直链。
type Asset struct {
	ID            string `json:"id"`
	Platform      string `json:"platform"`
	Arch          string `json:"arch"`
	URL           string `json:"url"`
	Size          int64  `json:"size"`
	SHA256        string `json:"sha256"`
	DownloadCount int64  `json:"download_count"`
}

// ReleaseDetail 是一个版本（含它的全部产物）。
type ReleaseDetail struct {
	ID          string     `json:"id"`
	Version     string     `json:"version"`
	Channel     string     `json:"channel"`
	NotesMD     string     `json:"notes_md"`
	NotesHTML   string     `json:"notes_html"`
	Status      string     `json:"status"`
	PublishedAt *time.Time `json:"published_at"`
	CreatedAt   time.Time  `json:"created_at"`
	Assets      []Asset    `json:"assets"`

	// rowID 是内部 bigint（自增主键），只用于游标与补产物，**不进 JSON**（拍板 §5.6）。
	rowID int64
}

// ListReleasesInput 是历史版本的游标分页入参（拍板 §5.1）。
type ListReleasesInput struct {
	Channel string `json:"channel" form:"channel"`
	Limit   int    `json:"limit" form:"limit"`
	Cursor  string `json:"cursor" form:"cursor"`
}

// ReleasePage 是历史版本的一页。
type ReleasePage struct {
	Items      []ReleaseDetail `json:"items"`
	NextCursor string          `json:"next_cursor"`
}

// UpsertReleaseInput 是管理端录入。ID 为空 = 新建；Status 为空 = 不改状态。
// notes_html 由**调用方**渲染（markdown 管线是 forum/site 的能力），这里只落库。
type UpsertReleaseInput struct {
	ID        string `json:"id"`
	Version   string `json:"version"`
	Channel   string `json:"channel"`
	NotesMD   string `json:"notes_md"`
	NotesHTML string `json:"notes_html"`
	Status    string `json:"status"`
}

// SetReleaseStatusInput 是状态机的落点（draft / published / archived）。
type SetReleaseStatusInput struct {
	ID     string
	Status string
}

// UpsertAssetInput 按 (release, platform, arch) 幂等写入。
type UpsertAssetInput struct {
	ReleaseID string `json:"release_id"`
	Platform  string `json:"platform"`
	Arch      string `json:"arch"`
	URL       string `json:"url"`
	SHA256    string `json:"sha256"`
	Size      int64  `json:"size"`
}
