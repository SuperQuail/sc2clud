package probe

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestFromFile(t *testing.T) {
	b, err := os.ReadFile("D:/Code/Rust/SC2clud/forum/internal/platform/mention/mention.go")
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(b), "\n")
	line := lines[16]
	fmt.Printf("line len=%d\n", len(line))
	i := strings.Index(line, "`")
	j := strings.LastIndex(line, "`")
	pat := line[i+1 : j]
	fmt.Printf("pattern=%q len=%d\n", pat, len(pat))
	fmt.Println("bytes:")
	for k := 0; k < len(pat); k++ {
		fmt.Printf("%d ", pat[k])
	}
	fmt.Println()
	_, err = regexp.Compile(pat)
	fmt.Printf("compile err=%v\n", err)
}
