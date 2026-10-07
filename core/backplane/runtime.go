package backplane

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"panestra.local/panestra/core/security"
	"panestra.local/panestra/core/store"
	"sync"
	"sync/atomic"
	"time"
)

type Telemetry struct {
	Type  string `json:"type"`
	Topic string `json:"topic"`
	Seq   uint64 `json:"seq"`
	TS    string `json:"ts"`
	Value any    `json:"value"`
}
type Runtime struct {
	Store       *store.Store
	Manifest    Manifest
	Digest      string
	Binary      string
	DataDir     string
	Publish     func(Telemetry)
	mu          sync.Mutex
	frame       *Framer
	process     *exec.Cmd
	pending     map[string]chan Message
	status      string
	restarts    int
	seq         atomic.Uint64
	cancel      context.CancelFunc
	done        chan struct{}
	health      time.Time
	grants      map[string]bool
	next        atomic.Pointer[Runtime]
	switchMu    sync.Mutex
	healthReply time.Time
}

func NewRuntime(s *store.Store, binary string, manifestBytes []byte, persist ...bool) (*Runtime, error) {
	m, err := ParseManifest(manifestBytes)
	if err != nil {
		return nil, err
	}
	r := &Runtime{Store: s, Manifest: m, Digest: security.Hash(string(manifestBytes)), Binary: binary, pending: map[string]chan Message{}, status: "stopped", grants: map[string]bool{}}
	s.Mu.Lock()
	defer s.Mu.Unlock()
	if len(persist) == 0 || persist[0] {
		if _, err = s.DB.Exec("INSERT INTO plugins VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,manifest_digest=excluded.manifest_digest,data=excluded.data", m.ID, m.Version, "stopped", r.Digest, string(manifestBytes)); err != nil {
			return nil, err
		}
	}
	for _, p := range m.Permissions {
		var granted bool
		s.DB.QueryRow("SELECT granted FROM plugin_permissions WHERE plugin_id=? AND capability=?", m.ID, p.ID).Scan(&granted)
		r.grants[p.ID] = granted
	}
	return r, nil
}

func (r *Runtime) PrepareGrants(consent []string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, cap := range consent {
		if _, exists := r.grants[cap]; !exists {
			return errors.New("permission not declared")
		}
		r.grants[cap] = true
	}
	return nil
}

