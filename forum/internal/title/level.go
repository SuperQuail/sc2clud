package title

import "math"

// LevelForExp 是等级公式的唯一 Go 实现：level = floor(sqrt(exp/100)) + 1。
// 写入 users.level 的那句 SQL（pgsql.addExpSQL）与它逐字同算法，自检会比对两边。
func LevelForExp(exp int) int {
	return int(math.Floor(math.Sqrt(float64(exp)/100))) + 1
}
