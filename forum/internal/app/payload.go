package app

import (
	"encoding/json"
	"errors"

	"forum/internal/forum/pgsql"
)

// unmarshalPayload 解我们自己写的任务 payload（nil 当空对象）。
func unmarshalPayload(b []byte, v any) error {
	if len(b) == 0 {
		return nil
	}
	return json.Unmarshal(b, v)
}

// isNoRows 认「这一行不在了」：forum/pgsql 的单行查询用它表示没查到。
func isNoRows(err error) bool { return errors.Is(err, pgsql.ErrNoRows) }
