package probe

import (
	"fmt"
	"regexp"
	"testing"
)

func TestBuild(t *testing.T) {
	full := "\\[@([^\\]\\n]{1,20})\\](mention:(\\d{1,18})\\)"
	fmt.Printf("len=%d %q\n", len(full), full)
	for i := 1; i <= len(full); i++ {
		_, err := regexp.Compile(full[:i])
		if err != nil {
			fmt.Printf("first failure at prefix %d: %q -> %v\n", i, full[:i], err)
			break
		}
	}
}
