package probe

import (
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestRawVsFile(t *testing.T) {
	raw := `[\@([^\]\n]{1,20})\](mention:(\d{1,18})\)`
	b, err := os.ReadFile("D:/Code/Rust/SC2clud/forum/internal/platform/mention/mention.go")
	if err != nil {
		t.Fatal(err)
	}
	line := strings.Split(string(b), "\n")[16]
	i := strings.Index(line, ``)
	j := strings.LastIndex(line, ``)
	file := line[i+1 : j]
	fmt.Printf("raw  len=%d %q\n", len(raw), raw)
	fmt.Printf("file len=%d %q\n", len(file), file)
	fmt.Printf("equal=%v\n", raw == file)
	for k := 0; k < len(raw) && k < len(file); k++ {
		if raw[k] != file[k] {
			fmt.Printf("first diff at %d raw=%d file=%d\n", k, raw[k], file[k])
			break
		}
	}
	_, err = regexp.Compile(raw)
	fmt.Printf("compile raw err=%v\n", err)
}
