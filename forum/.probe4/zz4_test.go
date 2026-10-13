package probe

import (
	"fmt"
	"regexp"
	"testing"
)

func TestSteps(t *testing.T) {
	steps := []string{
		"\\[@]",
		"\\[@([^\\]\\n]{1,20})]",
		"\\[@([^\\]\\n]{1,20})\\]",
	}
	for i, p := range steps {
		_, err := regexp.Compile(p)
		fmt.Printf("step %d pat=%q len=%d err=%v\n", i, p, len(p), err)
	}
}
