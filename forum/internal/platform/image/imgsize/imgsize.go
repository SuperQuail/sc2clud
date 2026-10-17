// Package imgsize 只认四种图片格式（PNG / JPEG / GIF / WebP），判的是**字节**，
// 不是 Content-Type、不是扩展名、不是文件名。SVG 不在其中：它可以内嵌 <script>，浏览器按 XML 执行。
//
// 依据：d5-content.md §1.3。
package imgsize

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
)

// ErrUnsupported 表示不是这四种格式（含 SVG）。msg 是给用户看的，可以直接展示。
var ErrUnsupported = errors.New("imgsize: unsupported")

type unsupportedError struct{ msg string }

func (e *unsupportedError) Error() string { return e.msg }
func (e *unsupportedError) Is(target error) bool {
	return target == ErrUnsupported
}

// Sniff 只看前 512 字节就能定类型。
func Sniff(head []byte) (string, bool) {
	switch {
	case len(head) >= 8 && bytes.Equal(head[:8], pngMagic):
		return "image/png", true
	case len(head) >= 3 && head[0] == 0xFF && head[1] == 0xD8 && head[2] == 0xFF:
		return "image/jpeg", true
	case len(head) >= 6 && (string(head[:6]) == "GIF87a" || string(head[:6]) == "GIF89a"):
		return "image/gif", true
	case len(head) >= 12 && string(head[:4]) == "RIFF" && string(head[8:12]) == "WEBP":
		return "image/webp", true
	}
	return "", false
}

// UnsupportedMessage 给出三档可读文案（d5 §1.3）。claimedImage 为 true 表示
// Content-Type 声称是图片但魔数不是——那多半是改了扩展名。
func UnsupportedMessage(head []byte, claimedImage bool) string {
	probe := head
	if len(probe) > 1024 {
		probe = probe[:1024]
	}
	lower := bytes.ToLower(bytes.TrimLeft(bytes.TrimPrefix(probe, []byte{0xEF, 0xBB, 0xBF}), " \t\r\n"))
	if bytes.HasPrefix(lower, []byte("<svg")) || bytes.HasPrefix(lower, []byte("<?xml")) {
		return "不支持 SVG 图片（SVG 可以内嵌脚本），请上传 PNG / JPEG / GIF / WebP"
	}
	if claimedImage {
		return "文件内容不是图片（可能改了扩展名），只接受 PNG / JPEG / GIF / WebP"
	}
	return "只接受 PNG / JPEG / GIF / WebP 图片"
}

// Size 解析宽高。解析不出来返回错误——尺寸不许留 0，否则列表页的 CLS 容器拿不到值。
//
// head 是文件开头的字节；tail 只在 JPEG 需要（它的 SOF 可能远在 EXIF/ICC 之后）。
// tail 为 nil 时按「整块已经在 head 里」处理。
func Size(mime string, head []byte, tail func(off int64, n int) ([]byte, error), size int64) (int, int, error) {
	switch mime {
	case "image/png":
		return pngSize(head)
	case "image/jpeg":
		return jpegSize(head, tail, size)
	case "image/gif":
		return gifSize(head)
	case "image/webp":
		return webpSize(head)
	}
	return 0, 0, &unsupportedError{msg: "只接受 PNG / JPEG / GIF / WebP 图片"}
}

var pngMagic = []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}

// PNG：IHDR 从偏移 16 起 8 字节大端，宽在前。
func pngSize(b []byte) (int, int, error) {
	if len(b) < 24 {
		return 0, 0, fmt.Errorf("PNG 尺寸读不出来（文件被截断）")
	}
	if string(b[12:16]) != "IHDR" {
		return 0, 0, fmt.Errorf("PNG 尺寸读不出来（缺少 IHDR）")
	}
	w := int(binary.BigEndian.Uint32(b[16:20]))
	h := int(binary.BigEndian.Uint32(b[20:24]))
	return dims(w, h, "PNG")
}

// GIF：逻辑屏幕描述符偏移 6 起 4 字节小端（宽、高）。
func gifSize(b []byte) (int, int, error) {
	if len(b) < 10 {
		return 0, 0, fmt.Errorf("GIF 尺寸读不出来（文件被截断）")
	}
	w := int(binary.LittleEndian.Uint16(b[6:8]))
	h := int(binary.LittleEndian.Uint16(b[8:10]))
	return dims(w, h, "GIF")
}

