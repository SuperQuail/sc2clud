package app

import (
	"testing"

	"forum/internal/config"
)

// 这条守的是一个真实踩过的 bug：日志按容量档位算 worker 并发（standard → 8），
// 而 queue 自己在 Run() 里按 WorkersFor("") 算（永远 → 4），于是日志打 8、实际跑 4。
// 两个数都「看起来对」，只有把「交给 queue 的 Workers」和「queue 自己算出来的 Workers」放在一起断言才抓得住。
func TestResolveQueueMatchesWhatWorkerUses(t *testing.T) {
	cases := []struct {
		name    string
		in      config.Queue
		profile string
		want    int
	}{
		{"small 档按档位取 4", config.Queue{}, "small", 4},
		{"standard 档按档位取 8", config.Queue{}, "standard", 8},
		{"auto 未识别时退回 small 档", config.Queue{}, "", 4},
		{"显式配置优先于档位", config.Queue{Workers: 6}, "standard", 6},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := resolveQueue(c.in, c.profile)
			if got.Workers != c.want {
				t.Fatalf("档位 %q 应当解析出 %d 个 worker，实际 %d", c.profile, c.want, got.Workers)
			}
			// 关键断言：pgqueue.Run 里算并发用的是 WorkersFor("")，
			// 它必须与 NewInfra 交给 queue 的那个数完全一致，否则就是「日志与行为不一致」。
			if actually := got.WorkersFor(""); actually != got.Workers {
				t.Fatalf("交给 queue 的是 %d，但 queue 自己按 WorkersFor(\"\") 会算出 %d —— 日志与行为不一致",
					got.Workers, actually)
			}
			if got.Workers < 1 {
				t.Fatalf("worker 数必须 >= 1（0 个 worker = 队列永远不动），实际 %d", got.Workers)
			}
		})
	}
}
