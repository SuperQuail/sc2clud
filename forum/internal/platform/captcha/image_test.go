package captcha

import (
	"bytes"
	"image/png"
	"math/rand"
	"strings"
	"testing"
)

// 一张图能画出字：**每个字形都有像素**，而且画出来的暗像素数量与字形表算出来的一致。
// 这条挡的是「字形表错位」——比如 alphabet 里删了一个字符却忘了删字形，
// 于是所有字符都往后错一位：图仍然能渲染、仍然能解码、**只是答案对不上**。
func TestRenderDrawsEveryGlyph(t *testing.T) {
	if len(alphabet) != 32 {
		t.Fatalf("字符集必须是 32 个（32^4 ≈ 105 万组合），现在是 %d", len(alphabet))
	}
	if len(glyph) != len(alphabet) {
		t.Fatalf("字形表 %d 个与字符集 %d 个对不上", len(glyph), len(alphabet))
	}
	for i := 0; i < len(alphabet); i++ {
		bits := 0
		for _, row := range glyph[i] {
			bits += popcount(row)
		}
		if bits == 0 {
			t.Fatalf("字符 %q 的字形是空的", alphabet[i])
		}
		if _, ok := glyphOf(alphabet[i]); !ok {
			t.Fatalf("字符 %q 查不到字形", alphabet[i])
		}
	}

	// 画 4 个字符，数暗像素：>= 字形像素 × 3（缩放 4×4，抖动带来的重叠只会更多、不会更少）。
	for _, ans := range []string{"ABCD", "WXYZ", "2345", "A7K9"} {
		png0, err := renderPNG(ans, rand.New(rand.NewSource(1)))
		if err != nil {
			t.Fatalf("renderPNG(%q): %v", ans, err)
		}
		img, err := png.Decode(bytes.NewReader(png0))
		if err != nil {
			t.Fatalf("解 PNG: %v", err)
		}
		b := img.Bounds()
		if b.Dx() != width || b.Dy() != height {
			t.Fatalf("画布尺寸 %dx%d，期望 %dx%d", b.Dx(), b.Dy(), width, height)
		}
		dark := 0
		want := 0
		for i := 0; i < len(ans); i++ {
			g, _ := glyphOf(ans[i])
			for _, row := range g {
				want += popcount(row)
			}
		}
		for y := b.Min.Y; y < b.Max.Y; y++ {
			for x := b.Min.X; x < b.Max.X; x++ {
				r, gg, bb, _ := img.At(x, y).RGBA()
				if r>>8 < 0x80 && gg>>8 < 0x80 && bb>>8 < 0x80 {
					dark++
				}
			}
		}
		if dark < want*3 {
			t.Fatalf("%q：画出的暗像素 %d 个，字形表算出来至少 %d 个", ans, dark, want*3)
		}
	}
}

// 同一颗种子必须画出同一张图：否则「可复现」就是假的，测试也就证明不了字形本身。
func TestRenderIsDeterministic(t *testing.T) {
	a, err := renderPNG("K7M2", rand.New(rand.NewSource(7)))
	if err != nil {
		t.Fatal(err)
	}
	b, err := renderPNG("K7M2", rand.New(rand.NewSource(7)))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a, b) {
		t.Fatal("同一颗种子画出了两张不同的图")
	}
	c, err := renderPNG("K7M3", rand.New(rand.NewSource(7)))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(a, c) {
		t.Fatal("答案不同却画出同一张图，暗像素断言就没意义了")
	}
}

// 大小写不敏感：字形表按大写查，小写要先归一化。
func TestGlyphLookupIsCaseInsensitive(t *testing.T) {
	up, ok := glyphOf('K')
	if !ok {
		t.Fatal("大写的 K 查不到字形")
	}
	low, ok := glyphOf('k')
	if !ok {
		t.Fatal("小写的 k 查不到字形")
	}
	if up != low {
		t.Fatal("大小写映射到不同字形")
	}
	if _, ok := glyphOf('I'); ok {
		t.Fatal("I 易混，不该在字符集里")
	}
	if _, ok := glyphOf('0'); ok {
		t.Fatal("0 易混，不该在字符集里")
	}
}

func TestNewAnswerUsesAlphabetOnly(t *testing.T) {
	rnd := rand.New(rand.NewSource(3))
	seen := map[byte]bool{}
	for i := 0; i < 200; i++ {
		a := newAnswer(rnd)
		if len(a) != answerLen {
			t.Fatalf("答案长度 %d，期望 %d", len(a), answerLen)
		}
		for j := 0; j < len(a); j++ {
			if !strings.ContainsRune(alphabet, rune(a[j])) {
				t.Fatalf("答案里出现字符集之外的字符 %q", a[j])
			}
			seen[a[j]] = true
		}
	}
	if len(seen) < 20 {
		t.Fatalf("200 次抽样只出现 %d 种字符，随机源像是坏的", len(seen))
	}
}

func popcount(b byte) int {
	n := 0
	for ; b != 0; b >>= 1 {
		n += int(b & 1)
	}
	return n
}
