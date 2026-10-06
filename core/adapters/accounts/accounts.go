// Package accounts reads subscription quotas and balances without issuing model calls.
package accounts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"time"
)

var IDs = []string{"glm", "deepseek"}

func Known(id string) bool      { return id == "glm" || id == "deepseek" }
func PluginID(id string) string { return "dev.panestra." + id }
func Topic(id string) string    { return PluginID(id) + "/account.usage" }

type Window struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	UsedPercent      *float64 `json:"usedPercent"`
	RemainingPercent *float64 `json:"remainingPercent"`
	Current          *float64 `json:"current"`
	Limit            *float64 `json:"limit"`
	ResetsAt         *int64   `json:"resetsAt"`
}
type Balance struct {
	Currency string `json:"currency"`
	Total    string `json:"total"`
	Granted  string `json:"granted"`
	ToppedUp string `json:"toppedUp"`
}
type Reading struct {
	Windows   []Window  `json:"windows"`
	Balances  []Balance `json:"balances"`
	Available *bool     `json:"available"`
}
type Status struct {
	ID                  string `json:"id"`
	Enabled             bool   `json:"enabled"`
	HasCredential       bool   `json:"hasCredential"`
	State               string `json:"state"`
	Message             string `json:"message"`
	UpdatedAt           string `json:"updatedAt,omitempty"`
	Stale               bool   `json:"stale"`
	Refreshing          bool   `json:"refreshing"`
	PollIntervalSeconds int    `json:"pollIntervalSeconds"`
	Reading
}
type ReadError struct{ State, Message string }

func (e *ReadError) Error() string     { return e.Message }
func fail(state, message string) error { return &ReadError{state, message} }

var productionClient = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}

