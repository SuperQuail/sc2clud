package probe

import (
	"fmt"
	"regexp"
	"testing"
)

// 关键问题：`\[` 之后跟 `(`、再跟字符类、再跟 `)`，解析器报 unexpected )。
func TestIsolate(t *testing.T) {
	cases := []string{
		`\[` + `(` + `[^\n]{1,20}` + `)`,
		`\[` + `(` + `[^a]{1,20}` + `)`,
		`x` + `(` + `[^a]{1,20}` + `)`,
		`[` + `(` + `[^a]{1,20}` + `)`,
		`\[` + `(` + `[a]{1,20}` + `)`,
		`\[` + `(` + `b{1,20}` + `)`,
	}
	for i, p := range cases {
		_, err := regexp.Compile(p)
		fmt.Printf("%d %-18q len=%d err=%v\n", i, p, len(p), err)
	}
}
