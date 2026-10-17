package imgsize

import (
	"bytes"
	"encoding/binary"
	"errors"
	"strings"
	"testing"
)

func pngBytes(w, h int) []byte {
	b := make([]byte, 33)
	copy(b, pngMagic)
	copy(b[12:16], "IHDR")
	binary.BigEndian.PutUint32(b[16:20], uint32(w))
	binary.BigEndian.PutUint32(b[20:24], uint32(h))
	return b
}

func gifBytes(w, h int) []byte {
	b := make([]byte, 16)
	copy(b, "GIF89a")
	binary.LittleEndian.PutUint16(b[6:8], uint16(w))
	binary.LittleEndian.PutUint16(b[8:10], uint16(h))
	return b
}

func webpVP8X(w, h int) []byte {
	b := make([]byte, 30)
	copy(b, "RIFF")
	copy(b[8:12], "WEBP")
	copy(b[12:16], "VP8X")
	b[24] = byte(w - 1)
	b[25] = byte((w - 1) >> 8)
	b[26] = byte((w - 1) >> 16)
	b[27] = byte(h - 1)
	b[28] = byte((h - 1) >> 8)
	b[29] = byte((h - 1) >> 16)
	return b
}

func webpVP8L(w, h int) []byte {
	b := make([]byte, 25)
	copy(b, "RIFF")
	copy(b[8:12], "WEBP")
	copy(b[12:16], "VP8L")
	b[20] = 0x2F
	bits := uint32(w-1) | uint32(h-1)<<14
	binary.LittleEndian.PutUint32(b[21:25], bits)
	return b
}

func webpVP8(w, h int) []byte {
	b := make([]byte, 30)
	copy(b, "RIFF")
	copy(b[8:12], "WEBP")
	copy(b[12:16], "VP8 ")
	binary.LittleEndian.PutUint16(b[26:28], uint16(w))
	binary.LittleEndian.PutUint16(b[28:30], uint16(h))
	return b
}

// JPEG：可选的 EXIF 段（APP1）+ SOF0。
func jpegBytes(w, h, exifPayload int) []byte {
	var b bytes.Buffer
	b.Write([]byte{0xFF, 0xD8})
	if exifPayload > 0 {
		b.Write([]byte{0xFF, 0xE1})
		seg := make([]byte, exifPayload+2)
		binary.BigEndian.PutUint16(seg[:2], uint16(exifPayload+2))
		b.Write(seg)
	}
	b.Write([]byte{0xFF, 0xC0})
	sof := make([]byte, 2+1+2+2)
	binary.BigEndian.PutUint16(sof[:2], uint16(len(sof)))
	sof[2] = 8
	binary.BigEndian.PutUint16(sof[3:5], uint16(h))
	binary.BigEndian.PutUint16(sof[5:7], uint16(w))
	b.Write(sof)
	return b.Bytes()
}

func TestSniffOnlyFourFormats(t *testing.T) {
	cases := []struct {
		name string
		b    []byte
		want string
	}{
		{"png", pngBytes(3, 4), "image/png"},
		{"jpeg", jpegBytes(3, 4, 0), "image/jpeg"},
		{"gif87", append([]byte("GIF87a"), gifBytes(3, 4)[6:]...), "image/gif"},
		{"gif89", gifBytes(3, 4), "image/gif"},
		{"webp", webpVP8X(3, 4), "image/webp"},
		{"svg", []byte("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"), ""},
		{"xml", []byte("<?xml version=\"1.0\"?><svg/>"), ""},
		{"text", []byte("hello"), ""},
		{"empty", nil, ""},
	}
	for _, c := range cases {
		got, ok := Sniff(c.b)
		if ok != (c.want != "") || got != c.want {
			t.Fatalf("%s: Sniff = %q,%v 期望 %q", c.name, got, ok, c.want)
		}
	}
}

// SVG 必须被拒，而且文案要能直接给用户看（d5 §1.3）。
func TestUnsupportedMessageSVG(t *testing.T) {
	msg := UnsupportedMessage([]byte("  <svg width=\"1\">"), false)
	if !strings.Contains(msg, "不支持 SVG") {
		t.Fatalf("SVG 的文案必须点明不支持 SVG，实际 %q", msg)
	}
	if got := UnsupportedMessage([]byte("hello"), true); !strings.Contains(got, "可能改了扩展名") {
		t.Fatalf("声称是图片但魔数不对时要提示改了扩展名，实际 %q", got)
	}
	if got := UnsupportedMessage([]byte("hello"), false); !strings.Contains(got, "只接受 PNG") {
		t.Fatalf("其余情况给通用文案，实际 %q", got)
	}
}

func TestSizeFourFormats(t *testing.T) {
	cases := []struct {
		mime string
		b    []byte
		w, h int
	}{
		{"image/png", pngBytes(640, 480), 640, 480},
		{"image/gif", gifBytes(320, 200), 320, 200},
		{"image/webp", webpVP8X(1024, 768), 1024, 768},
		{"image/webp", webpVP8L(300, 400), 300, 400},
		{"image/webp", webpVP8(1600, 900), 1600, 900},
		// SOF 在 200KB 的 EXIF 之后：head 只给前 512 字节时应该走 tail
		{"image/jpeg", jpegBytes(800, 600, 200<<10), 800, 600},
	}
	for _, c := range cases {
		w, h, err := Size(c.mime, c.b, func(off int64, n int) ([]byte, error) {
			if off >= int64(len(c.b)) {
				return nil, errors.New("EOF")
			}
			end := off + int64(n)
			if end > int64(len(c.b)) {
				end = int64(len(c.b))
			}
			return c.b[off:end], nil
		}, int64(len(c.b)))
		if err != nil {
			t.Fatalf("%s %dx%d: %v", c.mime, c.w, c.h, err)
		}
		if w != c.w || h != c.h {
			t.Fatalf("%s: 尺寸 = %dx%d 期望 %dx%d", c.mime, w, h, c.w, c.h)
		}
	}
}

// 截断文件必须报错，不能返回 0×0 —— 尺寸留 0 会让前端 CLS 容器拿不到值。
func TestSizeTruncatedFails(t *testing.T) {
	full := pngBytes(640, 480)
	if _, _, err := Size("image/png", full[:20], nil, int64(len(full))); err == nil {
		t.Fatal("截断的 PNG 必须报错")
	}
	if _, _, err := Size("image/gif", gifBytes(1, 1)[:8], nil, 8); err == nil {
		t.Fatal("截断的 GIF 必须报错")
	}
	if _, _, err := Size("image/jpeg", []byte{0xFF, 0xD8, 0xFF, 0xDA}, nil, 4); err == nil {
		t.Fatal("没有 SOF 段的 JPEG 必须报错")
	}
	if _, _, err := Size("image/webp", webpVP8X(10, 10)[:20], nil, 20); err == nil {
		t.Fatal("截断的 VP8X 必须报错")
	}
}

// 0 尺寸（全 0 字节的 GIF）也不能当合法图片收进来。
func TestSizeZeroRejected(t *testing.T) {
	if _, _, err := Size("image/gif", gifBytes(0, 0), nil, 16); err == nil {
		t.Fatal("0 尺寸必须报错")
	}
}
