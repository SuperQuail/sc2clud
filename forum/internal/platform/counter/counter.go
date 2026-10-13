// Package counter 是热点计数：内存累加 + 定时批量写回。
// 它不认识任何业务表：写回函数由 app 层装（counter 只负责缓冲与键的语义）。
// 依据：d1-platform.md §7、v2 §7.5。
package counter

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	flushInterval = 15 * time.Second
	maxKeys       = 10000
	maxFailures   = 3
)

// FlushFunc 把一批计数写进数据库：keys 与 deltas 一一对应，deltas 恒为正数。
type FlushFunc func(ctx context.Context, keys []string, deltas []int64) error

type Buffer struct {
	log   *slog.Logger
	flush FlushFunc

	mu sync.Mutex
	m  map[string]int64

	failures int
}

func New(log *slog.Logger, flush FlushFunc) *Buffer {
	return &Buffer{log: log, flush: flush, m: make(map[string]int64)}
}

// Add 只加内存：请求路径上不碰网络、不碰数据库。
func (b *Buffer) Add(key string, delta int64) {
	if delta == 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if _, ok := b.m[key]; !ok && len(b.m) >= maxKeys {
		// 计数是统计量：键太多说明调用点出了问题，丢新键并告警，不能让内存无限涨
		b.log.Warn("counter: 键数超上限，丢弃", "key", key, "max", maxKeys)
		return
	}
	b.m[key] += delta
}

// Run 每 15 秒 flush 一次；ctx 取消时再 flush 一次才返回。
// 关闭顺序要求「计数写回」发生在 worker/cron 停止之后，所以它是独立的一个 goroutine。
func (b *Buffer) Run(ctx context.Context) error {
	t := time.NewTicker(flushInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			b.flushOnce(context.WithoutCancel(ctx))
			return nil
		case <-t.C:
			b.flushOnce(ctx)
		}
	}
}

func (b *Buffer) flushOnce(ctx context.Context) {
	keys, deltas := b.drain()
	if len(keys) == 0 {
		return
	}
	if err := b.flush(ctx, keys, deltas); err != nil {
		b.failures++
		if b.failures >= maxFailures {
			b.log.Error("counter: 连续写回失败，丢弃本批", "keys", len(keys), "err", err.Error())
			return
		}
		b.restore(keys, deltas) // 失败放回缓冲，下轮重试
		b.log.Warn("counter: 写回失败，下轮重试", "keys", len(keys), "err", err.Error())
		return
	}
	b.failures = 0
}

func (b *Buffer) drain() ([]string, []int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.m) == 0 {
		return nil, nil
	}
	keys := make([]string, 0, len(b.m))
	deltas := make([]int64, 0, len(b.m))
	for k, v := range b.m {
		keys = append(keys, k)
		deltas = append(deltas, v)
	}
	b.m = make(map[string]int64)
	return keys, deltas
}

func (b *Buffer) restore(keys []string, deltas []int64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i, k := range keys {
		b.m[k] += deltas[i]
	}
}

// 计数键的前缀是 counter 与写回函数之间唯一的约定：写回函数按键前缀选表。
//
// **加一个新键 = 同时加三处**：前缀常量、下面的 Kind 分支、pgcounter 的写回表。
// 漏掉第二处的后果是整批 flush 失败重试到丢批（不是丢这一个键），漏掉第三处是静默丢增量。
// pgcounter 的 TestEveryKnownKindHasWriter 把这两条都钉住了——加键时必须先让它绿。
const (
	prefixTopicView     = "view:topic:"
	prefixAssetDownload = "download:asset:"
	prefixSourceGo      = "go:source:"
)

// TopicViewKey 主题浏览量（topics.view_count）。
func TopicViewKey(topicID int64) string { return prefixTopicView + strconv.FormatInt(topicID, 10) }

// AssetDownloadKey 外链下载量（release_assets.download_count）。
func AssetDownloadKey(assetID int64) string {
	return prefixAssetDownload + strconv.FormatInt(assetID, 10)
}

// GoSourceKey 下载源转链次数（topic_sources.go_count）。
func GoSourceKey(sourceID int64) string { return prefixSourceGo + strconv.FormatInt(sourceID, 10) }

// Kind 与 ID 把键拆开；不认识的前缀返回 error——写回函数据此报错，而不是静默丢数。
func Kind(key string) (kind string, id int64, err error) {
	switch {
	case strings.HasPrefix(key, prefixTopicView):
		id, err = strconv.ParseInt(strings.TrimPrefix(key, prefixTopicView), 10, 64)
		return "topic_view", id, err
	case strings.HasPrefix(key, prefixAssetDownload):
		id, err = strconv.ParseInt(strings.TrimPrefix(key, prefixAssetDownload), 10, 64)
		return "asset_download", id, err
	case strings.HasPrefix(key, prefixSourceGo):
		id, err = strconv.ParseInt(strings.TrimPrefix(key, prefixSourceGo), 10, 64)
		return "source_go", id, err
	default:
		return "", 0, fmt.Errorf("counter: 未知的计数键 %q", key)
	}
}
