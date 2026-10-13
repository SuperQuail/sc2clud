package report_test

import (
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"forum/internal/report"
)

// TestReasonValuesMatchFrontendMock：举报原因的值域只声明在 DTO 的 binding tag 里，
// 前端 mock 的 REPORT_REASON 是另一处 —— 这条检查把两边逐字比对（_P2-修正清单 §7.2 第 1 条：
// 「同一个事实两处各写一遍」必须有一条能证明两边一致的检查）。
func TestReasonValuesMatchFrontendMock(t *testing.T) {
	field, ok := reflect.TypeOf(report.CreateReportInput{}).FieldByName("Reason")
	if !ok {
		t.Fatal("CreateReportInput 里没有 Reason 字段")
	}
	tag := field.Tag.Get("binding")
	m := regexp.MustCompile(`oneof=([a-z ]+)`).FindStringSubmatch(tag)
	if m == nil {
		t.Fatalf("Reason 的 binding tag 里没有 oneof：%q", tag)
	}
	got := strings.Fields(m[1])

	path := filepath.Join("..", "..", "..", "web", "src", "devroom", "pages", "15-admin", "mock", "content.ts")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读前端 mock: %v", err)
	}
	src := string(raw)
	i := strings.Index(src, "export const REPORT_REASON")
	if i < 0 {
		t.Fatal("mock 里找不到 REPORT_REASON")
	}
	rest := src[i:]
	end := strings.Index(rest, "\n};")
	if end < 0 {
		t.Fatal("REPORT_REASON 的对象没有结束")
	}
	var want []string
	for _, mm := range regexp.MustCompile(`([a-z_]+): '`).FindAllStringSubmatch(rest[:end], -1) {
		want = append(want, mm[1])
	}
	if len(want) == 0 {
		t.Fatal("没有从 mock 里解析出任何原因值 —— 解析逻辑坏了，这条检查就是假绿")
	}
	sort.Strings(got)
	sort.Strings(want)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("举报原因值域不一致：DTO tag = %v，前端 mock = %v", got, want)
	}
}
