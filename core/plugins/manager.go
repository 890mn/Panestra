// Package plugins owns installed local plugin processes, not software integrations.
package plugins

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"panestra.local/panestra/core/backplane"
	"panestra.local/panestra/core/release"
	"panestra.local/panestra/core/store"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

var validID = regexp.MustCompile(`^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,}$`)

type Manager struct {
	Store     *store.Store
	Context   context.Context
	Root      string
	Seed      string
	Key       ed25519.PublicKey
	Publish   func(backplane.Telemetry)
	mu        sync.RWMutex
	installMu sync.Mutex
	workers   map[string]*backplane.Runtime
	publishMu sync.Mutex
	latest    map[string]backplane.Telemetry
	market    marketState
	taskMu    sync.Mutex
	tasks     map[string]*MarketTask
}

func Open(ctx context.Context, s *store.Store, dataDir string, key ed25519.PublicKey) (*Manager, error) {
	m := &Manager{Store: s, Context: ctx, Root: filepath.Join(dataDir, "plugin-packages"), Key: key, workers: map[string]*backplane.Runtime{}, latest: map[string]backplane.Telemetry{}}
	if len(key) != ed25519.PublicKeySize {
		return nil, errors.New("invalid plugin publisher key")
	}
	if err := os.MkdirAll(m.Root, 0700); err != nil {
		return nil, err
	}
	if _, err := s.DB.Exec(`CREATE TABLE IF NOT EXISTS plugin_package_state(plugin_id TEXT PRIMARY KEY,applied_seq INTEGER NOT NULL,version_dir TEXT NOT NULL,version TEXT NOT NULL); CREATE TABLE IF NOT EXISTS plugin_installations(id TEXT PRIMARY KEY,installed INTEGER NOT NULL DEFAULT 1,enabled INTEGER NOT NULL DEFAULT 1)`); err != nil {
		return nil, err
	}
	rows, err := s.DB.Query(`SELECT r.plugin_id,r.applied_seq,r.version_dir,r.version FROM plugin_package_state r JOIN plugin_installations i ON i.id=r.plugin_id WHERE i.installed=1`)
	if err != nil {
		return nil, err
	}
	type installed struct {
		id      string
		pointer release.Pointer
	}
	entries := []installed{}
	for rows.Next() {
		var item installed
		if err = rows.Scan(&item.id, &item.pointer.ReleaseSequence, &item.pointer.Directory, &item.pointer.Version); err != nil {
			rows.Close()
			return nil, err
		}
		entries = append(entries, item)
	}
	rows.Close()
	for _, item := range entries {
		worker, err := m.load(item.id, item.pointer)
		if err != nil {
			return nil, fmt.Errorf("validate installed plugin %s: %w", item.id, err)
		}
		m.workers[item.id] = worker
	}
	return m, nil
}
func (m *Manager) release(id string) *release.Manager {
	return &release.Manager{Root: filepath.Join(m.Root, id), PublisherKey: m.Key, RequiredFiles: []string{"manifest.json"}}
}
func (m *Manager) load(id string, pointer release.Pointer) (*backplane.Runtime, error) {
	if !validID.MatchString(id) {
		return nil, errors.New("invalid plugin ID")
	}
	packageManager := m.release(id)
	if err := packageManager.ValidateDirectory(pointer, []string{"manifest.json"}); err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(filepath.Join(pointer.Directory, "manifest.json"))
	if err != nil {
		return nil, err
	}
	manifest, err := backplane.ParseManifest(raw)
	if err != nil {
		return nil, err
	}
	if manifest.ID != id || manifest.Version != pointer.Version {
		return nil, errors.New("plugin identity mismatch")
	}
	if err := packageManager.ValidateDirectory(pointer, []string{"manifest.json", manifest.Engine.Entry}); err != nil {
		return nil, err
	}
	worker, err := backplane.NewRuntime(m.Store, filepath.Join(pointer.Directory, manifest.Engine.Entry), raw, false)
	if err != nil {
		return nil, err
	}
	worker.DataDir = filepath.Join(m.Root, id, "data")
	if err := os.MkdirAll(worker.DataDir, 0700); err != nil {
		return nil, err
	}
	worker.Publish = m.publish
	return worker, nil
}

