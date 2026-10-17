package config

import (
	"encoding/json"

	"github.com/knadh/koanf/v2"
	"gopkg.in/yaml.v3"
)

// defaultsProvider 把结构体的默认值喂给 koanf。
// 走「结构体 → yaml → map」而不是手写一张默认值表：默认值只存在一处（Default()），
// yaml tag 与 koanf tag 同名；抄错一个字母编译期不报，所以让 Config 的 tag 唯一决定。
type defaultsProvider struct {
	vals map[string]any
}

func providerDefaults(c *Config) *defaultsProvider {
	raw, err := yaml.Marshal(c)
	if err != nil {
		// Default() 是包内写死的字面量，marshal 不可能失败
		panic("config: marshal defaults: " + err.Error())
	}
	var m map[string]any
	if err := yaml.Unmarshal(raw, &m); err != nil {
		panic("config: unmarshal defaults: " + err.Error())
	}
	return &defaultsProvider{vals: m}
}

func (p *defaultsProvider) Read() (map[string]any, error) { return p.vals, nil }
func (p *defaultsProvider) ReadBytes() ([]byte, error)    { return json.Marshal(p.vals) }

var _ koanf.Provider = (*defaultsProvider)(nil)
