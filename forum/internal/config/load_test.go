package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const validKey = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"

// setValidEnv 给必填项填上合法值；各用例只覆盖自己要测的那一项。
func setValidEnv(t *testing.T) {
	t.Helper()
	t.Setenv("FORUM_DB__DSN", "postgres://forum:forum@127.0.0.1:5432/forum?sslmode=disable")
	t.Setenv("FORUM_MAIL__KEY", validKey)
	t.Setenv("FORUM_SITE__BASE_URL", "http://127.0.0.1:8081")
	t.Setenv("FORUM_IMAGE__ROOT", t.TempDir())
	t.Setenv("FORUM_WEB__DIST_DIR", t.TempDir())
}

func TestLoadDefaultsThenEnvOverride(t *testing.T) {
	setValidEnv(t)
	cfg, err := Load("")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.HTTP.Addr != "127.0.0.1:8081" {
		t.Fatalf("默认 addr 丢了: %q", cfg.HTTP.Addr)
	}
	if cfg.DB.MaxConns != 16 {
		t.Fatalf("默认 max_conns 丢了: %d", cfg.DB.MaxConns)
	}
	if cfg.Site.CookieName != "forum_session" {
		t.Fatalf("默认 cookie_name 丢了: %q", cfg.Site.CookieName)
	}
	if cfg.Queue.WorkersFor("small") != 4 || cfg.Queue.WorkersFor("standard") != 8 {
		t.Fatalf("队列档位不对: small=%d standard=%d", cfg.Queue.WorkersFor("small"), cfg.Queue.WorkersFor("standard"))
	}
	// 层级双下划线 + 词内单下划线
	t.Setenv("FORUM_SITE__COOKIE_NAME", "forum_dev_session")
	t.Setenv("FORUM_HTTP__READ_TIMEOUT", "3s")
	cfg2, err := Load("")
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg2.Site.CookieName != "forum_dev_session" {
		t.Fatalf("FORUM_SITE__COOKIE_NAME 没生效: %q", cfg2.Site.CookieName)
	}
	if cfg2.HTTP.ReadTimeout != 3*time.Second {
		t.Fatalf("FORUM_HTTP__READ_TIMEOUT 没生效: %v", cfg2.HTTP.ReadTimeout)
	}
}

func TestFileOverridesDefaultsAndEnvOverridesFile(t *testing.T) {
	setValidEnv(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte("http:\n  addr: 0.0.0.0:9000\nqueue:\n  lease: 9m\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.HTTP.Addr != "0.0.0.0:9000" {
		t.Fatalf("文件没覆盖默认值: %q", cfg.HTTP.Addr)
	}
	if cfg.Queue.Lease != 9*time.Minute {
		t.Fatalf("文件里的 queue.lease 没生效: %v", cfg.Queue.Lease)
	}

	t.Setenv("FORUM_HTTP__ADDR", "127.0.0.1:9999")
	cfg2, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg2.HTTP.Addr != "127.0.0.1:9999" {
		t.Fatalf("环境变量没覆盖文件: %q", cfg2.HTTP.Addr)
	}
}

func TestMissingFileIsNotAnError(t *testing.T) {
	setValidEnv(t)
	if _, err := Load(filepath.Join(t.TempDir(), "nope.yaml")); err != nil {
		t.Fatalf("配置文件不存在不该报错: %v", err)
	}
}

func TestValidateRejects(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(t *testing.T)
		want   string
	}{
		{"缺 dsn", func(t *testing.T) { t.Setenv("FORUM_DB__DSN", "") }, "db.dsn"},
		{"缺主密钥", func(t *testing.T) { t.Setenv("FORUM_MAIL__KEY", "") }, "mail.key"},
		{"主密钥不是 hex", func(t *testing.T) { t.Setenv("FORUM_MAIL__KEY", strings.Repeat("z", 64)) }, "mail.key"},
		{"主密钥长度不对", func(t *testing.T) { t.Setenv("FORUM_MAIL__KEY", strings.Repeat("ab", 16)) }, "mail.key"},
		{"缺 base_url", func(t *testing.T) { t.Setenv("FORUM_SITE__BASE_URL", "") }, "site.base_url"},
		{"captcha 取值非法", func(t *testing.T) { t.Setenv("FORUM_CAPTCHA__MODE", "sometimes") }, "captcha.mode"},
		{"env 取值非法", func(t *testing.T) { t.Setenv("FORUM_ENV", "staging") }, "env"},
		{"prod 用 memory driver", func(t *testing.T) {
			t.Setenv("FORUM_ENV", "prod")
			t.Setenv("FORUM_KV__DRIVER", "memory")
		}, "kv.driver"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			setValidEnv(t)
			c.mutate(t)
			_, err := Load("")
			if err == nil {
				t.Fatalf("应当校验失败")
			}
			if !strings.Contains(err.Error(), c.want) {
				t.Fatalf("错误信息里应当出现 %q，实际: %v", c.want, err)
			}
		})
	}
}

func TestValidateDoesNotLeakSecrets(t *testing.T) {
	setValidEnv(t)
	t.Setenv("FORUM_MAIL__KEY", strings.Repeat("ab", 16)) // 长度不对，触发报错
	_, err := Load("")
	if err == nil {
		t.Fatal("应当报错")
	}
	if strings.Contains(err.Error(), strings.Repeat("ab", 16)) {
		t.Fatalf("错误信息里泄漏了密钥值: %v", err)
	}
}

func TestLoadAcceptsRealYAMLShape(t *testing.T) {
	setValidEnv(t)
	dir := t.TempDir()
	root := t.TempDir()
	body := "http:\n  addr: 127.0.0.1:8081\n  trusted_proxies: []\n" +
		"image:\n  root: " + root + "\n" +
		"kv:\n  driver: memory\n" +
		"capacity:\n  profile: small\n"
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Capacity.Resolve(0) != "small" {
		t.Fatalf("档位应当被强制成 small: %q", cfg.Capacity.Resolve(0))
	}
	if cfg.KV.Driver != "memory" {
		t.Fatalf("kv.driver 没读到: %q", cfg.KV.Driver)
	}
}
