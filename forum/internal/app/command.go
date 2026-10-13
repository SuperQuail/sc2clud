package app

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"time"

	"forum/internal/config"
)

// Usage 是给用户看的用法；退出码 2 表示用法错误（与运行期失败的 1 区分）。
const Usage = "usage: forum <run|migrate|check|create-admin|backup> [-config path]\n" +
	"  run           -listen addr -web dir\n" +
	"  migrate\n" +
	"  check\n" +
	"  create-admin  -username name [-email addr]   （口令从 stdin 读；-password 仅供开发）\n" +
	"  backup        -out file.dump\n"

// Main 解析子命令并分发。main() 只调它一次，所以子命令名单只有这一处。
func Main(args []string, version string) int {
	if len(args) < 2 {
		fmt.Fprint(os.Stderr, Usage)
		return 2
	}
	cmd := args[1]
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	cfgPath := fs.String("config", "configs/config.yaml", "配置文件路径")
	listen := fs.String("listen", "", "覆盖 http.addr")
	web := fs.String("web", "", "覆盖 web.dist_dir")
	out := fs.String("out", "", "backup: 输出文件")
	username := fs.String("username", "", "create-admin: 用户名")
	email := fs.String("email", "", "create-admin: 邮箱（默认 <username>@sc2clud.local）")
	password := fs.String("password", "", "create-admin: 口令（默认从 stdin 读）")
	if err := fs.Parse(args[2:]); err != nil {
		return 2
	}

	cfg, err := config.Load(*cfgPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "load config:", err)
		return 1
	}
	if *listen != "" {
		cfg.HTTP.Addr = *listen
	}
	if *web != "" {
		cfg.Web.DistDir = *web
	}

	ctx := context.Background()
	bi := BuildInfo{Version: version, WebDir: cfg.Web.DistDir, StartedAt: time.Now().UTC()}

	switch cmd {
	case "run":
		err = Run(ctx, cfg, bi)
	case "migrate":
		err = Migrate(ctx, cfg)
	case "check":
		err = Check(ctx, cfg)
	case "create-admin":
		pw := *password
		if pw == "" {
			pw, err = readPassword(os.Stdin)
		}
		if err == nil {
			err = CreateAdmin(ctx, cfg, *username, *email, pw)
		}
	case "backup":
		err = Backup(ctx, cfg, *out)
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n%s", cmd, Usage)
		return 2
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// readPassword 从 stdin 读一行口令。
// 不做终端回显屏蔽：那要引 golang.org/x/term 或走 syscall，而 create-admin 只在服务器上手工跑一次。
func readPassword(r io.Reader) (string, error) {
	buf := make([]byte, 0, 128)
	one := make([]byte, 1)
	for {
		n, err := r.Read(one)
		if n > 0 {
			if one[0] == '\n' || one[0] == '\r' {
				break
			}
			buf = append(buf, one[0])
		}
		if err != nil {
			if len(buf) == 0 {
				return "", fmt.Errorf("create-admin: 读口令失败: %w", err)
			}
			break
		}
	}
	if len(buf) == 0 {
		return "", fmt.Errorf("create-admin: 口令不能为空")
	}
	return string(buf), nil
}
