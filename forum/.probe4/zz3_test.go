package probe

import (
	"fmt"
	"regexp"
	"testing"
)

func TestBits(t *testing.T) {
	q := "\""
	_ = q
	cases := []struct{ name, pat string }{
		{"A class-with-escaped-bracket", "[^\\]\\n]"},
		{"B plain-class", "[^\\n]"},
		{"C escaped-close", "a\\]b"},
		{"D escaped-open", "\\[@]"},
		{"E tail", "x\\)"},
	}
	for _, c := range cases {
		_, err := regexp.Compile(c.pat)
		fmt.Printf("%-30s pat=%q err=%v\n", c.name, c.pat, err)
	}
}
