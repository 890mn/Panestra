// Package release implements a locally pinned, signed artifact staging and activation path.
package release

import (
	"archive/zip"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

const MaxPackageSize = 256 * 1024 * 1024

type Metadata struct {
	SchemaVersion   int               `json:"schemaVersion"`
	Product         string            `json:"product"`
	Version         string            `json:"version"`
	ReleaseSequence uint64            `json:"releaseSequence"`
	APIVersion      int               `json:"apiVersion"`
	SHA256          string            `json:"sha256"`
	Size            int64             `json:"size"`
	Files           map[string]string `json:"files,omitempty"`
	PluginID        string            `json:"pluginId,omitempty"`
}
type Pointer struct {
	Version         string `json:"version"`
	ReleaseSequence uint64 `json:"releaseSequence"`
	Directory       string `json:"directory"`
}
type Manager struct {
	Root          string
	PublisherKey  ed25519.PublicKey
	RequiredFiles []string
	mu            sync.Mutex
}

func Verify(metadataBytes, signatureBytes []byte, key ed25519.PublicKey, artifactPath string, minimum uint64) (Metadata, error) {
	var m Metadata
	if len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, metadataBytes, signatureBytes) {
		return m, errors.New("publisher signature invalid")
	}
	if err := json.Unmarshal(metadataBytes, &m); err != nil {
		return m, err
	}
	if m.SchemaVersion != 1 || m.Product != "Panestra" || m.APIVersion != 1 || !regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`).MatchString(m.Version) || m.ReleaseSequence <= minimum || m.Size < 1 || m.Size > MaxPackageSize {
		return m, errors.New("incompatible metadata or release rollback")
	}
	f, err := os.Open(artifactPath)
	if err != nil {
		return m, err
	}
	defer f.Close()
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(f, MaxPackageSize+1))
	if err != nil {
		return m, err
	}
	if n != m.Size || hex.EncodeToString(hash.Sum(nil)) != m.SHA256 {
		return m, errors.New("artifact hash or size mismatch")
	}
	return m, nil
}
func (m *Manager) Current() (Pointer, error) {
	var p Pointer
	raw, err := os.ReadFile(filepath.Join(m.Root, "current.json"))
	if os.IsNotExist(err) {
		return p, nil
	}
	if err != nil {
		return p, err
	}
	err = json.Unmarshal(raw, &p)
	return p, err
}
func (m *Manager) Stage(artifact string, metadata, signature []byte) (Pointer, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	current, err := m.Current()
	if err != nil {
		return Pointer{}, err
	}
	meta, err := Verify(metadata, signature, m.PublisherKey, artifact, current.ReleaseSequence)
	if err != nil {
		return Pointer{}, err
	}
	dir := filepath.Join(m.Root, "versions", fmt.Sprintf("%d-%s", meta.ReleaseSequence, meta.Version))
	if _, err = os.Stat(dir); !os.IsNotExist(err) {
		if m.RequiredFiles != nil {
			pointer := Pointer{Version: meta.Version, ReleaseSequence: meta.ReleaseSequence, Directory: dir}
			raw, readErr := os.ReadFile(filepath.Join(dir, ".release-meta.json"))
			if readErr == nil && string(raw) == string(metadata) && m.ValidateDirectory(pointer, m.RequiredFiles) == nil {
				return pointer, nil
			}
		}
		return Pointer{}, errors.New("immutable version already exists")
	}
	if err = os.MkdirAll(filepath.Dir(dir), 0700); err != nil {
		return Pointer{}, err
	}
	staging, err := os.MkdirTemp(filepath.Dir(dir), "staging-")
	if err != nil {
		return Pointer{}, err
	}
	defer os.RemoveAll(staging)
	archive, err := zip.OpenReader(artifact)
	if err != nil {
		return Pointer{}, err
	}
	defer archive.Close()
	var total uint64
	for _, entry := range archive.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		name := strings.ReplaceAll(entry.Name, "\\", "/")
		clean := path.Clean(name)
		if clean == ".release-meta.json" || clean == ".release-meta.sig" {
			return Pointer{}, errors.New("reserved package metadata path")
		}
		if clean == "." || clean != name || strings.HasPrefix(clean, "/") || strings.Contains(clean, ":") || clean == ".." || strings.HasPrefix(clean, "../") || entry.Mode()&os.ModeSymlink != 0 {
			return Pointer{}, errors.New("unsafe package path")
		}
		total += entry.UncompressedSize64
		if total > MaxPackageSize {
			return Pointer{}, errors.New("expanded package too large")
		}
		target := filepath.Join(staging, filepath.FromSlash(clean))
		if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return Pointer{}, err
		}
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return Pointer{}, err
		}
		in, err := entry.Open()
		if err != nil {
			out.Close()
			return Pointer{}, err
		}
		_, copyErr := io.Copy(out, io.LimitReader(in, int64(entry.UncompressedSize64)+1))
		closeErr := out.Close()
		in.Close()
		if copyErr != nil {
			return Pointer{}, copyErr
		}
		if closeErr != nil {
			return Pointer{}, closeErr
		}
	}
	requiredFiles := m.RequiredFiles
	if requiredFiles == nil {
		requiredFiles = []string{"panestra-core.exe", "system-plugin.exe", "plugins/system/manifest.json"}
	}
	for _, required := range requiredFiles {
		if _, err = os.Stat(filepath.Join(staging, required)); err != nil {
			return Pointer{}, errors.New("package missing: " + required)
		}
	}
	if err = os.WriteFile(filepath.Join(staging, ".release-meta.json"), metadata, 0600); err != nil {
		return Pointer{}, err
	}
	if err = os.WriteFile(filepath.Join(staging, ".release-meta.sig"), signature, 0600); err != nil {
		return Pointer{}, err
	}
	if err = os.Rename(staging, dir); err != nil {
		return Pointer{}, err
	}
	return Pointer{Version: meta.Version, ReleaseSequence: meta.ReleaseSequence, Directory: dir}, nil
}

// ValidateDirectory binds staged executable files to locally pinned publisher metadata.
// It is required again before live plugin execution, even if the package was staged by another process.
func (m *Manager) ValidateDirectory(pointer Pointer, required []string) error {
	root, err := filepath.Abs(filepath.Join(m.Root, "versions"))
	if err != nil {
		return err
	}
	dir, err := filepath.Abs(pointer.Directory)
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(resolvedRoot, resolved)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return errors.New("version outside release root")
	}
	raw, err := os.ReadFile(filepath.Join(dir, ".release-meta.json"))
	if err != nil {
		return err
	}
	sig, err := os.ReadFile(filepath.Join(dir, ".release-meta.sig"))
	if err != nil {
		return err
	}
	if len(m.PublisherKey) != ed25519.PublicKeySize || !ed25519.Verify(m.PublisherKey, raw, sig) {
		return errors.New("staged publisher signature invalid")
	}
	var meta Metadata
	if err = json.Unmarshal(raw, &meta); err != nil {
		return err
	}
	if meta.Product != "Panestra" || meta.SchemaVersion != 1 || meta.APIVersion != 1 || meta.ReleaseSequence != pointer.ReleaseSequence || meta.Version != pointer.Version {
		return errors.New("staged metadata mismatch")
	}
	for _, name := range required {
		expected, ok := meta.Files[name]
		if !ok || len(expected) != 64 {
			return errors.New("signed file digest missing: " + name)
		}
		clean := path.Clean(strings.ReplaceAll(name, "\\", "/"))
		if clean != name || clean == ".." || strings.HasPrefix(clean, "../") || path.IsAbs(clean) || strings.Contains(clean, ":") {
			return errors.New("invalid signed file path")
		}
		target, err := filepath.EvalSymlinks(filepath.Join(dir, filepath.FromSlash(name)))
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(resolved, target)
		if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) || filepath.IsAbs(relative) {
			return errors.New("signed file escaped package")
		}
		file, err := os.Open(target)
		if err != nil {
			return err
		}
		hash := sha256.New()
		n, copyErr := io.Copy(hash, io.LimitReader(file, MaxPackageSize+1))
		file.Close()
		if copyErr != nil {
			return copyErr
		}
		if n > MaxPackageSize || hex.EncodeToString(hash.Sum(nil)) != expected {
			return errors.New("staged file digest mismatch: " + name)
		}
	}
	return nil
}
func (m *Manager) Activate(next Pointer, health func(string) error) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	prior, err := m.Current()
	if err != nil {
		return err
	}
	if next.ReleaseSequence <= prior.ReleaseSequence {
		return errors.New("release rollback refused")
	}
	root, err := filepath.Abs(filepath.Join(m.Root, "versions"))
	if err != nil {
		return err
	}
	directory, err := filepath.Abs(next.Directory)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(root, directory)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return errors.New("activation path outside release root")
	}
	if err = health(directory); err != nil {
		return fmt.Errorf("new release unhealthy; current release retained: %w", err)
	}
	raw, _ := json.Marshal(next)
	tmp := filepath.Join(m.Root, "current.json.tmp")
	if err = os.WriteFile(tmp, raw, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(m.Root, "current.json"))
}
func SignMetadata(meta Metadata, key ed25519.PrivateKey) ([]byte, string, error) {
	raw, err := json.Marshal(meta)
	if err != nil {
		return nil, "", err
	}
	return raw, base64.StdEncoding.EncodeToString(ed25519.Sign(key, raw)), nil
}
