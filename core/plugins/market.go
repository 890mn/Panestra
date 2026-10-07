package plugins

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"panestra.local/panestra/core/backplane"
	"panestra.local/panestra/core/release"
	"panestra.local/panestra/core/security"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const MaxImportSize = 64 * 1024 * 1024
const marketEndpoint = "https://api.github.com/repos/890mn/Panestra-Plugins/releases/latest"

type CatalogEntry struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Package     string `json:"package"`
	Manifest    string `json:"manifest"`
	Signature   string `json:"signature"`
	Description string `json:"description,omitempty"`
}
type Catalog struct {
	SchemaVersion int            `json:"schemaVersion"`
	Plugins       []CatalogEntry `json:"plugins"`
	Message       string         `json:"message,omitempty"`
	Source        string         `json:"source"`
}
type pendingPackage struct {
	id, artifact, device string
	metadata, signature  []byte
	expires              time.Time
	manifest             backplane.Manifest
}
type marketState struct {
	mu      sync.Mutex
	catalog Catalog
	assets  map[string]string
	pending map[string]pendingPackage
	uploads map[string]upload
}
type upload struct {
	ID, Device, File    string
	Size, Offset        int64
	Metadata, Signature []byte
	Expires             time.Time
}

func (m *Manager) BeginUpload(id, device string, size int64, metadata, signature []byte) (string, error) {
	if !validID.MatchString(id) || size < 1 || size > MaxImportSize || len(metadata) > 48*1024 || !ed25519.Verify(m.Key, metadata, signature) {
		return "", errors.New("invalid signed plugin upload")
	}
	var meta release.Metadata
	if json.Unmarshal(metadata, &meta) != nil || meta.Size != size || (meta.PluginID != "" && meta.PluginID != id) {
		return "", errors.New("upload metadata mismatch")
	}
	directory, err := os.MkdirTemp(m.Root, "upload-")
	if err != nil {
		return "", err
	}
	file := filepath.Join(directory, "package.zip")
	if err = os.WriteFile(file, nil, 0600); err != nil {
		os.RemoveAll(directory)
		return "", err
	}
	m.market.mu.Lock()
	defer m.market.mu.Unlock()
	if m.market.uploads == nil {
		m.market.uploads = map[string]upload{}
	}
	for token, item := range m.market.uploads {
		if time.Now().After(item.Expires) {
			os.RemoveAll(filepath.Dir(item.File))
			delete(m.market.uploads, token)
		}
	}
	if len(m.market.uploads) >= 4 {
		os.RemoveAll(directory)
		return "", errors.New("too many pending uploads")
	}
	token := security.RandomToken()
	m.market.uploads[token] = upload{ID: id, Device: device, File: file, Size: size, Metadata: metadata, Signature: signature, Expires: time.Now().Add(15 * time.Minute)}
	return token, nil
}
func (m *Manager) UploadChunk(token, device string, offset int64, raw []byte) (int64, error) {
	m.market.mu.Lock()
	defer m.market.mu.Unlock()
	item, ok := m.market.uploads[token]
	if !ok || item.Device != device || time.Now().After(item.Expires) {
		return 0, errors.New("plugin upload expired")
	}
	if item.Offset != offset || len(raw) == 0 || len(raw) > 32*1024 || offset+int64(len(raw)) > item.Size {
		return 0, errors.New("invalid upload offset or chunk size")
	}
	file, err := os.OpenFile(item.File, os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return 0, err
	}
	n, err := file.Write(raw)
	closeErr := file.Close()
	if err != nil {
		return 0, err
	}
	if closeErr != nil {
		return 0, closeErr
	}
	item.Offset += int64(n)
	item.Expires = time.Now().Add(15 * time.Minute)
	m.market.uploads[token] = item
	return item.Offset, nil
}
func (m *Manager) FinishUpload(token, device string) (Preview, error) {
	m.market.mu.Lock()
	item, ok := m.market.uploads[token]
	if !ok || item.Device != device || time.Now().After(item.Expires) || item.Offset != item.Size {
		m.market.mu.Unlock()
		return Preview{}, errors.New("plugin upload incomplete or expired")
	}
	delete(m.market.uploads, token)
	m.market.mu.Unlock()
	defer os.RemoveAll(filepath.Dir(item.File))
	artifact, err := os.ReadFile(item.File)
	if err != nil {
		return Preview{}, err
	}
	return m.Preview(item.ID, device, artifact, item.Metadata, item.Signature)
}

