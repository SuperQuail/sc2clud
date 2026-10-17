package app

import (
	"fmt"
	"log/slog"
	"os"
	"strings"

	"forum/internal/config"
)

// newLogger 用标准库 slog：JSON 输出（生产）或 text（本地开发）。不引 zap/zerolog/logrus。
func newLogger(c config.Log) (*slog.Logger, error) {
	var level slog.Level
	switch strings.ToLower(c.Level) {
	case "debug":
		level = slog.LevelDebug
	case "", "info":
		level = slog.LevelInfo
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		return nil, fmt.Errorf("log: 未知 level %q", c.Level)
	}
	opts := &slog.HandlerOptions{Level: level}
	var h slog.Handler
	if strings.EqualFold(c.Format, "text") {
		h = slog.NewTextHandler(os.Stdout, opts)
	} else {
		h = slog.NewJSONHandler(os.Stdout, opts)
	}
	return slog.New(h), nil
}
