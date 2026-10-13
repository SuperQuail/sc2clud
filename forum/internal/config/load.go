package config

import (
	"fmt"
	"os"
	"strings"

	"github.com/knadh/koanf/parsers/yaml"
	"github.com/knadh/koanf/providers/env"
	"github.com/knadh/koanf/providers/file"
	"github.com/knadh/koanf/v2"
)

// Load 按「默认值 → 文件 → 环境变量」三段加载，然后校验。
// 配置文件不存在不算错误（默认值 + 环境变量足以起一个 dev 实例）。
func Load(path string) (*Config, error) {
	k := koanf.New(".")

	if err := k.Load(providerDefaults(Default()), nil); err != nil {
		return nil, fmt.Errorf("config: load defaults: %w", err)
	}

	if path != "" {
		if _, err := os.Stat(path); err == nil {
			if err := k.Load(file.Provider(path), yaml.Parser()); err != nil {
				return nil, fmt.Errorf("config: load %s: %w", path, err)
			}
		}
	}

	if err := k.Load(env.Provider("FORUM_", ".", envKeyReplacer), nil); err != nil {
		return nil, fmt.Errorf("config: load env: %w", err)
	}

	cfg := &Config{}
	if err := k.Unmarshal("", cfg); err != nil {
		return nil, fmt.Errorf("config: unmarshal: %w", err)
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return cfg, nil
}

// envKeyReplacer：FORUM_ 前缀、__ 分隔层级、单下划线保留（它是字段名的一部分）。
// FORUM_DB__DSN → db.dsn，FORUM_SITE__COOKIE_NAME → site.cookie_name，FORUM_WEB__DIST_DIR → web.dist_dir。
//
// 单下划线不能换成点：那样 FORUM_WEB__DIST_DIR 会变成 web.dist.dir，
// 而字段 tag 是 dist_dir —— 配置项会静默地读不到（踩过）。
func envKeyReplacer(key string) string {
	key = strings.TrimPrefix(key, "FORUM_")
	return strings.ToLower(strings.ReplaceAll(key, "__", "."))
}
