// Package migrations 把迁移文件嵌进二进制。
// 迁移文件在制品里，forum migrate 启动前执行；版本不一致时 forum run 拒绝启动。
// 编号规则见 完全重构/后端设计/d1-platform.md §8.1：<4 位序号>_<域>.{up,down}.sql。
package migrations

import (
	"embed"
	"fmt"
	"io/fs"
	"strconv"
	"strings"
)

//go:embed postgres/*.sql
var postgres embed.FS

// FS 是迁移目录（golang-migrate 的 iofs 源要的根就是 *.sql 所在那一层）。
func FS() fs.FS {
	sub, err := fs.Sub(postgres, "postgres")
	if err != nil {
		// 嵌入目录是编译期固定的，取不到只可能是 embed 指令被改错
		panic("migrations: " + err.Error())
	}
	return sub
}

// Latest 返回嵌入集里最高的版本号（= 最大的 4 位序号前缀）。
// 文件名是零填充的定长前缀，所以字典序即时序。
func Latest() (uint, error) {
	entries, err := fs.ReadDir(postgres, "postgres")
	if err != nil {
		return 0, fmt.Errorf("migrations: read dir: %w", err)
	}
	var max uint
	found := false
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".up.sql") {
			continue
		}
		idx := strings.IndexByte(name, '_')
		if idx <= 0 {
			return 0, fmt.Errorf("migrations: 文件名不符合 <序号>_<域>.up.sql 规则: %s", name)
		}
		n, err := strconv.ParseUint(name[:idx], 10, 32)
		if err != nil {
			return 0, fmt.Errorf("migrations: %s 的序号不是数字: %w", name, err)
		}
		if !found || uint(n) > max {
			max, found = uint(n), true
		}
	}
	if !found {
		return 0, fmt.Errorf("migrations: postgres/ 下没有任何 .up.sql")
	}
	return max, nil
}
