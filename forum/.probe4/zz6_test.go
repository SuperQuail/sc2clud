package probe

import (
	"fmt"
	"regexp"
	"testing"
)

func TestBytes(t *testing.T) {
	full := "\\[@([^\\]\\n]{1,20})\\](mention:(\\d{1,18})\\)"
	fmt.Printf("len=%d\n", len(full))
	for i := 0; i < len(full); i++ {
		fmt.Printf("%d:%c(%d) ", i, full[i], full[i])
	}
	fmt.Println()
	// 前缀逐个编译，只报不是「以反斜杠结尾」的那种失败
	for i := 1; i <= len(full); i++ {
		_, err := regexp.Compile(full[:i])
		if err != nil {
			s := err.Error()
			fmt.Printf("prefix %2d %-20q err=%s\n", i, full[:i], s)
		}
	}
}
