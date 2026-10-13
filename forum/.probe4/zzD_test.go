package probe

import (
	"fmt"
	"regexp"
	"testing"
)

// 同样意图的四种写法：找出哪一种能编译
func TestEsc(t *testing.T) {
	cases := []string{
		"[\\@([^\\n]{1,20})",   // 双引号字面量：反斜杠 + [
		"[\u005c\u0040([^\u005cn]{1,20})",
		"[\x5c\x40([^\x5cn]{1,20})",
		"[\134\100([^\134n]{1,20})",
		"[[]@([^\\n]{1,20})",     // 字符类写 [
	}
	for i, p := range cases {
		_, err := regexp.Compile(p)
		fmt.Printf("%d %-20q len=%d err=%v\n", i, p, len(p), err)
	}
}