func Read(ctx context.Context, id, key string) (Reading, error) {
	if !Known(id) {
		return Reading{}, fail("unavailable", "不支持的账户适配")
	}
	address, auth := "https://api.deepseek.com/user/balance", "Bearer "+key
	if id == "glm" {
		address, auth = "https://open.bigmodel.cn/api/monitor/usage/quota/limit", key
	}
	return readHTTP(ctx, productionClient, address, auth, id)
}
func readHTTP(ctx context.Context, client *http.Client, address, auth, id string) (Reading, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return Reading{}, fail("unavailable", "无法创建查询请求")
	}
	request.Header.Set("Authorization", auth)
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Language", "zh-CN")
	response, err := client.Do(request)
	if err != nil {
		return Reading{}, fail("unavailable", "连接失败，请检查 Core 电脑的网络后重试")
	}
	defer response.Body.Close()
	switch response.StatusCode {
	case 401, 403:
		return Reading{}, fail("needs_credential", "API Key 无效或没有查询权限，请在设置中更换")
	case 429:
		return Reading{}, fail("rate_limited", "服务暂时限制查询，请稍后刷新")
	case 200:
	default:
		return Reading{}, fail("unavailable", fmt.Sprintf("服务暂不可用（HTTP %d）", response.StatusCode))
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
	if err != nil || len(data) > 1024*1024 {
		return Reading{}, fail("unavailable", "用量响应无效，请稍后重试")
	}
	if id == "glm" {
		return ParseGLM(data)
	}
	return ParseDeepSeek(data)
}
func validNumber(v *float64) *float64 {
	if v == nil || math.IsNaN(*v) || math.IsInf(*v, 0) || *v < 0 {
		return nil
	}
	return v
}
func ParseGLM(data []byte) (Reading, error) {
	var payload struct {
		Success *bool           `json:"success"`
		Code    json.RawMessage `json:"code"`
		Data    *struct {
			Limits []struct {
				Type       string   `json:"type"`
				Unit       int      `json:"unit"`
				Number     int      `json:"number"`
				Percentage *float64 `json:"percentage"`
				Current    *float64 `json:"currentValue"`
				Limit      *float64 `json:"usage"`
				NextReset  *int64   `json:"nextResetTime"`
			} `json:"limits"`
		} `json:"data"`
	}
	if json.Unmarshal(data, &payload) != nil || payload.Success != nil && !*payload.Success {
		return Reading{}, fail("unavailable", "无法读取 Coding Plan 用量，请确认此 Key 对应个人编程套餐")
	}
	if len(payload.Code) > 0 && string(payload.Code) != "200" && string(payload.Code) != `"200"` && string(payload.Code) != "0" {
		return Reading{}, fail("unavailable", "服务未返回 Coding Plan 用量，请确认套餐与 Key")
	}
	if payload.Data == nil || len(payload.Data.Limits) == 0 || len(payload.Data.Limits) > 32 {
		return Reading{}, fail("unavailable", "服务未提供额度窗口，不推算剩余用量")
	}
	reading := Reading{Windows: []Window{}, Balances: []Balance{}}
	for i, raw := range payload.Data.Limits {
		name := "额度窗口"
		switch raw.Type {
		case "TOKENS_LIMIT":
			name = "编程额度"
		case "TIME_LIMIT":
			name = "MCP 工具额度"
		}
		units := map[int]string{3: "小时", 4: "天", 5: "月", 6: "周"}
		if unit, known := units[raw.Unit]; known && raw.Number > 0 {
			name += fmt.Sprintf(" · %d %s", raw.Number, unit)
		}
		w := Window{ID: fmt.Sprintf("%s-%d", raw.Type, i), Name: name, Current: validNumber(raw.Current), Limit: validNumber(raw.Limit)}
		if raw.Percentage != nil && !math.IsNaN(*raw.Percentage) && !math.IsInf(*raw.Percentage, 0) && *raw.Percentage >= 0 {
			used := math.Min(100, *raw.Percentage)
			remaining := 100 - used
			w.UsedPercent, w.RemainingPercent = &used, &remaining
		}
		if raw.NextReset != nil && *raw.NextReset > 0 {
			stamp := *raw.NextReset
			if stamp > 100000000000 {
				stamp /= 1000
			}
			w.ResetsAt = &stamp
		}
		reading.Windows = append(reading.Windows, w)
	}
	return reading, nil
}

var moneyPattern = regexp.MustCompile(`^-?[0-9]+(?:\.[0-9]+)?$`)

func decimal(value string) bool { return len(value) <= 40 && moneyPattern.MatchString(value) }
func ParseDeepSeek(data []byte) (Reading, error) {
	var payload struct {
		Available *bool `json:"is_available"`
		Balances  []struct {
			Currency string `json:"currency"`
			Total    string `json:"total_balance"`
			Granted  string `json:"granted_balance"`
			ToppedUp string `json:"topped_up_balance"`
		} `json:"balance_infos"`
	}
	if json.Unmarshal(data, &payload) != nil || payload.Available == nil || len(payload.Balances) == 0 || len(payload.Balances) > 2 {
		return Reading{}, fail("unavailable", "服务未提供余额，稍后刷新查看")
	}
	reading := Reading{Windows: []Window{}, Balances: []Balance{}, Available: payload.Available}
	currencies := map[string]bool{}
	for _, b := range payload.Balances {
		if b.Currency != "CNY" && b.Currency != "USD" || currencies[b.Currency] || !decimal(b.Total) || !decimal(b.Granted) || !decimal(b.ToppedUp) {
			return Reading{}, fail("unavailable", "余额响应格式不正确，不显示推算金额")
		}
		currencies[b.Currency] = true
		reading.Balances = append(reading.Balances, Balance{b.Currency, b.Total, b.Granted, b.ToppedUp})
	}
	return reading, nil
}
func errorState(err error) (string, string) {
	var readErr *ReadError
	if errors.As(err, &readErr) {
		return readErr.State, readErr.Message
	}
	return "unavailable", "暂时无法查询，请稍后刷新"
}
