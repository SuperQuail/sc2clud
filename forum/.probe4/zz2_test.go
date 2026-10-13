package probe

import (
	"fmt"
	"regexp"
	"testing"
)

func TestCmp(t *testing.T) {
	a := "[\\@([^\\]\\n]{1,20})\\](mention:(\\d{1,18})\\)"
	fmt.Printf("a=%q lenA=%d\n", a, len(a))
	_, ea := regexp.Compile(a)
	fmt.Printf("errA=%v\n", ea)
}

