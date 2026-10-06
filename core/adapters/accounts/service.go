package accounts

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"panestra.local/panestra/core/security"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type Config struct {
	Enabled bool   `json:"enabled"`
	APIKey  string `json:"apiKey"`
}
type Change struct {
	Enabled         *bool   `json:"enabled"`
	APIKey          *string `json:"apiKey"`
	ClearCredential bool    `json:"clearCredential"`
}
type Service struct {
	mu          sync.Mutex
	ctx         context.Context
	id          string
	filename    string
	config      Config
	status      Status
	epoch       uint64
	sequence    uint64
	cancel      context.CancelFunc
	lastAttempt time.Time
	fetch       func(context.Context, string, string) (Reading, error)
	publish     func(Status, uint64)
}

func emptyStatus(id string, c Config) Status {
	state, message := "disabled", "配置并开启后查询账号用量"
	if c.Enabled {
		state, message = "connecting", "正在查询账号用量"
	}
	if c.Enabled && c.APIKey == "" {
		state, message = "needs_credential", "请先配置 API Key"
	}
	return Status{ID: id, Enabled: c.Enabled, HasCredential: c.APIKey != "", State: state, Message: message, PollIntervalSeconds: 300, Reading: Reading{Windows: []Window{}, Balances: []Balance{}}}
}
func NewService(ctx context.Context, id, dir string, publish func(Status, uint64)) *Service {
	s := &Service{ctx: ctx, id: id, filename: filepath.Join(dir, id+".protected"), fetch: Read, publish: publish}
	loadFailed := false
	if raw, err := os.ReadFile(s.filename); err == nil {
		plain, err := security.Unprotect(raw)
		if err != nil || json.Unmarshal(plain, &s.config) != nil {
			loadFailed = true
			s.config = Config{}
		}
	} else if !os.IsNotExist(err) {
		loadFailed = true
	}
	s.status = emptyStatus(id, s.config)
	if loadFailed {
		s.status.State, s.status.Message = "storage_error", "无法解锁本机凭据，请重新配置 API Key"
	}
	s.mu.Lock()
	s.emitLocked()
	s.mu.Unlock()
	s.Refresh()
	go func() {
		ticker := time.NewTicker(5 * time.Minute)
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
func (s *Service) Snapshot() Status { s.mu.Lock(); defer s.mu.Unlock(); return s.cloneLocked() }
func (s *Service) cloneLocked() Status {
	status := s.status
	status.Windows = append([]Window{}, status.Windows...)
	status.Balances = append([]Balance{}, status.Balances...)
	return status
}
func (s *Service) emitLocked() {
	s.sequence++
	if s.publish != nil {
		s.publish(s.cloneLocked(), s.sequence)
	}
}
func (s *Service) Configure(change Change) (Status, error) {
	s.mu.Lock()
	next := s.config
	if change.Enabled != nil {
		next.Enabled = *change.Enabled
	}
	if change.APIKey != nil {
		key := strings.TrimSpace(*change.APIKey)
		if len(key) == 0 || len(key) > 4096 || strings.ContainsAny(key, "\r\n\x00") {
			s.mu.Unlock()
			return Status{}, fmt.Errorf("API Key 不能为空或包含换行")
		}
		next.APIKey = key
	}
	if change.ClearCredential {
		next.APIKey = ""
		next.Enabled = false
	}
	if next.Enabled && next.APIKey == "" {
		s.mu.Unlock()
		return Status{}, fmt.Errorf("请先填写 API Key")
	}
	if change.Enabled == nil && change.APIKey == nil && !change.ClearCredential {
		s.mu.Unlock()
		return Status{}, fmt.Errorf("未提供配置变更")
	}
	plain, err := json.Marshal(next)
	if err == nil {
		var protected []byte
		protected, err = security.Protect(plain)
		if err == nil {
			err = writeAtomic(s.filename, protected)
		}
	}
	if err != nil {
		s.mu.Unlock()
		return Status{}, fmt.Errorf("无法保存本机凭据，配置未更改")
	}
	s.epoch++
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.config = next
	s.status = emptyStatus(s.id, next)
	s.lastAttempt = time.Time{}
	s.emitLocked()
	status := s.cloneLocked()
	s.mu.Unlock()
	if next.Enabled {
		s.Refresh()
	}
	return status, nil
}
func writeAtomic(filename string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(filename), "credential-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(temp.Name())
	if err = temp.Chmod(0600); err == nil {
		_, err = temp.Write(data)
	}
	if err == nil {
		err = temp.Sync()
	}
	closeErr := temp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return os.Rename(temp.Name(), filename)
}
func (s *Service) Refresh() {
	s.mu.Lock()
	if !s.config.Enabled || s.config.APIKey == "" || s.status.Refreshing || time.Since(s.lastAttempt) < 15*time.Second || s.ctx.Err() != nil {
		s.mu.Unlock()
		return
	}
	s.lastAttempt = time.Now()
	ctx, cancel := context.WithTimeout(s.ctx, 20*time.Second)
	s.cancel = cancel
	epoch, key := s.epoch, s.config.APIKey
	s.status.Refreshing = true
	s.emitLocked()
	s.mu.Unlock()
	go func() {
		reading, err := s.fetch(ctx, s.id, key)
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
			s.status.State = "ready"
			s.status.Message = "已同步账号用量"
			s.status.Stale = false
			s.status.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
		} else {
			state, message := errorState(err)
			if state == "needs_credential" {
				s.status = emptyStatus(s.id, s.config)
			}
			s.status.State, s.status.Message = state, message
			s.status.Stale = s.status.UpdatedAt != ""
		}
		s.emitLocked()
	}()
}
