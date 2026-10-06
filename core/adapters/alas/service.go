package alas

import (
	"context"
	_ "embed"
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

//go:embed bridge.py
var bridgeScript []byte

type Service struct {
	mu                  sync.Mutex
	ctx                 context.Context
	filename, bridgeDir string
	config              Config
	status              Status
	epoch, sequence     uint64
	cancel              context.CancelFunc
	lastAttempt         time.Time
	publish             func(Status, uint64)
	fetch               func(context.Context, Config) (Reading, error)
}

func defaultConfig() Config { return Config{Port: 22267, Instance: "alas"} }
func (s *Service) launcher(c Config) string {
	return filepath.Join(s.bridgeDir, c.BridgeID, "start-alas.ps1")
}
func (s *Service) prepared(c Config) bool {
	if c.BridgeID == "" {
		return false
	}
	_, err := os.Stat(s.launcher(c))
	return err == nil
}
func (s *Service) blank(c Config) Status {
	state, message := "disabled", "启用读取后显示 ALAS 实例状态"
	if c.Enabled {
		state, message = "connecting", "正在读取 ALAS 本机桥接"
	}
	return Status{Enabled: c.Enabled, Prepared: s.prepared(c), HasConfiguration: c.Root != "" && c.Secret != "", Instance: c.Instance, State: state, Message: message, Instances: []Instance{}}
}
func NewService(ctx context.Context, dir string, publish func(Status, uint64)) *Service {
	s := &Service{ctx: ctx, filename: filepath.Join(dir, "alas.protected"), bridgeDir: filepath.Join(dir, "alas-bridge"), config: defaultConfig(), publish: publish, fetch: Read}
	failed := false
	if raw, err := os.ReadFile(s.filename); err == nil {
		plain, err := security.Unprotect(raw)
		if err != nil || json.Unmarshal(plain, &s.config) != nil {
			s.config = defaultConfig()
			failed = true
		}
	}
	s.status = s.blank(s.config)
	if failed {
		s.status.State, s.status.Message = "storage_error", "无法解锁 ALAS 桥接设置，请重新配置"
	}
	s.mu.Lock()
	s.emitLocked()
	s.mu.Unlock()
	s.Refresh()
	go func() {
		ticker := time.NewTicker(3 * time.Second)
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
	status.Instances = append([]Instance{}, status.Instances...)
	for i := range status.Instances {
		status.Instances[i].Tasks = append([]Task{}, status.Instances[i].Tasks...)
	}
	return status
}
func (s *Service) Snapshot() Status { s.mu.Lock(); defer s.mu.Unlock(); return s.cloneLocked() }
func (s *Service) Setup() Setup {
	s.mu.Lock()
	defer s.mu.Unlock()
	launcher := ""
	prepared := s.prepared(s.config)
	if prepared {
		launcher = s.launcher(s.config)
	}
	return Setup{Root: s.config.Root, Port: s.config.Port, Instance: s.config.Instance, Launcher: launcher, Prepared: prepared}
}
func (s *Service) emitLocked() {
	s.sequence++
	if s.publish != nil {
		s.publish(s.cloneLocked(), s.sequence)
	}
}
func atomicFile(filename string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(filename), "alas-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	closed := file.Close()
	if err == nil {
		err = closed
	}
	if err != nil {
		return err
	}
	return os.Rename(file.Name(), filename)
}
func rootPath(value string) (string, error) {
	value = strings.TrimSpace(value)
	if !filepath.IsAbs(value) || len(value) > 4096 || strings.ContainsAny(value, "\r\n\x00") {
		return "", fmt.Errorf("请填写 Core 电脑上的 ALAS 绝对目录")
	}
	root, err := filepath.EvalSymlinks(filepath.Clean(value))
	if err != nil {
		return "", fmt.Errorf("ALAS 目录不存在")
	}
	for _, name := range []string{"gui.py", filepath.Join("module", "webui", "process_manager.py")} {
		info, err := os.Stat(filepath.Join(root, name))
		if err != nil || !info.Mode().IsRegular() {
			return "", fmt.Errorf("目录中未找到完整 ALAS WebUI")
		}
	}
	if _, err := pythonPath(root); err != nil {
		return "", err
	}
	return root, nil
}
func pythonPath(root string) (string, error) {
	for _, name := range []string{filepath.Join("toolkit", "python.exe"), filepath.Join("venv", "Scripts", "python.exe"), filepath.Join(".venv", "Scripts", "python.exe")} {
		file := filepath.Join(root, name)
		if info, err := os.Stat(file); err == nil && info.Mode().IsRegular() {
			return file, nil
		}
	}
	return "", fmt.Errorf("未找到 ALAS 自带或项目虚拟环境中的 Python")
}
func psLiteral(value string) string { return "'" + strings.ReplaceAll(value, "'", "''") + "'" }
func (s *Service) prepare(c Config) error {
	python, err := pythonPath(c.Root)
	if err != nil {
		return err
	}
	dir := filepath.Join(s.bridgeDir, c.BridgeID)
	if err = atomicFile(filepath.Join(dir, "bridge.py"), bridgeScript); err != nil {
		return fmt.Errorf("无法生成 ALAS 桥接代码")
	}
	script := "$ErrorActionPreference = 'Stop'\r\n# Stop the existing ALAS application before launching this bridge.\r\n# Original configured task startup and reload remain enabled.\r\n& " + psLiteral(python) + " " + psLiteral(filepath.Join(dir, "bridge.py")) + " --root " + psLiteral(c.Root) + " --secret-file " + psLiteral(s.filename) + " --port " + fmt.Sprint(c.Port) + "\r\nif ($LASTEXITCODE -ne 0) { throw 'ALAS bridge stopped with an error' }\r\n"
	// Windows PowerShell reads a UTF-8 BOM correctly, including non-ASCII install paths.
	if err = atomicFile(s.launcher(c), append([]byte{0xef, 0xbb, 0xbf}, []byte(script)...)); err != nil {
		return fmt.Errorf("无法生成 ALAS 桥接启动文件")
	}
	return nil
}
func (s *Service) Configure(change Change, prepare bool) (Status, error) {
	if change.Enabled == nil && change.Root == nil && change.Port == nil && change.Instance == nil && !change.ClearConfiguration {
		return Status{}, fmt.Errorf("未提供桥接设置")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.config
	if change.Root != nil {
		root, err := rootPath(*change.Root)
		if err != nil {
			return Status{}, err
		}
		if !strings.EqualFold(root, next.Root) {
			next.Secret, next.BridgeID = security.RandomToken(), security.RandomToken()
		}
		next.Root = root
	}
	if change.Port != nil {
		if *change.Port < 1 || *change.Port > 65535 {
			return Status{}, fmt.Errorf("ALAS 端口须为 1–65535")
		}
		next.Port = *change.Port
	}
	if change.Instance != nil {
		if !label.MatchString(*change.Instance) {
			return Status{}, fmt.Errorf("实例名称须为 1–80 位字母、数字、下划线或连字符")
		}
		next.Instance = *change.Instance
	}
	if change.Enabled != nil {
		next.Enabled = *change.Enabled
	}
	if change.ClearConfiguration {
		next = defaultConfig()
	}
	if !prepare && !change.ClearConfiguration && (next.Root != s.config.Root || next.Port != s.config.Port) {
		return Status{}, fmt.Errorf("修改目录或端口后须重新生成桥接启动文件")
	}
	if prepare {
		if next.Root == "" {
			return Status{}, fmt.Errorf("请先选择 ALAS 目录")
		}
		if next.Secret == "" || next.BridgeID == "" || next.Root != s.config.Root || next.Port != s.config.Port {
			next.Secret, next.BridgeID = security.RandomToken(), security.RandomToken()
		}
		if err := s.prepare(next); err != nil {
			return Status{}, err
		}
	}
	if next.Enabled && !s.prepared(next) {
		return Status{}, fmt.Errorf("请先生成 ALAS 本机桥接启动文件")
	}
	plain, err := json.Marshal(next)
	if err != nil {
		return Status{}, fmt.Errorf("桥接设置无效")
	}
	protected, err := security.Protect(plain)
	if err != nil {
		return Status{}, fmt.Errorf("无法保护 ALAS 桥接设置")
	}
	if err = atomicFile(s.filename, protected); err != nil {
		return Status{}, fmt.Errorf("无法保存 ALAS 桥接设置")
	}
	s.epoch++
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	s.config = next
	s.status = s.blank(next)
	s.lastAttempt = time.Time{}
	s.emitLocked()
	status := s.cloneLocked()
	if next.Enabled {
		go s.Refresh()
	}
	return status, nil
}
func (s *Service) Refresh() {
	s.mu.Lock()
	if !s.config.Enabled || s.status.Refreshing || time.Since(s.lastAttempt) < time.Second || s.ctx.Err() != nil {
		s.mu.Unlock()
		return
	}
	s.lastAttempt = time.Now()
	ctx, cancel := context.WithTimeout(s.ctx, 6*time.Second)
	s.cancel = cancel
	epoch, c := s.epoch, s.config
	s.status.Refreshing = true
	s.emitLocked()
	s.mu.Unlock()
	go func() {
		reading, err := s.fetch(ctx, c)
		cancel()
		s.mu.Lock()
		defer s.mu.Unlock()
		if epoch != s.epoch || !s.config.Enabled || s.ctx.Err() != nil {
			return
		}
		s.cancel = nil
		s.status.Refreshing = false
		if err == nil {
			s.status.Instances = reading.Instances
			s.status.ObservedAt = reading.ObservedAt
			s.status.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
			s.status.Stale = false
			s.status.State, s.status.Message = "ready", "已连接 ALAS 本机桥接"
			found := false
			for _, instance := range reading.Instances {
				found = found || instance.Name == c.Instance
			}
			if !found {
				s.status.State, s.status.Message = "instance_missing", "此实例尚未在 ALAS WebUI 中载入，状态未知"
			}
		}
		if err != nil {
			state, message := "unavailable", "无法读取 ALAS 本机桥接"
			var problem *Error
			if errors.As(err, &problem) {
				state, message = problem.State, problem.Message
			}
			if state == "bridge_required" {
				s.status = s.blank(c)
			}
			s.status.State, s.status.Message = state, message
			s.status.Stale = s.status.UpdatedAt != ""
		}
		s.emitLocked()
	}()
}