// WebP：三个 chunk 各自解析。VP8X（扩展）偏移 24 起 6 字节是 24 位小端（宽-1、高-1）。
func webpSize(b []byte) (int, int, error) {
	if len(b) < 16 {
		return 0, 0, fmt.Errorf("WebP 尺寸读不出来（文件被截断）")
	}
	switch string(b[12:16]) {
	case "VP8X":
		if len(b) < 30 {
			return 0, 0, fmt.Errorf("WebP 尺寸读不出来（VP8X 头被截断）")
		}
		w := 1 + int(b[24]) + int(b[25])<<8 + int(b[26])<<16
		h := 1 + int(b[27]) + int(b[28])<<8 + int(b[29])<<16
		return dims(w, h, "WebP")
	case "VP8L":
		if len(b) < 25 || b[20] != 0x2F {
			return 0, 0, fmt.Errorf("WebP 尺寸读不出来（无损头损坏）")
		}
		bits := binary.LittleEndian.Uint32(b[21:25])
		w := 1 + int(bits&0x3FFF)
		h := 1 + int((bits>>14)&0x3FFF)
		return dims(w, h, "WebP")
	case "VP8 ":
		if len(b) < 30 {
			return 0, 0, fmt.Errorf("WebP 尺寸读不出来（有损头被截断）")
		}
		w := int(binary.LittleEndian.Uint16(b[26:28]) & 0x3FFF)
		h := int(binary.LittleEndian.Uint16(b[28:30]) & 0x3FFF)
		return dims(w, h, "WebP")
	}
	return 0, 0, fmt.Errorf("WebP 尺寸读不出来（没找到 VP8 / VP8L / VP8X 数据块）")
}

// SOF 标记：这些段里有尺寸。C4（DHT）、C8（JPG）、CC（DAC）不是 SOF，不能收。
var jpegSOF = map[byte]bool{
	0xC0: true, 0xC1: true, 0xC2: true, 0xC3: true, 0xC5: true, 0xC6: true, 0xC7: true,
	0xC9: true, 0xCA: true, 0xCB: true, 0xCD: true, 0xCE: true, 0xCF: true,
}

// JPEG：扫段找 SOFn。EXIF/ICC 可能几百 KB，所以按需通过 tail 往前读，不把整块读进内存。
func jpegSize(head []byte, tail func(int64, int) ([]byte, error), size int64) (int, int, error) {
	// 读窗口从 head 开始，往后按需扩；每次扩到 64KB，最远读到 size。
	buf := append([]byte(nil), head...)
	load := func(off int64, n int) ([]byte, error) {
		if tail == nil {
			if off+int64(n) > int64(len(buf)) {
				return nil, fmt.Errorf("JPEG 尺寸读不出来（文件被截断）")
			}
			return buf[off : off+int64(n)], nil
		}
		if off+int64(n) > size {
			return nil, fmt.Errorf("JPEG 尺寸读不出来（文件被截断）")
		}
		return tail(off, n)
	}
	i := 2 // 跳过 SOI
	for i+1 < len(buf) || int64(i) < size {
		if i+1 >= len(buf) {
			chunk, err := load(int64(len(buf)), 64<<10)
			if err != nil {
				return 0, 0, err
			}
			if len(chunk) == 0 {
				break
			}
			buf = append(buf, chunk...)
			continue
		}
		if buf[i] != 0xFF {
			i++
			continue
		}
		marker := buf[i+1]
		switch {
		case marker == 0xFF: // 填充
			i++
		case marker == 0xD8: // 又一个 SOI
			i += 2
		case marker == 0xD9 || marker == 0xDA: // EOI / SOS：图像数据开始，尺寸段只在它之前
			return 0, 0, fmt.Errorf("JPEG 尺寸读不出来（没找到 SOF 段）")
		case marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7): // 无载荷
			i += 2
		default:
			if i+4 > len(buf) {
				i += 2
				continue
			}
			segLen := int(binary.BigEndian.Uint16(buf[i+2 : i+4]))
			if segLen < 2 {
				return 0, 0, fmt.Errorf("JPEG 尺寸读不出来（段长度非法）")
			}
			if jpegSOF[marker] {
				if i+9 > len(buf) {
					return 0, 0, fmt.Errorf("JPEG 尺寸读不出来（SOF 段被截断）")
				}
				h := int(binary.BigEndian.Uint16(buf[i+5 : i+7]))
				w := int(binary.BigEndian.Uint16(buf[i+7 : i+9]))
				return dims(w, h, "JPEG")
			}
			i += 2 + segLen
		}
	}
	return 0, 0, fmt.Errorf("JPEG 尺寸读不出来（没找到 SOF 段）")
}

func dims(w, h int, what string) (int, int, error) {
	if w <= 0 || h <= 0 {
		return 0, 0, fmt.Errorf("%s 尺寸不合法（%dx%d）", what, w, h)
	}
	return w, h, nil
}
