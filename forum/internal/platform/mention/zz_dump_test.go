package mention

import (
	"fmt"
	"testing"
)

func TestDumpRe(t *testing.T) {
	fmt.Printf("LEN=%d SRC=%q\n", len(BodyRe.String()), BodyRe.String())
	for i := 0; i < len(BodyRe.String()); i++ {
		fmt.Printf("%d ", BodyRe.String()[i])
	}
	fmt.Println()
}