func (m *Manager) publish(event backplane.Telemetry) {
	m.publishMu.Lock()
	defer m.publishMu.Unlock()
	m.latest[event.Topic] = event
	if m.Publish != nil {
		m.Publish(event)
	}
}
func (m *Manager) SetPublish(fn func(backplane.Telemetry)) {
	m.publishMu.Lock()
	defer m.publishMu.Unlock()
	m.Publish = fn
	for _, event := range m.latest {
		fn(event)
	}
}
func (m *Manager) Get(id string) *backplane.Runtime {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.workers[id]
}
func (m *Manager) All() []*backplane.Runtime {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := []*backplane.Runtime{}
	for _, worker := range m.workers {
		out = append(out, worker)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Manifest.ID < out[j].Manifest.ID })
	return out
}
func (m *Manager) Status() []any {
	out := []any{}
	for _, worker := range m.All() {
		status := worker.Status()
		var enabled bool
		_ = m.Store.DB.QueryRow("SELECT enabled FROM plugin_installations WHERE id=?", worker.Manifest.ID).Scan(&enabled)
		status["enabled"] = enabled
		out = append(out, status)
	}
	return out
}
func (m *Manager) Topics() map[string]bool {
	out := map[string]bool{}
	for _, worker := range m.All() {
		for _, source := range worker.Manifest.Sources {
			out[worker.Manifest.ID+"/"+source.ID] = true
		}
	}
	return out
}
func (m *Manager) Route(method, path string) (*backplane.Runtime, *backplane.Route) {
	for _, worker := range m.All() {
		for _, route := range worker.Manifest.Routes {
			if route.Method == method && route.Path == path {
				copy := route
				return worker, &copy
			}
		}
	}
	return nil, nil
}
func (m *Manager) StartAll() error {
	for _, worker := range m.All() {
		var enabled bool
		_ = m.Store.DB.QueryRow("SELECT enabled FROM plugin_installations WHERE id=?", worker.Manifest.ID).Scan(&enabled)
		if enabled && worker.RequiredGranted() {
			if err := worker.Start(m.Context); err != nil {
				return err
			}
		}
	}
	return nil
}
func (m *Manager) StopAll() {
	for _, worker := range m.All() {
		worker.Stop()
	}
}

