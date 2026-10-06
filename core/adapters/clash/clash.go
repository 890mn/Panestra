// Package clash communicates only with the local Mihomo controller.
package clash

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"go.yaml.in/yaml/v3"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

const ID = "dev.panestra.clash"
const Topic = ID + "/proxy.status"

type Group struct {
	Name       string   `json:"name"`
	Current    string   `json:"current"`
	Options    []string `json:"options"`
	Selectable bool     `json:"selectable"`
}
type Reading struct {
	Mode     string   `json:"mode"`
	Version  string   `json:"version"`
	Groups   []Group  `json:"groups"`
	Upload   *float64 `json:"upload"`
	Download *float64 `json:"download"`
}
type Status struct {
	Enabled       bool   `json:"enabled"`
	AllowControl  bool   `json:"allowControl"`
	AutoDetect    bool   `json:"autoDetect"`
	Controller    string `json:"controller"`
	HasCredential bool   `json:"hasCredential"`
	State         string `json:"state"`
	Message       string `json:"message"`
	UpdatedAt     string `json:"updatedAt,omitempty"`
	Stale         bool   `json:"stale"`
	Refreshing    bool   `json:"refreshing"`
	Reading
}
type Config struct {
	Enabled      bool   `json:"enabled"`
	AllowControl bool   `json:"allowControl"`
	AutoDetect   bool   `json:"autoDetect"`
	Controller   string `json:"controller"`
	Secret       string `json:"secret"`
}
type Change struct {
	Enabled         *bool   `json:"enabled"`
	AllowControl    *bool   `json:"allowControl"`
	AutoDetect      *bool   `json:"autoDetect"`
	Controller      *string `json:"controller"`
	Secret          *string `json:"secret"`
	ClearCredential bool    `json:"clearCredential"`
}
type Action struct {
	Action string `json:"action"`
	Mode   string `json:"mode,omitempty"`
	Group  string `json:"group,omitempty"`
	Node   string `json:"node,omitempty"`
}
type ReadError struct{ State, Message string }

func (e *ReadError) Error() string     { return e.Message }
func fail(state, message string) error { return &ReadError{state, message} }

var pipeNamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{1,160}$`)

func Controller(value string) (string, error) {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, `\\.\pipe\`) {
		value = "pipe://" + strings.TrimPrefix(value, `\\.\pipe\`)
	}
	if strings.HasPrefix(value, "pipe://") {
		name := strings.TrimPrefix(value, "pipe://")
		if !pipeNamePattern.MatchString(name) {
			return "", fmt.Errorf("本机命名管道名称无效")
		}
		return "pipe://" + name, nil
	}
	u, err := url.Parse(strings.TrimSpace(value))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.Path != "" && u.Path != "/" || u.RawQuery != "" || u.Fragment != "" || u.Opaque != "" {
		return "", fmt.Errorf("请使用本机 HTTP 或 HTTPS 控制器地址")
	}
	host := u.Hostname()
	if host != "localhost" {
		address := net.ParseIP(host)
		if address == nil || !address.IsLoopback() {
			return "", fmt.Errorf("控制器只允许 Core 电脑的回环地址")
		}
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 {
		return "", fmt.Errorf("请填写控制器端口")
	}
	if host == "localhost" {
		u.Host = net.JoinHostPort("127.0.0.1", u.Port())
	}
	u.Path = ""
	return u.String(), nil
}

func Detect(configHome string) (Config, error) {
	for _, directory := range []string{"io.github.clash-verge-rev.clash-verge-rev", "io.github.clash-verge.clash-verge"} {
		file := filepath.Join(configHome, directory, "clash-verge.yaml")
		opened, err := os.Open(file)
		if err != nil {
			continue
		}
		raw, err := io.ReadAll(io.LimitReader(opened, 8*1024*1024+1))
		opened.Close()
		if err != nil || len(raw) > 8*1024*1024 {
			continue
		}
		var config struct {
			Controller string `yaml:"external-controller"`
			Pipe       string `yaml:"external-controller-pipe"`
			Secret     string `yaml:"secret"`
		}
		if yaml.Unmarshal(raw, &config) != nil || strings.ContainsAny(config.Secret, "\r\n\x00") || len(config.Secret) > 4096 {
			continue
		}
		controller := config.Controller
		if config.Pipe != "" {
			if address, err := Controller(config.Pipe); err == nil {
				address = detectedPipe(address)
				return Config{AutoDetect: true, Controller: address, Secret: config.Secret}, nil
			}
		}
		if strings.HasPrefix(controller, ":") {
			controller = "127.0.0.1" + controller
		}
		host, port, err := net.SplitHostPort(controller)
		if err != nil {
			continue
		}
		if host == "0.0.0.0" || host == "::" || host == "" {
			host = "127.0.0.1"
		}
		address, err := Controller("http://" + net.JoinHostPort(host, port))
		if err == nil {
			return Config{AutoDetect: true, Controller: address, Secret: config.Secret}, nil
		}
	}
	return Config{}, fail("not_found", "未找到 Clash Verge 控制器，请打开软件或手动配置地址")
}

var client = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 3 * time.Second}).DialContext}, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}

func request(ctx context.Context, c Config, method, path string, body any, output any) error {
	base, err := Controller(c.Controller)
	if err != nil {
		return fail("unavailable", "本机控制器地址无效")
	}
	activeClient := client
	if strings.HasPrefix(base, "pipe://") {
		name := strings.TrimPrefix(base, "pipe://")
		activeClient, err = namedPipeClient(name)
		if err != nil {
			return fail("unavailable", "此 Core 不支持 Windows 命名管道")
		}
		base = "http://localhost"
	}
	var encoded []byte
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			return fail("unavailable", "操作请求无效")
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, base+path, bytes.NewReader(encoded))
	if err != nil {
		return fail("unavailable", "操作请求无效")
	}
	if c.Secret != "" {
		req.Header.Set("Authorization", "Bearer "+c.Secret)
	}
	req.Header.Set("Content-Type", "application/json")
	response, err := activeClient.Do(req)
	if err != nil {
		return fail("unavailable", "无法连接本机 Mihomo 控制器")
	}
	defer response.Body.Close()
	if response.StatusCode == 401 || response.StatusCode == 403 {
		return fail("needs_credential", "控制器凭据已失效，请更新 Secret 或重新自动发现")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fail("unavailable", fmt.Sprintf("控制器未接受请求（HTTP %d）", response.StatusCode))
	}
	if output != nil && json.NewDecoder(io.LimitReader(response.Body, 2*1024*1024)).Decode(output) != nil {
		return fail("unavailable", "控制器响应无效")
	}
	return nil
}
func readGroups(ctx context.Context, c Config) ([]Group, error) {
	var proxies struct {
		Proxies map[string]struct {
			Type string   `json:"type"`
			Now  string   `json:"now"`
			All  []string `json:"all"`
		} `json:"proxies"`
	}
	if err := request(ctx, c, "GET", "/proxies", nil, &proxies); err != nil {
		return nil, err
	}
	if proxies.Proxies == nil || len(proxies.Proxies) > 5000 {
		return nil, fail("unavailable", "控制器策略组响应无效")
	}
	groups := []Group{}
	for name, raw := range proxies.Proxies {
		if len(raw.All) == 0 {
			continue
		}
		if len(name) > 256 || len(raw.Now) > 256 || len(raw.All) > 2000 || len(groups) >= 100 {
			return nil, fail("unavailable", "控制器策略组数量或名称超出支持范围")
		}
		for _, option := range raw.All {
			if len(option) > 256 {
				return nil, fail("unavailable", "控制器节点名称超出支持范围")
			}
		}
		groups = append(groups, Group{Name: name, Current: raw.Now, Options: raw.All, Selectable: raw.Type == "Selector"})
	}
	sort.Slice(groups, func(i, j int) bool { return groups[i].Name < groups[j].Name })
	return groups, nil
}
func Read(ctx context.Context, c Config) (Reading, error) {
	var configs struct {
		Mode string `json:"mode"`
	}
	if err := request(ctx, c, "GET", "/configs", nil, &configs); err != nil {
		return Reading{}, err
	}
	if configs.Mode != "rule" && configs.Mode != "global" && configs.Mode != "direct" {
		return Reading{}, fail("unavailable", "控制器未提供可识别的代理模式")
	}
	groups, err := readGroups(ctx, c)
	if err != nil {
		return Reading{}, err
	}
	reading := Reading{Mode: configs.Mode, Groups: groups}
	var version struct {
		Version string `json:"version"`
	}
	if request(ctx, c, "GET", "/version", nil, &version) == nil && len(version.Version) < 128 {
		reading.Version = version.Version
	}
	var traffic struct {
		Up   *float64 `json:"up"`
		Down *float64 `json:"down"`
	}
	if request(ctx, c, "GET", "/traffic", nil, &traffic) == nil {
		valid := func(value *float64) *float64 {
			if value == nil || *value < 0 || math.IsNaN(*value) || math.IsInf(*value, 0) {
				return nil
			}
			return value
		}
		reading.Upload, reading.Download = valid(traffic.Up), valid(traffic.Down)
	}
	return reading, nil
}
func Execute(ctx context.Context, c Config, action Action) error {
	if !c.Enabled || !c.AllowControl {
		return fail("forbidden", "未授权 Clash 控制")
	}
	switch action.Action {
	case "mode":
		if action.Mode != "rule" && action.Mode != "global" && action.Mode != "direct" || action.Group != "" || action.Node != "" {
			return fail("unavailable", "代理模式无效")
		}
		return request(ctx, c, "PATCH", "/configs", map[string]string{"mode": action.Mode}, nil)
	case "node":
		if action.Mode != "" || action.Group == "" || action.Node == "" {
			return fail("unavailable", "策略组和节点不能为空")
		}
		// Validate against the controller immediately before switching; never trust a cached option.
		groups, err := readGroups(ctx, c)
		if err != nil {
			return err
		}
		for _, group := range groups {
			if group.Name == action.Group && group.Selectable {
				for _, option := range group.Options {
					if option == action.Node {
						return request(ctx, c, "PUT", "/proxies/"+url.PathEscape(group.Name), map[string]string{"name": option}, nil)
					}
				}
			}
		}
		return fail("unavailable", "节点已失效或该策略组不支持手动选择，请刷新状态")
	default:
		return fail("unavailable", "不支持的代理操作")
	}
}
