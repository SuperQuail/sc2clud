// forum 是 SC2clud 的服务端入口：只解析子命令并调 app。
// 业务与装配全在 internal/app；这里保持 40 行以内。
package main

import (
	"os"

	"forum/internal/app"
)

// 由 -ldflags -X main.version=... 注入（部署脚本传 git short sha）。
var version = "dev"

func main() {
	os.Exit(app.Main(os.Args, version))
}
