// 迁移辅助：用仓库里同一个 platform/markdown + search.PlainText 渲染旧库的 Markdown，
// 保证导进来的 content_html / excerpt 与站点写路径逐字一致。
// 只被 deploy/migrate/import_legacy.py 调用（一次性的数据导入），不是运行时子命令。
//
// 用法：go run ./tools/mdr < bodies.json   （输入 ["md", ...]，输出 [{"html":..,"plain":..}, ...]）
package main

import (
	"encoding/json"
	"os"

	"forum/internal/platform/markdown"
	"forum/internal/platform/search"
)

func main() {
	var src []string
	if err := json.NewDecoder(os.Stdin).Decode(&src); err != nil {
		panic(err)
	}
	type out struct {
		HTML  string `json:"html"`
		Plain string `json:"plain"`
	}
	res := make([]out, 0, len(src))
	for _, md := range src {
		h, err := markdown.Render(md, nil)
		if err != nil {
			panic(err)
		}
		res = append(res, out{HTML: h, Plain: search.PlainText(h)})
	}
	if err := json.NewEncoder(os.Stdout).Encode(res); err != nil {
		panic(err)
	}
}