// Install verifies bytes and waits for a candidate before replacing the active worker.
func (m *Manager) Install(id, artifact string, metadata, signature []byte, consent []string) (*backplane.Runtime, error) {
	m.installMu.Lock()
	defer m.installMu.Unlock()
	if !validID.MatchString(id) {
		return nil, errors.New("invalid plugin ID")
	}
	previous := m.minimum(id)
	if _, err := release.Verify(metadata, signature, m.Key, artifact, previous); err != nil {
		return nil, err
	}
	packageManager := m.release(id)
	pointer, err := packageManager.Stage(artifact, metadata, signature)
	if err != nil {
		return nil, err
	}
	candidate, err := m.load(id, pointer)
	if err != nil {
		return nil, err
	}
	if err := candidate.PrepareGrants(consent); err != nil {
		return nil, err
	}
	var candidateMu sync.Mutex
	active := false
	buffered := map[string]backplane.Telemetry{}
	candidate.Publish = func(event backplane.Telemetry) {
		candidateMu.Lock()
		defer candidateMu.Unlock()
		if active {
			m.publish(event)
		} else {
			buffered[event.Topic] = event
		}
	}
	for _, route := range candidate.Manifest.Routes {
		if existing, _ := m.Route(route.Method, route.Path); existing != nil && existing.Manifest.ID != id {
			return nil, errors.New("plugin route already registered")
		}
	}
	// Preserve encrypted legacy files; never replace a newer plugin-owned configuration.
	if name := candidate.Manifest.LegacyData; name != "" {
		target := filepath.Join(candidate.DataDir, name)
		if _, err := os.Stat(target); os.IsNotExist(err) {
			legacy := filepath.Join(filepath.Dir(m.Root), "integrations", name)
			if raw, err := os.ReadFile(legacy); err == nil {
				if err = os.WriteFile(target, raw, 0600); err != nil {
					return nil, err
				}
			} else if !os.IsNotExist(err) {
				return nil, err
			}
		}
	}
	for _, name := range candidate.Manifest.LegacyPaths {
		if err := migrateLegacyPath(filepath.Join(filepath.Dir(m.Root), "integrations", name), filepath.Join(candidate.DataDir, name)); err != nil {
			return nil, err
		}
	}
	enabled := true
	_ = m.Store.DB.QueryRow("SELECT enabled FROM plugin_installations WHERE id=? AND installed=1", id).Scan(&enabled)
	ready := candidate.RequiredGranted()
	promoted := false
	defer func() {
		if !promoted {
			candidate.Stop()
		}
	}()
	if ready {
		if err := candidate.Start(m.Context); err != nil {
			return nil, err
		}
		ctx, cancel := context.WithTimeout(m.Context, 10*time.Second)
		err = candidate.WaitReady(ctx)
		cancel()
		if err != nil {
			return nil, fmt.Errorf("new plugin unhealthy; previous worker retained: %w", err)
		}
		if !enabled {
			candidate.Stop()
		}
	}
	status := candidate.Status()
	grants := status["permissions"].(map[string]bool)
	m.Store.Mu.Lock()
	tx, err := m.Store.DB.Begin()
	if err == nil {
		_, err = tx.Exec("INSERT INTO plugins VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,status=excluded.status,manifest_digest=excluded.manifest_digest,data=excluded.data", id, candidate.Manifest.Version, status["status"], candidate.Digest, string(backplane.Raw(candidate.Manifest)))
	}
	if err == nil {
		_, err = tx.Exec("INSERT INTO plugin_package_state VALUES(?,?,?,?) ON CONFLICT(plugin_id) DO UPDATE SET applied_seq=excluded.applied_seq,version_dir=excluded.version_dir,version=excluded.version", id, pointer.ReleaseSequence, pointer.Directory, pointer.Version)
	}
	if err == nil {
		_, err = tx.Exec("INSERT INTO plugin_installations VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET installed=1,enabled=excluded.enabled", id, enabled)
	}
	for cap, grant := range grants {
		if err == nil {
			_, err = tx.Exec("INSERT INTO plugin_permissions VALUES(?,?,?) ON CONFLICT(plugin_id,capability) DO UPDATE SET granted=excluded.granted", id, cap, grant)
		}
	}
	if tx != nil {
		if err == nil {
			err = tx.Commit()
		} else {
			tx.Rollback()
		}
	}
	m.Store.Mu.Unlock()
	if err != nil {
		return nil, err
	}
	old := m.Get(id)
	if old != nil {
		old.Stop()
	}
	m.mu.Lock()
	m.workers[id] = candidate
	m.mu.Unlock()
	promoted = true
	candidateMu.Lock()
	active = true
	for _, event := range buffered {
		m.publish(event)
	}
	candidateMu.Unlock()
	m.Store.Audit("core", "plugin.install", id, "verified", "")
	return candidate, nil
}

