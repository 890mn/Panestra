package clash

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"panestra.local/panestra/core/security"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Service struct {
	mu                   sync.Mutex
	ctx                  context.Context
	filename, configHome string
	config               Config
	status               Status
	epoch, sequence      uint64
	cancel               context.CancelFunc
	lastAttempt          time.Time
	publish              func(Status, uint64)
	fetch                func(context.Context, Config) (Reading, error)
	execute              func(context.Context, Config, Action) error
}

func blank(c Config) Status {
	state, message := "disabled", "开启读取后显示本机代理状态"
	if c.Enabled {
		state, message = "connecting", "正在读取本机控制器"
	}
	return Status{Enabled: c.Enabled, AllowControl: c.AllowControl, AutoDetect: c.AutoDetect, Controller: c.Controller, HasCredential: c.Secret != "", State: state, Message: message, Reading: Reading{Groups: []Group{}}}
}
func NewService(ctx context.Context, dir string, publish func(Status, uint64)) *Service {
	home, _ := os.UserConfigDir()
	s := &Service{ctx: ctx, filename: filepath.Join(dir, "clash.protected"), configHome: home, config: Config{AutoDetect: true}, publish: publish, fetch: Read, execute: Execute}
	failed := false
	if raw, err := os.ReadFile(s.filename); err == nil {
		plain, err := security.Unprotect(raw)
		if err != nil || json.Unmarshal(plain, &s.config) != nil {
			s.config = Config{AutoDetect: true}
			failed = true
		}
	}
	s.status = blank(s.config)
	if failed {
		s.status.State, s.status.Message = "storage_error", "无法解锁本机控制器配置，请重新配置"
	}
	s.mu.Lock()
	s.emitLocked()
	s.mu.Unlock()
	s.Refresh()
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				s.mu.Lock()
				if s.cancel != nil {
					s.cancel()
				}
				s.mu.Unlock()
				return
			case <-ticker.C:
				s.Refresh()
			}
		}
	}()
	return s
}
func (s *Service) cloneLocked() Status {
	status := s.status
	status.Groups = append([]Group{}, status.Groups...)
	for index := range status.Groups {
		status.Groups[index].Options = append([]string{}, status.Groups[index].Options...)
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
	file, err := os.CreateTemp(filepath.Dir(filename), "clash-*.tmp")
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
	closeError := file.Close()
	if err == nil {
		err = closeError
	}
	if err != nil {
		return err
	}
	return os.Rename(file.Name(), filename)
}
func (s *Service) Configure(change Change) (Status, error) {
	s.mu.Lock()
	next := s.config
	if change.Enabled != nil {
		next.Enabled = *change.Enabled
	}
	if change.AllowControl != nil {
		next.AllowControl = *change.AllowControl
	}
	if change.AutoDetect != nil {
		next.AutoDetect = *change.AutoDetect
	}
	if change.Controller != nil {
		address, err := Controller(*change.Controller)
		if err != nil {
			s.mu.Unlock()
			return Status{}, err
		}
		next.Controller = address
	}
	if change.Secret != nil {
		secret := strings.TrimSpace(*change.Secret)
		if len(secret) > 4096 || strings.ContainsAny(secret, "\r\n\x00") {
			s.mu.Unlock()
			return Status{}, fmt.Errorf("Secret 无效")
		}
		next.Secret = secret
	}
	if change.ClearCredential {
		next.Secret = ""
		next.Enabled = false
		next.AllowControl = false
	}
	if change.Enabled == nil && change.AllowControl == nil && change.AutoDetect == nil && change.Controller == nil && change.Secret == nil && !change.ClearCredential {
		s.mu.Unlock()
		return Status{}, fmt.Errorf("未提供配置变更")
	}
	if !next.AutoDetect && next.Enabled {
		if _, err := Controller(next.Controller); err != nil {
			s.mu.Unlock()
			return Status{}, err
		}
	}
	if err := save(s.filename, next); err != nil {
		s.mu.Unlock()
		return Status{}, fmt.Errorf("无法保存本机控制器配置")
	}
	s.epoch++
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.config = next
	s.status = blank(next)
	s.lastAttempt = time.Time{}
	s.emitLocked()
	status := s.cloneLocked()
	s.mu.Unlock()
	if next.Enabled {
		s.Refresh()
	}
	return status, nil
}
func (s *Service) resolved(c Config) (Config, error) {
	if c.AutoDetect {
		found, err := Detect(s.configHome)
		if err != nil {
			return c, err
		}
		c.Controller, c.Secret = found.Controller, found.Secret
	}
	return c, nil
}
func (s *Service) Refresh() {
	s.mu.Lock()
	if !s.config.Enabled || s.status.Refreshing || time.Since(s.lastAttempt) < time.Second || s.ctx.Err() != nil {
		s.mu.Unlock()
		return
	}
	s.lastAttempt = time.Now()
	ctx, cancel := context.WithTimeout(s.ctx, 12*time.Second)
	s.cancel = cancel
	epoch, configuration := s.epoch, s.config
	s.status.Refreshing = true
	s.emitLocked()
	s.mu.Unlock()
	go func() {
		c, err := s.resolved(configuration)
		var reading Reading
		if err == nil {
			reading, err = s.fetch(ctx, c)
		}
		cancel()
		s.mu.Lock()
		defer s.mu.Unlock()
		if epoch != s.epoch || !s.config.Enabled || s.ctx.Err() != nil {
			return
		}
		s.cancel = nil
		s.status.Refreshing = false
		if err == nil {
			s.status.Reading = reading
			s.status.Controller = c.Controller
			s.status.HasCredential = c.Secret != ""
			s.status.State = "ready"
			s.status.Message = "已连接本机 Mihomo 控制器"
			s.status.Stale = false
			s.status.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		} else {
			var problem *ReadError
			state, message := "unavailable", "无法连接本机 Mihomo 控制器"
			if errors.As(err, &problem) {
				state, message = problem.State, problem.Message
			}
			if state == "needs_credential" {
				s.status = blank(configuration)
			}
			s.status.State, s.status.Message = state, message
			s.status.Stale = s.status.UpdatedAt != ""
		}
		s.emitLocked()
	}()
}
func (s *Service) Control(parent context.Context, action Action) error {
	if !s.mu.TryLock() {
		return fail("busy", "控制器正在处理请求，请稍后重试")
	}
	defer s.mu.Unlock()
	if !s.config.Enabled || !s.config.AllowControl {
		return fail("forbidden", "未授权 Clash 控制")
	}
	ctx, cancel := context.WithTimeout(parent, 6*time.Second)
	defer cancel()
	c, err := s.resolved(s.config)
	if err == nil {
		err = s.execute(ctx, c, action)
	}
	// Invalidate an older poll result so it cannot overwrite the state after switching.
	s.epoch++
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.status.Refreshing = false
	s.lastAttempt = time.Time{}
	if err == nil {
		s.status.Stale = s.status.UpdatedAt != ""
		s.status.Message = "操作已提交，正在确认控制器状态"
		s.emitLocked()
	}
	return err
}
