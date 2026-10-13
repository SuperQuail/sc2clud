package probe

import (
	"fmt"
	"regexp"
	"testing"
)

func TestMin(t *testing.T) {
	for i, p := range []string{
		`[^\n]{1,20})`,
		`((x){1,2})`,
		`(a{1,2})`,
		`[^a]{1,2})`,
		`([^\n]{1,2})`,
		`([a]{1,2})`,
	} {
		_, err := regexp.Compile(p)
		fmt.Printf("%d %-22q err=%v\n", i, p, err)
	}
}