type Preview struct {
	Token       string             `json:"token"`
	Manifest    backplane.Manifest `json:"manifest"`
	Permissions map[string]bool    `json:"permissions"`
}

func download(ctx context.Context, address string, limit int64) ([]byte, error) {
	parsed, err := url.Parse(address)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || (parsed.Host != "api.github.com" && parsed.Host != "github.com") {
		return nil, errors.New("invalid plugin download URL")
	}
	client := &http.Client{Timeout: 90 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) > 5 || req.URL.Scheme != "https" || (req.URL.Host != "github.com" && req.URL.Host != "release-assets.githubusercontent.com" && req.URL.Host != "objects.githubusercontent.com") {
			return errors.New("unexpected plugin download redirect")
		}
		return nil
	}}
	req, err := http.NewRequestWithContext(ctx, "GET", address, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "Panestra-plugin-manager")
	req.Header.Set("Accept", "application/vnd.github+json")
	response, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return nil, errors.New("插件仓库暂未提供可下载版本")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, errors.New("plugin download too large")
	}
	return raw, nil
}
func validCatalog(raw []byte) (Catalog, error) {
	var catalog Catalog
	if json.Unmarshal(raw, &catalog) != nil || catalog.SchemaVersion != 1 || len(catalog.Plugins) > 100 {
		return catalog, errors.New("invalid plugin catalog")
	}
	seen := map[string]bool{}
	for _, item := range catalog.Plugins {
		if !validID.MatchString(item.ID) || seen[item.ID] {
			return catalog, errors.New("invalid catalog plugin ID")
		}
		seen[item.ID] = true
		for _, name := range []string{item.Package, item.Manifest, item.Signature} {
			if stringsContainsPath(name) || filepath.Base(name) != name {
				return catalog, errors.New("invalid catalog asset")
			}
		}
	}
	return catalog, nil
}

