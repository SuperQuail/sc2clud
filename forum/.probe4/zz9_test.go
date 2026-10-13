package probe

import (
	"fmt"
	"regexp"
	"strings"
	"testing"
)

func TestBisect(t *testing.T) {
	p := `[\@([^\n]{1,20})\](mention:(\d{1,18})\)`
	fmt.Printf("len=%d\n", len(p))
	for i := 1; i <= len(p); i++ {
		_, err := regexp.Compile(p[:i])
		msg := ""
		if err != nil {
			msg = err.Error()
		}
		incomplete := strings.Contains(msg, "missing closing") || strings.Contains(msg, "trailing backslash")
		fmt.Printf("%2d %-24q %v\n", i, p[:i], boolNote(msg, incomplete))
	}
}

func boolNote(msg string, incomplete bool) string {
	if msg == "" {
		return "OK"
	}
	if incomplete {
		return "incomplete"
	}
	return "*** REAL ERROR: " + msg
}
