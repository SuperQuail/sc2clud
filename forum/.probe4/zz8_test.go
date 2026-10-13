package probe

import (
	"fmt"
	"regexp"
	"testing"
)

func TestVar(t *testing.T) {
	v := []string{
		`[\@([^\]\n]{1,20})\](mention:(\d{1,18})\)`,
		`[\@([^]]{1,20})\](mention:(\d{1,18})\)`,
		`[\@([^\n]{1,20})\](mention:(\d{1,18})\)`,
		`[@\?([^\]\n]{1,20})\](mention:(\d{1,18})\)`,
	}
	for i, p := range v {
		_, err := regexp.Compile(p)
		fmt.Printf("var %d len=%d err=%v\n", i, len(p), err)
	}
}
