package config

import "time"

// Default 返回全部默认值。加载顺序的第一段就是它（不是 yaml、不是 env）。
func Default() *Config {
	return &Config{
		Env: "dev",
		HTTP: HTTP{
			Addr:              "127.0.0.1:8081",
			ReadHeaderTimeout: 5 * time.Second,
			ReadTimeout:       15 * time.Second,
			WriteTimeout:      30 * time.Second,
			IdleTimeout:       60 * time.Second,
			ShutdownTimeout:   15 * time.Second,
			MaxHeaderBytes:    1 << 20,
			BodyLimitDefault:  1 << 20,
		},
		Log: Log{Level: "info", Format: "json"},
		DB: DB{
			MaxConns:         16,
			MinConns:         2,
			MaxConnLifetime:  time.Hour,
			MaxConnIdleTime:  30 * time.Minute,
			StatementTimeout: 5 * time.Second,
			LockTimeout:      2 * time.Second,
			IdleTxTimeout:    30 * time.Second,
		},
		KV: KV{
			Driver:       "memory",
			Addr:         "127.0.0.1:6379",
			DialTimeout:  2 * time.Second,
			ReadTimeout:  time.Second,
			WriteTimeout: time.Second,
		},
		Queue: Queue{
			PollInterval: time.Second,
			Lease:        5 * time.Minute,
			MaxRetry:     5,
			BackoffBase:  10 * time.Second,
			BackoffCap:   time.Hour,
			DoneKeep:     7 * 24 * time.Hour,
			DeadKeep:     30 * 24 * time.Hour,
		},
		Auth: Auth{
			SessionTTL:     720 * time.Hour,
			Argon2Time:     2,
			Argon2MemoryKB: 32768,
			Argon2Threads:  2,
			Argon2KeyLen:   32,
		},
		Image: Image{
			Root:         "data/images",
			ServeLocally: true,
			AvatarMax:    64 << 10,
			PostMax:      2 << 20,
			PaymentMax:   512 << 10,
		},
		Captcha:  Captcha{Mode: "off"},
		Web:      Web{DistDir: "web/dist", BasePath: "/", ServeShell: true, ServeAssets: true},
		Capacity: Capacity{Profile: "auto"},
	}
}
