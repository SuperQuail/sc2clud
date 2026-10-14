package localstore

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"forum/internal/platform/image"
)

func newStore(t *testing.T, minFree int64) *Store {
	t.Helper()
	s, err := New(t.TempDir(), minFree)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

func put(t *testing.T, s *Store, data []byte, max int64) (image.Hash, int64, error) {
	t.Helper()
	return s.Put(context.Background(), bytes.NewReader(data), max)
}

func TestPutDedupesSameContent(t *testing.T) {
	s := newStore(t, 0)
	data := []byte("same content")
	h1, n1, err := put(t, s, data, 1<<20)
	if err != nil {
		t.Fatalf("第一次: %v", err)
	}
	h2, n2, err := put(t, s, data, 1<<20)
	if err != nil {
		t.Fatalf("第二次: %v", err)
	}
	if h1 != h2 || n1 != n2 {
		t.Fatalf("同内容必须同一个 hash：%s/%d vs %s/%d", h1, n1, h2, n2)
	}
	// 磁盘上只有一个文件（tmp 里也不许留残件）
	var files []string
	if err := s.Walk(context.Background(), func(h image.Hash) error {
		files = append(files, string(h))
		return nil
	}); err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if len(files) != 1 || files[0] != string(h1) {
		t.Fatalf("磁盘上应当只有一个文件，实际 %v", files)
	}
	entries, err := os.ReadDir(s.tmp)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("tmp 里不许留残件，实际 %d 个", len(entries))
	}
	if size, err := s.Stat(context.Background(), h1); err != nil || size != int64(len(data)) {
		t.Fatalf("Stat = %d,%v 期望 %d", size, err, len(data))
	}
}

func TestPutTooLargeLeavesNothing(t *testing.T) {
	s := newStore(t, 0)
	data := bytes.Repeat([]byte("x"), 100)
	if _, _, err := put(t, s, data, 99); !errors.Is(err, image.ErrTooLarge) {
		t.Fatalf("超限必须 ErrTooLarge，实际 %v", err)
	}
	entries, _ := os.ReadDir(s.tmp)
	if len(entries) != 0 {
		t.Fatalf("超限后 tmp 里不许留文件，实际 %d 个", len(entries))
	}
	var n int
	_ = s.Walk(context.Background(), func(image.Hash) error { n++; return nil })
	if n != 0 {
		t.Fatalf("超限后不该落盘，实际 %d 个文件", n)
	}
}

// 正好等于上限要放行（边界：maxBytes 是「最多收这么多」）。
func TestPutExactlyMaxBytesAllowed(t *testing.T) {
	s := newStore(t, 0)
	data := bytes.Repeat([]byte("y"), 64)
	if _, n, err := put(t, s, data, 64); err != nil || n != 64 {
		t.Fatalf("正好到上限必须放行，实际 n=%d err=%v", n, err)
	}
}

// 磁盘闸门：阈值大到不可能满足时必须 ErrDiskFull，且**连临时文件都不建**。
// free_other.go 返回 -1（这个平台量不出来），所以这条只能在能读到剩余空间的平台上断言。
func TestPutDiskGate(t *testing.T) {
	s := newStore(t, 0)
	free, err := freeBytes(s.root)
	if err != nil || free <= 0 {
		t.Skip("这个平台量不出剩余空间（freeBytes 返回 -1）")
	}
	s.minFreeBytes = free + 1<<40
	if _, _, err := put(t, s, []byte("z"), 1024); !errors.Is(err, image.ErrDiskFull) {
		t.Fatalf("闸门必须返回 ErrDiskFull，实际 %v", err)
	}
	entries, _ := os.ReadDir(s.tmp)
	if len(entries) != 0 {
		t.Fatalf("预检不过时不许建临时文件，实际 %d 个", len(entries))
	}
}

// 「量不出来就不拦」：freeBytes 的 -1 不是「磁盘空了」。
//
// 这条是 2026-10-14 MIG-ART 补的：在此之前 free_other.go 返回 0，而 Put 的判据是
// `free >= 0 && free < minFreeBytes` —— 于是在量不出剩余空间的平台（Windows）上，
// **任何 minFreeBytes > 0 的写入都报 image.ErrDiskFull**（app 装配传的是 512MiB），
// 表现为「导入命令与所有图片上传一律 media.disk_full」。用例只断言 Put 那一侧：
// 阈值必须失效，而不是「0 字节可用时仍然拒收」。
func TestPutDiskGateIsNoopWhenFreeSpaceUnknown(t *testing.T) {
	s := newStore(t, 512<<20)
	if _, n, err := put(t, s, []byte("unknown-free"), 1024); err != nil || n != int64(len("unknown-free")) {
		t.Fatalf("量不出剩余空间时闸门必须失效，实际 n=%d err=%v", n, err)
	}
}

func TestDeleteIsIdempotent(t *testing.T) {
	s := newStore(t, 0)
	h, _, err := put(t, s, []byte("gone"), 1024)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.Delete(context.Background(), h); err != nil {
		t.Fatalf("第一次删: %v", err)
	}
	if err := s.Delete(context.Background(), h); err != nil {
		t.Fatalf("重复删必须幂等: %v", err)
	}
	if _, err := s.Open(context.Background(), h); !errors.Is(err, image.ErrNotFound) {
		t.Fatalf("删掉之后 Open 必须 ErrNotFound，实际 %v", err)
	}
	if _, err := s.Stat(context.Background(), h); !errors.Is(err, image.ErrNotFound) {
		t.Fatalf("删掉之后 Stat 必须 ErrNotFound，实际 %v", err)
	}
}

func TestOpenReturnsContent(t *testing.T) {
	s := newStore(t, 0)
	data := []byte("round trip")
	h, _, err := put(t, s, data, 1024)
	if err != nil {
		t.Fatal(err)
	}
	rc, err := s.Open(context.Background(), h)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rc.Close() }()
	got, err := io.ReadAll(rc)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, data) {
		t.Fatalf("读回的内容不一致: %q", got)
	}
}

// Walk 只认 64 位小写 hex；残件（.part）与别的文件都不算。
func TestWalkSkipsNonHashFiles(t *testing.T) {
	s := newStore(t, 0)
	h, _, err := put(t, s, []byte("real"), 1024)
	if err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(s.root, string(h)[:2], string(h)[2:4])
	for _, name := range []string{"abc.part", "ABCDEF", strings.ToUpper(string(h))} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	var got []string
	if err := s.Walk(context.Background(), func(h image.Hash) error {
		got = append(got, string(h))
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != string(h) {
		t.Fatalf("Walk 只该看到真 hash，实际 %v", got)
	}
}
