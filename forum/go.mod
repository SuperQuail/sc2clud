module forum

go 1.27

// 这一组依赖是 完全重构/论坛后端技术方案-v2.md 第 2 章冻结的选型，不是候选清单。
// 2026-10-12 盲审 C5：SQLite 已作废（数据库改 PostgreSQL），驱动换成 pgx。
// 注意：M0 把代码写出来之前，这些模块还没被 import，go mod tidy 会把它们全删掉——
// 所以现在只跑 go mod download，不要跑 go mod tidy。
require (
	entgo.io/ent v0.14.6
	github.com/gin-contrib/cors v1.7.9
	github.com/gin-gonic/gin v1.12.0
	github.com/go-ego/gse v1.1.0
	github.com/go-playground/validator/v10 v10.30.5
	github.com/golang-migrate/migrate/v4 v4.20.1
	github.com/google/uuid v1.6.0
	github.com/hashicorp/golang-lru/v2 v2.0.7
	github.com/jackc/pgx/v5 v5.11.0
	github.com/knadh/koanf/parsers/yaml v1.1.1
	github.com/knadh/koanf/providers/env v1.1.0
	github.com/knadh/koanf/providers/file v1.2.1
	github.com/knadh/koanf/v2 v2.3.8
	github.com/microcosm-cc/bluemonday v1.0.27
	github.com/resend/resend-go/v3 v3.17.0
	github.com/stretchr/testify v1.12.1
	github.com/wneessen/go-mail v0.8.1
	github.com/yuin/goldmark v1.8.6
	golang.org/x/crypto v0.58.0
	golang.org/x/time v0.16.0
)
