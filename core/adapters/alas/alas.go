// Package alas reads a loopback-only bridge hosted in the real ALAS WebUI process.
package alas

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"time"
)

const ID = "dev.panestra.alas"
const Topic = ID + "/task.status"

type Task struct {
	Name    string `json:"name"`
	NextRun string `json:"nextRun"`
}
type Instance struct {
	Name        string `json:"name"`
	State       string `json:"state"`
	CurrentTask string `json:"currentTask"`
	WaitingTask string `json:"waitingTask"`
	Tasks       []Task `json:"tasks"`
}
type Status struct {
	Enabled          bool       `json:"enabled"`
	Prepared         bool       `json:"prepared"`
	HasConfiguration bool       `json:"hasConfiguration"`
	Instance         string     `json:"instance"`
	State            string     `json:"state"`
	Message          string     `json:"message"`
	UpdatedAt        string     `json:"updatedAt,omitempty"`
	ObservedAt       string     `json:"observedAt,omitempty"`
	Stale            bool       `json:"stale"`
	Refreshing       bool       `json:"refreshing"`
	Instances        []Instance `json:"instances"`
}
type Config struct {
	Enabled  bool   `json:"enabled"`
	Root     string `json:"root"`
	Port     int    `json:"port"`
	Instance string `json:"instance"`
	Secret   string `json:"secret"`
	BridgeID string `json:"bridgeId"`
}
type Change struct {
	Enabled            *bool   `json:"enabled"`
	Root               *string `json:"root"`
	Port               *int    `json:"port"`
	Instance           *string `json:"instance"`
	ClearConfiguration bool    `json:"clearConfiguration"`
}
type Setup struct {
	Root     string `json:"root"`
	Port     int    `json:"port"`
	Instance string `json:"instance"`
	Launcher string `json:"launcher"`
	Prepared bool   `json:"prepared"`
}
type Reading struct {
	Schema     int        `json:"schema"`
	BridgeID   string     `json:"bridgeId"`
	ObservedAt string     `json:"observedAt"`
	Instances  []Instance `json:"instances"`
}
type Error struct{ State, Message string }

func (e *Error) Error() string         { return e.Message }
func fail(state, message string) error { return &Error{state, message} }

var label = regexp.MustCompile(`^[A-Za-z0-9_-]{1,80}$`)
var client = &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 2 * time.Second}).DialContext}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func Read(ctx context.Context, c Config) (Reading, error) {
	if c.Port < 1 || c.Port > 65535 || c.Secret == "" || c.BridgeID == "" {
		return Reading{}, fail("bridge_required", "请先准备 ALAS 本机桥接")
	}
	request, err := http.NewRequestWithContext(ctx, "GET", "http://127.0.0.1:"+strconv.Itoa(c.Port)+"/panestra/status", nil)
	if err != nil {
		return Reading{}, fail("unavailable", "桥接请求无效")
	}
	request.Header.Set("Authorization", "Bearer "+c.Secret)
	response, err := client.Do(request)
	if err != nil {
		return Reading{}, fail("unavailable", "无法连接 ALAS 本机桥接")
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case 404:
		return Reading{}, fail("bridge_required", "当前 ALAS 未通过 Panestra 桥接启动")
	case 401, 403:
		return Reading{}, fail("bridge_required", "ALAS 桥接凭据不匹配，请使用当前启动文件重启桥接")
	}
	if response.StatusCode != 200 {
		return Reading{}, fail("unavailable", fmt.Sprintf("ALAS 桥接暂不可用（HTTP %d）", response.StatusCode))
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 {
		return Reading{}, fail("unavailable", "桥接响应超出支持范围")
	}
	var reading Reading
	if json.Unmarshal(raw, &reading) != nil || reading.Schema != 1 || reading.BridgeID != c.BridgeID || reading.Instances == nil || len(reading.Instances) > 100 {
		return Reading{}, fail("bridge_required", "ALAS 桥接版本或实例身份不匹配")
	}
	observed, err := time.Parse(time.RFC3339Nano, reading.ObservedAt)
	if err != nil || time.Since(observed) > 2*time.Minute || time.Until(observed) > 2*time.Minute {
		return Reading{}, fail("unavailable", "ALAS 状态时间无效")
	}
	seen := map[string]bool{}
	for _, instance := range reading.Instances {
		if !label.MatchString(instance.Name) || seen[instance.Name] || len(instance.Tasks) > 20 {
			return Reading{}, fail("unavailable", "ALAS 实例信息无效")
		}
		seen[instance.Name] = true
		switch instance.State {
		case "running", "stopped", "error", "updating", "unknown":
		default:
			return Reading{}, fail("unavailable", "ALAS 运行状态无效")
		}
		for _, value := range []string{instance.CurrentTask, instance.WaitingTask} {
			if value != "" && !label.MatchString(value) {
				return Reading{}, fail("unavailable", "ALAS 任务名称无效")
			}
		}
		for _, task := range instance.Tasks {
			if !label.MatchString(task.Name) {
				return Reading{}, fail("unavailable", "ALAS 调度信息无效")
			}
			if _, err := time.Parse(time.RFC3339Nano, task.NextRun); err != nil {
				return Reading{}, fail("unavailable", "ALAS 调度时间无效")
			}
		}
	}
	return reading, nil
}
