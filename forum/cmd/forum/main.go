// Command forum 是论坛后端的唯一入口。
//
// 现在只有骨架：模块与依赖已就绪、可编译；子命令按
// 完全重构/论坛后端技术方案-v2.md 第 17 章的 M0 起逐步补齐。
package main

import (
	"fmt"
	"os"
)

const version = "0.1.0-dev"

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: forum <run|migrate|backup|create-admin|check|version> [-config path]")
		os.Exit(2)
	}
	switch os.Args[1] {
	case "version":
		fmt.Println("forum", version)
	default:
		fmt.Fprintf(os.Stderr, "forum: %q 尚未实现，见 完全重构/论坛后端技术方案-v2.md 第 17 章 M0\n", os.Args[1])
		os.Exit(1)
	}
}
