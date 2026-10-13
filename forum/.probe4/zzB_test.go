package probe

import (
	"fmt"
	"regexp"
	"testing"
)

func TestMin2(t *testing.T) {
	for i, p := range []string{
		`[\@([^\n]{1,20})`,
		`[\@([^\n]{1,20})\]`,
		`[\@([^\n]{1,20})]`,
		`w([\d]{1,2})`,
		`w([a]{1,2})`,
		`w([^a]{1,2})`,
	} {
		_, err := regexp.Compile(p)
		fmt.Printf("%d %-26q len=%d err=%v\n", i, p, len(p), err)
	}
}
