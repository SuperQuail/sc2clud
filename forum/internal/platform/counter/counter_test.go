package counter

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelError + 1}))
}

func TestAddAccumulatesAndFlushBatches(t *testing.T) {
	var mu sync.Mutex
	var gotKeys []string
	var gotDeltas []int64
	calls := 0
	b := New(quietLogger(), func(_ context.Context, keys []string, deltas []int64) error {
		mu.Lock()
		defer mu.Unlock()
		calls++
		gotKeys, gotDeltas = keys, deltas
		return nil
	})
	b.Add(TopicViewKey(7), 1)
	b.Add(TopicViewKey(7), 1)
	b.Add(AssetDownloadKey(9), 3)

	b.flushOnce(context.Background())
	mu.Lock()
	defer mu.Unlock()
	if calls != 1 {
		t.Fatalf("应当只写回一次，实际 %d", calls)
	}
	merged := map[string]int64{}
	for i, k := range gotKeys {
		merged[k] += gotDeltas[i]
	}
	if merged[TopicViewKey(7)] != 2 {
		t.Fatalf("同一 key 应当合并累加，实际 %v", merged)
	}
	if merged[AssetDownloadKey(9)] != 3 {
		t.Fatalf("另一张表的计数丢了: %v", merged)
	}
}

func TestFlushFailureKeepsBufferThenGivesUp(t *testing.T) {
	var calls int
	b := New(quietLogger(), func(context.Context, []string, []int64) error {
		calls++
		return errors.New("db down")
	})
	b.Add(TopicViewKey(1), 5)

	b.flushOnce(context.Background()) // 第 1 次失败 → 放回缓冲
	if len(b.m) != 1 {
		t.Fatalf("失败后应当放回缓冲，实际 %d 个键", len(b.m))
	}
	b.flushOnce(context.Background()) // 第 2 次
	if len(b.m) != 1 {
		t.Fatalf("第二次失败后仍应保留，实际 %d", len(b.m))
	}
	b.flushOnce(context.Background()) // 第 3 次 → 放弃该批
	if len(b.m) != 0 {
		t.Fatalf("连续 %d 次失败后必须丢弃该批（否则内存无限涨），实际剩 %d", maxFailures, len(b.m))
	}
	if calls != maxFailures {
		t.Fatalf("应当恰好尝试 %d 次，实际 %d", maxFailures, calls)
	}
}

func TestKindParsesKnownPrefixes(t *testing.T) {
	kind, id, err := Kind(TopicViewKey(42))
	if err != nil || kind != "topic_view" || id != 42 {
		t.Fatalf("topic_view 解析错: %s %d %v", kind, id, err)
	}
	kind, id, err = Kind(AssetDownloadKey(43))
	if err != nil || kind != "asset_download" || id != 43 {
		t.Fatalf("asset_download 解析错: %s %d %v", kind, id, err)
	}
	if _, _, err := Kind("nope:1"); err == nil {
		t.Fatal("未知前缀必须报错，不能静默丢数")
	}
}

func TestRunFlushesOnShutdown(t *testing.T) {
	flushed := make(chan int64, 1)
	b := New(quietLogger(), func(_ context.Context, _ []string, deltas []int64) error {
		var sum int64
		for _, d := range deltas {
			sum += d
		}
		flushed <- sum
		return nil
	})
	b.Add(TopicViewKey(1), 7)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- b.Run(ctx) }()
	time.Sleep(20 * time.Millisecond)
	cancel()
	select {
	case sum := <-flushed:
		if sum != 7 {
			t.Fatalf("关闭时的 flush 值不对: %d", sum)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run 返回前必须 flush 一次")
	}
	if err := <-done; err != nil {
		t.Fatalf("Run: %v", err)
	}
}
