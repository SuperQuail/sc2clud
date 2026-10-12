package memlimit

import (
	"context"
	"testing"
	"time"
)

func TestAllowWindowSemantics(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	l := New(100)
	l.now = func() time.Time { return now }
	ctx := context.Background()

	for i := 1; i <= 3; i++ {
		ok, _, err := l.Allow(ctx, "auth:login:ip:1.2.3.4", 3, time.Minute)
		if err != nil || !ok {
			t.Fatalf("第 %d 次应当放行: ok=%v err=%v", i, ok, err)
		}
	}
	ok, retry, err := l.Allow(ctx, "auth:login:ip:1.2.3.4", 3, time.Minute)
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if ok {
		t.Fatal("第 4 次必须被拒")
	}
	if retry <= 0 || retry > time.Minute {
		t.Fatalf("建议等待时间不对: %v", retry)
	}

	// 不同 key 互不影响
	if ok, _, _ := l.Allow(ctx, "auth:login:ip:5.6.7.8", 3, time.Minute); !ok {
		t.Fatal("另一个 key 应当放行")
	}

	// 窗口过去之后重新计数
	now = now.Add(time.Minute)
	if ok, _, _ := l.Allow(ctx, "auth:login:ip:1.2.3.4", 3, time.Minute); !ok {
		t.Fatal("新窗口应当放行")
	}
}

func TestZeroLimitMeansUnlimited(t *testing.T) {
	l := New(10)
	for i := 0; i < 100; i++ {
		if ok, _, _ := l.Allow(context.Background(), "k", 0, 0); !ok {
			t.Fatal("limit<=0 应当等价于不限流")
		}
	}
}

func TestKeyCapDoesNotGrowForever(t *testing.T) {
	l := New(4)
	for i := 0; i < 100; i++ {
		_, _, _ = l.Allow(context.Background(), string(rune('a'+i%26)), 1, time.Minute)
	}
	if len(l.m) > 4 {
		t.Fatalf("key 数必须被硬顶住，实际 %d", len(l.m))
	}
}
