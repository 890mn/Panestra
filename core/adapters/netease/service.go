package netease

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"panestra.local/panestra/core/security"
	"path/filepath"
	"sync"
	"time"
)

type Service struct {
	mu              sync.Mutex
	operation       sync.Mutex
	ctx             context.Context
	filename        string
	config          Config
	status          Status
	epoch, sequence uint64
	cancel          context.CancelFunc
	lastAttempt     time.Time
	publish         func(Status, uint64)
	media           Media
}

func blank(c Config) Status {
	state, message := "disabled", "启用读取后显示网易云音乐播放状态"
	if c.Enabled {
		state, message = "connecting", "正在读取网易云音乐媒体会话"
	}
	return Status{Enabled: c.Enabled, AllowControl: c.AllowControl, TimelinePort: c.TimelinePort, Reading: Reading{State: state, Message: message}}
}
func NewService(ctx context.Context, dir string, publish func(Status, uint64)) *Service {
	return newService(ctx, dir, publish, NewMedia(ctx))
}
func newService(ctx context.Context, dir string, publish func(Status, uint64), media Media) *Service {
	s := &Service{ctx: ctx, filename: filepath.Join(dir, "netease.protected"), publish: publish, media: media}
	failed := false
	if raw, err := os.ReadFile(s.filename); err == nil {
		plain, err := security.Unprotect(raw)
		if err != nil || json.Unmarshal(plain, &s.config) != nil || !validTimelinePort(s.config.TimelinePort) {
			s.config = Config{}
			failed = true
		}
	}
	if configurable, ok := media.(timelineConfigurer); ok {
		configurable.ConfigureTimeline(s.config.TimelinePort)
	}
	s.status = blank(s.config)
	if failed {
		s.status.State, s.status.Message = "storage_error", "无法解锁媒体设置，请重新配置"
	}
	s.mu.Lock()
	s.emitLocked()
	s.mu.Unlock()
	s.Refresh()
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				s.mu.Lock()
				if s.cancel != nil {
					s.cancel()
				}
				s.mu.Unlock()
				s.media.Close()
				return
			case <-ticker.C:
				s.refresh(false)
			}
		}
	}()
	return s
}
func (s *Service) cloneLocked() Status {
	status := s.status
	if status.PositionSeconds != nil {
		value := *status.PositionSeconds
		status.PositionSeconds = &value
	}
	if status.DurationSeconds != nil {
		value := *status.DurationSeconds
		status.DurationSeconds = &value
	}
	return status
}
func (s *Service) Snapshot() Status { s.mu.Lock(); defer s.mu.Unlock(); return s.cloneLocked() }
func (s *Service) emitLocked() {
	s.sequence++
	if s.publish != nil {
		s.publish(s.cloneLocked(), s.sequence)
	}
}
func save(filename string, c Config) error {
	plain, err := json.Marshal(c)
	if err != nil {
		return err
	}
	protected, err := security.Protect(plain)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(filename), "netease-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(protected)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(file.Name(), filename)
}
func (s *Service) Configure(change Change) (Status, error) {
	if change.Enabled == nil && change.AllowControl == nil && change.TimelinePort == nil {
		return Status{}, fmt.Errorf("未提供设置变更")
	}
	if change.TimelinePort != nil && !validTimelinePort(*change.TimelinePort) {
		return Status{}, fmt.Errorf("本机进度端口需为 1024–65535，设为 0 可关闭")
	}
	s.mu.Lock()
	next := s.config
	if change.Enabled != nil {
		next.Enabled = *change.Enabled
	}
	if change.AllowControl != nil {
		next.AllowControl = *change.AllowControl
	}
	if change.TimelinePort != nil {
		next.TimelinePort = *change.TimelinePort
	}
	if !next.Enabled {
		next.AllowControl = false
	}
	if err := save(s.filename, next); err != nil {
		s.mu.Unlock()
		return Status{}, fmt.Errorf("无法保存媒体设置")
	}
	s.epoch++
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.config = next
	if configurable, ok := s.media.(timelineConfigurer); ok {
		configurable.ConfigureTimeline(next.TimelinePort)
	}
	s.status = blank(next)
	s.lastAttempt = time.Time{}
	s.emitLocked()
	status := s.cloneLocked()
	s.mu.Unlock()
	if next.Enabled {
		s.Refresh()
	} else {
		go s.media.Close()
	}
	return status, nil
}
func (s *Service) acceptLocked(reading Reading, err error) {
	s.status.Refreshing = false
	if err == nil {
		if reading.State == "not_found" {
			reading = Reading{State: "not_found", Message: "未找到网易云音乐媒体会话，请打开播放器并启用系统媒体控制"}
		}
		if reading.State == "ready" {
			reading.Message = "已连接网易云音乐媒体会话"
		}
		s.status.Reading = reading
		s.status.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		s.status.Stale = false
	} else {
		var problem *Error
		state, message := "unavailable", "无法读取网易云音乐媒体状态"
		if errors.As(err, &problem) {
			state, message = problem.State, problem.Message
		}
		if state == "not_found" {
			s.status = blank(s.config)
			s.status.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
		}
		s.status.State, s.status.Message = state, message
		s.status.Stale = state != "not_found" && s.status.UpdatedAt != ""
		s.status.Controls = Controls{}
	}
	s.emitLocked()
}
func (s *Service) Refresh() { s.refresh(true) }
func (s *Service) refresh(manual bool) {
	if !s.operation.TryLock() {
		return
	}
	s.mu.Lock()
	interval := time.Second
	if !manual && s.status.State == "unavailable" {
		interval = 30 * time.Second
	}
	if !s.config.Enabled || s.status.Refreshing || time.Since(s.lastAttempt) < interval || s.ctx.Err() != nil {
		s.mu.Unlock()
		s.operation.Unlock()
		return
	}
	s.lastAttempt = time.Now()
	ctx, cancel := context.WithTimeout(s.ctx, 12*time.Second)
	s.cancel = cancel
	epoch := s.epoch
	s.status.Refreshing = true
	s.emitLocked()
	s.mu.Unlock()
	go func() {
		defer s.operation.Unlock()
		reading, err := s.media.Call(ctx, Action{Action: "read"})
		if err == nil {
			err = validReading(reading)
		}
		cancel()
		s.mu.Lock()
		defer s.mu.Unlock()
		if epoch != s.epoch || !s.config.Enabled || s.ctx.Err() != nil {
			return
		}
		s.cancel = nil
		s.acceptLocked(reading, err)
	}()
}
func (s *Service) Control(parent context.Context, action Action) error {
	if err := validAction(action); err != nil {
		return err
	}
	if !s.operation.TryLock() {
		return fail("busy", "播放器正在处理请求，请稍后重试")
	}
	defer s.operation.Unlock()
	s.mu.Lock()
	if !s.config.Enabled || !s.config.AllowControl {
		s.mu.Unlock()
		return fail("forbidden", "未授权网易云音乐播放控制")
	}
	epoch := s.epoch
	ctx, cancel := context.WithTimeout(parent, 8*time.Second)
	s.cancel = cancel
	s.mu.Unlock()
	defer cancel()
	reading, err := s.media.Call(ctx, action)
	if err == nil {
		err = validReading(reading)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if epoch != s.epoch || !s.config.Enabled || s.ctx.Err() != nil {
		return fail("forbidden", "媒体控制权限已更改")
	}
	s.cancel = nil
	s.acceptLocked(reading, err)
	return err
}
