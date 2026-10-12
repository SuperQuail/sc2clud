package app

import (
	"os"
	"path/filepath"
	"strings"
	"time"
)

// BuildInfo 是「跑的是哪个制品」的唯一来源。
// 由 main 用 -ldflags -X main.version 注入后传进来：不放全局变量、不放 init()。
type BuildInfo struct {
	Version   string
	WebDir    string
	StartedAt time.Time
}

// WebVersion 读前端产物里的 VERSION 文件（部署后核对「前端是不是这一批」）。
// 缺文件不是错误：dev 通常没有。
func (b BuildInfo) WebVersion() string {
	if b.WebDir == "" {
		return ""
	}
	raw, err := os.ReadFile(filepath.Join(b.WebDir, "VERSION"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}
