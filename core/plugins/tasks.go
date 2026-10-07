package plugins

import (
	"context"
	"errors"
	"panestra.local/panestra/core/security"
	"time"
)

// MarketTask keeps remote downloads outside the lifetime of a device HTTP request.
// Polling uses a separate lock so slow catalog requests cannot block task status.
type MarketTask struct {
	Token   string   `json:"token"`
	State   string   `json:"state"`
	Preview *Preview `json:"preview,omitempty"`
	Catalog *Catalog `json:"catalog,omitempty"`
	Error   string   `json:"error,omitempty"`
	device  string
	expires time.Time
}

func (m *Manager) BeginTask(action, id, device string) (MarketTask, error) {
	if action != "catalog" && action != "download" {
		return MarketTask{}, errors.New("unknown plugin market action")
	}
	if action == "download" && !validID.MatchString(id) {
		return MarketTask{}, errors.New("invalid plugin ID")
	}
	m.taskMu.Lock()
	if m.tasks == nil {
		m.tasks = map[string]*MarketTask{}
	}
	running := 0
	for token, task := range m.tasks {
		if task.State == "pending" {
			running++
		} else if time.Now().After(task.expires) {
			delete(m.tasks, token)
		}
	}
	if running >= 4 || len(m.tasks) >= 32 {
		m.taskMu.Unlock()
		return MarketTask{}, errors.New("请等待当前插件下载完成")
	}
	task := &MarketTask{Token: security.RandomToken(), State: "pending", device: device, expires: time.Now().Add(15 * time.Minute)}
	m.tasks[task.Token] = task
	initial := *task
	m.taskMu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(m.Context, 3*time.Minute)
		defer cancel()
		var preview *Preview
		var catalog *Catalog
		var err error
		if action == "download" {
			value, failure := m.Download(ctx, id, device)
			preview, err = &value, failure
		} else {
			value := m.Catalog(ctx, true)
			catalog = &value
		}
		m.taskMu.Lock()
		defer m.taskMu.Unlock()
		task.State = "complete"
		task.expires = time.Now().Add(15 * time.Minute)
		if err != nil {
			task.State, task.Error = "failed", err.Error()
		} else {
			task.Preview, task.Catalog = preview, catalog
		}
	}()
	return initial, nil
}

func (m *Manager) Task(token, device string) (MarketTask, error) {
	m.taskMu.Lock()
	defer m.taskMu.Unlock()
	task := m.tasks[token]
	if task == nil || task.device != device || time.Now().After(task.expires) {
		return MarketTask{}, errors.New("插件下载记录已过期，请重新下载")
	}
	return *task, nil
}