// Catalog refreshes only on explicit request. Installed workers never depend on it.
func (m *Manager) Catalog(ctx context.Context, refresh bool) Catalog {
	m.market.mu.Lock()
	defer m.market.mu.Unlock()
	if m.market.catalog.SchemaVersion == 0 {
		if raw, err := os.ReadFile(filepath.Join(m.Seed, "catalog.json")); m.Seed != "" && err == nil {
			m.market.catalog, _ = validCatalog(raw)
		}
		if m.market.catalog.SchemaVersion == 0 {
			m.market.catalog = Catalog{SchemaVersion: 1, Plugins: []CatalogEntry{}}
		}
		m.market.catalog.Source = "local"
	}
	if !refresh {
		return m.market.catalog
	}
	raw, err := download(ctx, marketEndpoint, 2*1024*1024)
	if err != nil {
		result := m.market.catalog
		result.Message = err.Error()
		return result
	}
	var response struct {
		Assets []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if json.Unmarshal(raw, &response) != nil {
		result := m.market.catalog
		result.Message = "插件仓库返回格式无效"
		return result
	}
	assets := map[string]string{}
	for _, asset := range response.Assets {
		if strings.HasPrefix(asset.URL, "https://github.com/890mn/Panestra-Plugins/releases/download/") {
			assets[asset.Name] = asset.URL
		}
	}
	address := assets["catalog.json"]
	if address == "" {
		result := m.market.catalog
		result.Message = "当前发布未包含插件目录"
		return result
	}
	raw, err = download(ctx, address, 256*1024)
	if err != nil {
		result := m.market.catalog
		result.Message = err.Error()
		return result
	}
	catalog, err := validCatalog(raw)
	if err != nil {
		result := m.market.catalog
		result.Message = "插件目录格式无效"
		return result
	}
	for _, item := range catalog.Plugins {
		if assets[item.Package] == "" || assets[item.Manifest] == "" || assets[item.Signature] == "" {
			result := m.market.catalog
			result.Message = "插件下载文件不完整"
			return result
		}
	}
	catalog.Source = "github"
	m.market.catalog = catalog
	m.market.assets = assets
	return catalog
}
func (m *Manager) Download(ctx context.Context, id, device string) (Preview, error) {
	catalog := m.Catalog(ctx, false)
	for _, item := range catalog.Plugins {
		if item.ID != id {
			continue
		}
		var artifact, metadata, signatureText []byte
		var err error
		if catalog.Source == "local" {
			artifact, err = os.ReadFile(filepath.Join(m.Seed, item.Package))
			if err == nil {
				metadata, err = os.ReadFile(filepath.Join(m.Seed, item.Manifest))
			}
			if err == nil {
				signatureText, err = os.ReadFile(filepath.Join(m.Seed, item.Signature))
			}
		} else {
			m.market.mu.Lock()
			urls := [3]string{m.market.assets[item.Package], m.market.assets[item.Manifest], m.market.assets[item.Signature]}
			m.market.mu.Unlock()
			artifact, err = download(ctx, urls[0], MaxImportSize)
			if err == nil {
				metadata, err = download(ctx, urls[1], 64*1024)
			}
			if err == nil {
				signatureText, err = download(ctx, urls[2], 1024)
			}
		}
		if err != nil {
			return Preview{}, err
		}
		signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signatureText)))
		if err != nil {
			return Preview{}, err
		}
		return m.Preview(id, device, artifact, metadata, signature)
	}
	return Preview{}, errors.New("插件目录未包含此插件")
}
func (m *Manager) minimum(id string) uint64 {
	var previous uint64
	var installed bool
	_ = m.Store.DB.QueryRow("SELECT applied_seq FROM plugin_package_state WHERE plugin_id=?", id).Scan(&previous)
	_ = m.Store.DB.QueryRow("SELECT installed FROM plugin_installations WHERE id=?", id).Scan(&installed)
	// Reinstalling the retained package is allowed, rolling back is not.
	if !installed && previous > 0 {
		return previous - 1
	}
	return previous
}
func (m *Manager) Preview(id, device string, artifact, metadata, signature []byte) (Preview, error) {
	if !validID.MatchString(id) || len(artifact) > MaxImportSize || len(metadata) > 64*1024 {
		return Preview{}, errors.New("invalid plugin package")
	}
	directory, err := os.MkdirTemp(m.Root, "download-")
	if err != nil {
		return Preview{}, err
	}
	retained := false
	defer func() {
		if !retained {
			os.RemoveAll(directory)
		}
	}()
	file := filepath.Join(directory, "package.zip")
	if err = os.WriteFile(file, artifact, 0600); err != nil {
		return Preview{}, err
	}
	if meta, verifyErr := release.Verify(metadata, signature, m.Key, file, m.minimum(id)); verifyErr != nil {
		return Preview{}, verifyErr
	} else if meta.PluginID != "" && meta.PluginID != id {
		return Preview{}, errors.New("signed plugin identity mismatch")
	}
	pointer, err := m.release(id).Stage(file, metadata, signature)
	if err != nil {
		return Preview{}, err
	}
	candidate, err := m.load(id, pointer)
	if err != nil {
		return Preview{}, err
	}
	token := security.RandomToken()
	m.market.mu.Lock()
	defer m.market.mu.Unlock()
	if m.market.pending == nil {
		m.market.pending = map[string]pendingPackage{}
	}
	for key, item := range m.market.pending {
		if time.Now().After(item.expires) {
			os.RemoveAll(filepath.Dir(item.artifact))
			delete(m.market.pending, key)
		}
	}
	if len(m.market.pending) >= 10 {
		return Preview{}, errors.New("too many pending plugin installs")
	}
	m.market.pending[token] = pendingPackage{id: id, artifact: file, device: device, metadata: metadata, signature: signature, expires: time.Now().Add(15 * time.Minute), manifest: candidate.Manifest}
	retained = true
	return Preview{Token: token, Manifest: candidate.Manifest, Permissions: candidate.Status()["permissions"].(map[string]bool)}, nil
}
func (m *Manager) Apply(token, device string, consent []string) (*backplane.Runtime, error) {
	m.market.mu.Lock()
	item, ok := m.market.pending[token]
	m.market.mu.Unlock()
	if !ok || item.device != device || time.Now().After(item.expires) {
		return nil, errors.New("安装预览已过期，请重新选择插件包")
	}
	for _, permission := range item.manifest.Permissions {
		if permission.Required && !m.granted(item.id, permission.ID) {
			found := false
			for _, cap := range consent {
				found = found || cap == permission.ID
			}
			if !found {
				return nil, errors.New("请授权插件的必需权限")
			}
		}
	}
	worker, err := m.Install(item.id, item.artifact, item.metadata, item.signature, consent)
	if err != nil {
		return nil, err
	}
	m.market.mu.Lock()
	delete(m.market.pending, token)
	m.market.mu.Unlock()
	os.RemoveAll(filepath.Dir(item.artifact))
	return worker, nil
}
func (m *Manager) granted(id, cap string) bool {
	var granted bool
	_ = m.Store.DB.QueryRow("SELECT granted FROM plugin_permissions WHERE plugin_id=? AND capability=?", id, cap).Scan(&granted)
	return granted
}
