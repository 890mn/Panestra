package codex

import (
	"context"
	"sync"
	"time"
)

var messages = map[string]string{
	"disabled":         "开启后读取 Core 电脑上已登录的 Codex 订阅额度",
	"connecting":       "正在读取本机 Codex 额度",
	"ready":            "已同步订阅额度",
	"not_found":        "未找到 Codex，请在 Core 电脑安装 Codex 桌面版或官方 CLI",
	"needs_login":      "请在 Core 电脑的 Codex 中登录 ChatGPT 账号",
	"unsupported_auth": "当前登录方式没有 ChatGPT 订阅额度，请切换为 ChatGPT 登录",
	"incompatible":     "当前 Codex 版本不支持额度接口，请更新 Codex",
	"unavailable":      "暂时无法读取额度，请检查 Core 电脑的网络后重试",
}

type Service struct {
	mu          sync.Mutex
	ctx         context.Context
	status      Status
	epoch       uint64
	sequence    uint64
	cancel      context.CancelFunc
	lastAttempt time.Time
	fetch       func(context.Context) (Reading, error)
	publish     func(Status, uint64)
}

func NewService(ctx context.Context, publish func(Status, uint64)) *Service {
	s := &Service{ctx: ctx, fetch: Read, publish: publish, status: emptyStatus(false)}
	s.mu.Lock()
	s.emitLocked()
	s.mu.Unlock()
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				s.SetEnabled(false)
				return
			case <-ticker.C:
				s.Refresh()
			}
		}
	}()
	return s
}
func emptyStatus(enabled bool) Status {
	state := "disabled"
	if enabled {
		state = "connecting"
	}
	return Status{Enabled: enabled, State: state, Message: messages[state], Buckets: []Bucket{}, PollIntervalSeconds: 60}
}
func (s *Service) Snapshot() Status { s.mu.Lock(); defer s.mu.Unlock(); return s.status }
func (s *Service) emitLocked() {
	s.sequence++
	if s.publish != nil {
		s.publish(s.status, s.sequence)
	}
}
func (s *Service) SetEnabled(enabled bool) {
	s.mu.Lock()
	if enabled == s.status.Enabled {
		s.mu.Unlock()
		return
	}
	s.epoch++
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.status = emptyStatus(enabled)
	s.lastAttempt = time.Time{}
	s.emitLocked()
	s.mu.Unlock()
	if enabled {
		s.Refresh()
	}
}
func (s *Service) Refresh() {
	s.mu.Lock()
	if !s.status.Enabled || s.status.Refreshing || time.Since(s.lastAttempt) < 15*time.Second || s.ctx.Err() != nil {
		s.mu.Unlock()
		return
	}
	s.lastAttempt = time.Now()
	ctx, cancel := context.WithTimeout(s.ctx, 20*time.Second)
	s.cancel = cancel
	epoch := s.epoch
	s.status.Refreshing = true
	s.emitLocked()
	s.mu.Unlock()
	go func() {
		reading, err := s.fetch(ctx)
		cancel()
		s.mu.Lock()
		defer s.mu.Unlock()
		if epoch != s.epoch || !s.status.Enabled {
			return
		}
		s.cancel = nil
		s.status.Refreshing = false
		if err == nil {
			s.status.State = "ready"
			s.status.Message = messages["ready"]
			s.status.Stale = false
			s.status.PlanType = reading.PlanType
			s.status.Buckets = reading.Buckets
			s.status.ResetCredits = reading.ResetCredits
			s.status.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		} else {
			state := stateFor(err)
			if state == "needs_login" || state == "unsupported_auth" {
				s.status = emptyStatus(true)
			}
			s.status.State = state
			s.status.Message = messages[state]
			s.status.Stale = s.status.UpdatedAt != ""
		}
		s.emitLocked()
	}()
}