func (r *Runtime) RequiredGranted() bool {
	for _, permission := range r.Manifest.Permissions {
		if permission.Required && !r.Granted(permission.ID) {
			return false
		}
	}
	return true
}
func (r *Runtime) Grant(cap string, granted bool) error {
	r.switchMu.Lock()
	defer r.switchMu.Unlock()
	if next := r.next.Load(); next != nil {
		return next.Grant(cap, granted)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	known := false
	for _, p := range r.Manifest.Permissions {
		if p.ID == cap {
			known = true
		}
	}
	if !known || (r.Manifest.SchemaVersion == 1 && !KnownCapabilities[cap]) {
		return errors.New("capability not declared")
	}
	r.Store.Mu.Lock()
	defer r.Store.Mu.Unlock()
	_, err := r.Store.DB.Exec("INSERT INTO plugin_permissions VALUES(?,?,?) ON CONFLICT(plugin_id,capability) DO UPDATE SET granted=excluded.granted", r.Manifest.ID, cap, granted)
	if err == nil {
		r.grants[cap] = granted
	}
	return err
}
func (r *Runtime) Granted(cap string) bool {
	if next := r.next.Load(); next != nil {
		return next.Granted(cap)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.grants[cap]
}
func (r *Runtime) Status() map[string]any {
	if next := r.next.Load(); next != nil {
		return next.Status()
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	grants := map[string]bool{}
	for k, v := range r.grants {
		grants[k] = v
	}
	return map[string]any{"id": r.Manifest.ID, "name": r.Manifest.Name, "version": r.Manifest.Version, "status": r.status, "restarts": r.restarts, "permissions": grants, "manifest": r.Manifest, "pid": func() int {
		if r.process != nil && r.process.Process != nil {
			return r.process.Process.Pid
		}
		return 0
	}()}
}
func (r *Runtime) Start(ctx context.Context) error {
	r.switchMu.Lock()
	defer r.switchMu.Unlock()
	if next := r.next.Load(); next != nil {
		return next.Start(ctx)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.cancel != nil {
		return nil
	}
	for _, p := range r.Manifest.Permissions {
		if p.Required && !r.grants[p.ID] {
			return fmt.Errorf("grant required capability first: %s", p.ID)
		}
	}
	runCtx, cancel := context.WithCancel(ctx)
	r.cancel = cancel
	r.done = make(chan struct{})
	go r.supervise(runCtx)
	return nil
}
func (r *Runtime) Stop() {
	r.switchMu.Lock()
	defer r.switchMu.Unlock()
	if next := r.next.Load(); next != nil {
		next.Stop()
		return
	}
	r.stopCurrent()
}
func (r *Runtime) stopCurrent() {
	r.mu.Lock()
	cancel, done := r.cancel, r.done
	r.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
	r.mu.Lock()
	r.cancel = nil
	r.status = "stopped"
	r.mu.Unlock()
}
func (r *Runtime) CrashForTest() {
	if next := r.next.Load(); next != nil {
		next.CrashForTest()
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.process != nil && r.process.Process != nil {
		r.process.Process.Kill()
	}
}
func (r *Runtime) supervise(ctx context.Context) {
	defer close(r.done)
	backoff := time.Second
	for {
		started := time.Now()
		err := r.run(ctx)
		if ctx.Err() != nil {
			return
		}
		r.mu.Lock()
		r.status = "recovering"
		r.restarts++
		r.mu.Unlock()
		slog.Warn("plugin exited", "plugin", r.Manifest.ID, "error", err, "restartIn", backoff)
		r.Store.Audit("core", "plugin.crash", r.Manifest.ID, "restarting", "")
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if time.Since(started) > 30*time.Second {
			backoff = time.Second
		} else {
			backoff *= 2
			if backoff > 30*time.Second {
				backoff = 30 * time.Second
			}
		}
	}
}
func (r *Runtime) run(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, r.Binary)
	cmd.Env = []string{"SystemRoot=" + os.Getenv("SystemRoot"), "WINDIR=" + os.Getenv("WINDIR"), "PANESTRA_MANIFEST_DIGEST=" + r.Digest, "PANESTRA_PLUGIN_ID=" + r.Manifest.ID, "PANESTRA_PLUGIN_VERSION=" + r.Manifest.Version}
	for _, key := range []string{"USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemDrive", "TEMP", "TMP", "PATH", "PATHEXT", "PANESTRA_CODEX_EXECUTABLE"} {
		if value := os.Getenv(key); value != "" {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	cmd.Env = append(cmd.Env, "PANESTRA_PLUGIN_DATA="+r.DataDir)
	in, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		return err
	}
	closeJob, err := AttachJob(cmd.Process.Pid, r.Manifest.Engine.MaxChildren)
	if err != nil {
		cmd.Process.Kill()
		cmd.Wait()
		return err
	}
	defer closeJob()
	defer func() { cmd.Process.Kill(); cmd.Wait() }()
	f := &Framer{R: out, W: in}
	r.mu.Lock()
	r.process = cmd
	r.frame = f
	r.status = "starting"
	r.health = time.Now()
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		r.frame = nil
		r.process = nil
		for id, ch := range r.pending {
			select {
			case ch <- Message{Error: "worker disconnected"}:
			default:
			}
			delete(r.pending, id)
		}
		r.mu.Unlock()
	}()
	deadline := time.AfterFunc(5*time.Second, func() { cmd.Process.Kill() })
	hello, err := f.Read()
	deadline.Stop()
	if err != nil {
		return err
	}
	var h struct {
		PluginID string `json:"pluginId"`
		Version  string `json:"version"`
		Protocol int    `json:"protocolVersion"`
		Digest   string `json:"manifestDigest"`
	}
	if err = json.Unmarshal(hello.Params, &h); err != nil || hello.Method != "hello" || h.PluginID != r.Manifest.ID || h.Version != r.Manifest.Version || h.Protocol != 1 || h.Digest != r.Digest {
		return errors.New("plugin Hello mismatch")
	}
	r.mu.Lock()
	grants := []string{}
	for k, v := range r.grants {
		if v {
			grants = append(grants, k)
		}
	}
	r.status = "running"
	r.mu.Unlock()
	if err = f.Write(Message{ID: hello.ID, Result: Raw(map[string]any{"protocolVersion": 1, "grantedCapabilities": grants})}); err != nil {
		return err
	}
	watchCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		tick := time.NewTicker(2 * time.Second)
		defer tick.Stop()
		for {
			select {
			case <-watchCtx.Done():
				return
			case <-tick.C:
				r.mu.Lock()
				health := r.health
				r.mu.Unlock()
				if time.Since(health) > 6*time.Second {
					cmd.Process.Kill()
					return
				}
				if f.Write(Message{Method: "health"}) != nil {
					return
				}
			}
		}
	}()
	allowed := map[string]bool{}
	for _, s := range r.Manifest.Sources {
		allowed[s.ID] = true
	}
	last := map[string]time.Time{}
	window := time.Now()
	messages := 0
	for {
		m, err := f.Read()
		if err != nil {
			return err
		}
		messages++
		if time.Since(window) > time.Second {
			messages = 1
			window = time.Now()
		}
		if messages > 100 {
			return errors.New("plugin IPC rate limit")
		}
		if m.Method == "health" {
			r.mu.Lock()
			r.health = time.Now()
			r.healthReply = r.health
			r.mu.Unlock()
			continue
		}
		if m.Method == "publish" {
			if r.Manifest.SchemaVersion == 1 && !r.Granted("system.metrics.read") {
				continue
			}
			var p struct {
				Source string `json:"source"`
				Value  any    `json:"value"`
			}
			if json.Unmarshal(m.Params, &p) != nil || !allowed[p.Source] {
				return errors.New("unregistered telemetry topic")
			}
			if r.Manifest.SchemaVersion == 1 && time.Since(last[p.Source]) < 250*time.Millisecond {
				continue
			}
			last[p.Source] = time.Now()
			if r.Publish != nil {
				r.Publish(Telemetry{Type: "telemetry", Topic: r.Manifest.ID + "/" + p.Source, Seq: r.seq.Add(1), TS: time.Now().UTC().Format(time.RFC3339Nano), Value: p.Value})
			}
			continue
		}
		if m.Method != "" {
			return errors.New("unsupported worker method")
		}
		r.mu.Lock()
		ch := r.pending[m.ID]
		delete(r.pending, m.ID)
		r.mu.Unlock()
		if ch != nil {
			ch <- m
		}
	}
}
func (r *Runtime) Invoke(ctx context.Context, action string) error {
	if next := r.next.Load(); next != nil {
		return next.Invoke(ctx, action)
	}
	var definition *Action
	for _, a := range r.Manifest.Actions {
		if a.ID == action {
			copy := a
			definition = &copy
		}
	}
	if definition == nil || !r.Granted(definition.Permission) {
		return errors.New("action capability denied")
	}
	r.mu.Lock()
	f := r.frame
	if f == nil || r.status != "running" {
		r.mu.Unlock()
		return errors.New("plugin offline")
	}
	id := security.RandomToken()
	ch := make(chan Message, 1)
	r.pending[id] = ch
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.pending, id); r.mu.Unlock() }()
	if err := f.Write(Message{ID: id, Method: "action", Params: Raw(map[string]any{"action": action})}); err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case m := <-ch:
		if m.Error != "" {
			return errors.New(m.Error)
		}
		return nil
	}
}