func (m *Manager) Bootstrap(seed string) error {
	m.Seed = seed
	if seed == "" {
		return nil
	}
	raw, err := os.ReadFile(filepath.Join(seed, "catalog.json"))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	var catalog struct {
		Plugins []struct{ ID, Package, Manifest, Signature string } `json:"plugins"`
	}
	if json.Unmarshal(raw, &catalog) != nil {
		return errors.New("invalid seed catalog")
	}
	for _, item := range catalog.Plugins {
		var known int
		_ = m.Store.DB.QueryRow("SELECT count(*) FROM plugin_installations WHERE id=?", item.ID).Scan(&known)
		if known > 0 {
			continue
		}
		for _, name := range []string{item.Package, item.Manifest, item.Signature} {
			if filepath.Base(name) != name || stringsContainsPath(name) {
				return errors.New("invalid seed filename")
			}
		}
		metadata, err := os.ReadFile(filepath.Join(seed, item.Manifest))
		if err != nil {
			return err
		}
		signatureText, err := os.ReadFile(filepath.Join(seed, item.Signature))
		if err != nil {
			return err
		}
		signature, err := base64.StdEncoding.DecodeString(string(signatureText))
		if err != nil {
			return err
		}
		if _, err = m.Install(item.ID, filepath.Join(seed, item.Package), metadata, signature, nil); err != nil {
			return err
		}
	}
	for _, worker := range m.All() {
		if err := m.Store.SeedPlugin(backplane.Raw(worker.Manifest)); err != nil {
			return err
		}
	}
	return nil
}
func stringsContainsPath(name string) bool {
	return name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\:")
}

func (m *Manager) SetEnabled(id string, enabled bool) error {
	m.installMu.Lock()
	defer m.installMu.Unlock()
	worker := m.Get(id)
	if worker == nil {
		return errors.New("plugin not installed")
	}
	if enabled {
		if !worker.RequiredGranted() {
			return errors.New("required permission not granted")
		}
		var pointer release.Pointer
		if err := m.Store.DB.QueryRow("SELECT applied_seq,version_dir,version FROM plugin_package_state WHERE plugin_id=?", id).Scan(&pointer.ReleaseSequence, &pointer.Directory, &pointer.Version); err != nil {
			return err
		}
		if err := m.release(id).ValidateDirectory(pointer, []string{"manifest.json", worker.Manifest.Engine.Entry}); err != nil {
			return err
		}
		if err := worker.Start(m.Context); err != nil {
			return err
		}
	} else {
		worker.Stop()
	}
	_, err := m.Store.DB.Exec("UPDATE plugin_installations SET enabled=? WHERE id=?", enabled, id)
	return err
}

// migrateLegacyPath copies local configuration without following links or replacing
// plugin-owned files. Old launchers remain valid because their original paths stay.
func migrateLegacyPath(source, target string) error {
	info, err := os.Lstat(source)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return errors.New("linked legacy data refused")
	}
	if info.IsDir() {
		if err := os.MkdirAll(target, 0700); err != nil {
			return err
		}
		entries, err := os.ReadDir(source)
		if err != nil {
			return err
		}
		if len(entries) > 1000 {
			return errors.New("too many legacy data files")
		}
		for _, entry := range entries {
			if err := migrateLegacyPath(filepath.Join(source, entry.Name()), filepath.Join(target, entry.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	if info.Size() > 16*1024*1024 {
		return errors.New("legacy data file too large")
	}
	if _, err := os.Lstat(target); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	raw, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	return os.WriteFile(target, raw, 0600)
}
func (m *Manager) Uninstall(id string) error {
	m.installMu.Lock()
	defer m.installMu.Unlock()
	worker := m.Get(id)
	if worker == nil {
		return errors.New("plugin not installed")
	}
	worker.Stop()
	_, err := m.Store.DB.Exec("UPDATE plugin_installations SET installed=0,enabled=0 WHERE id=?", id)
	if err != nil {
		return err
	}
	m.mu.Lock()
	delete(m.workers, id)
	m.mu.Unlock()
	// Data and layout references stay available for reinstall; code is no longer executable.
	m.Store.Audit("core", "plugin.uninstall", id, "data retained", "")
	return nil
}
