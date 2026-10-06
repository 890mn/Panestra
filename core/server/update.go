package server

import (
	"crypto/ed25519"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"panestra.local/panestra/core/backplane"
	"panestra.local/panestra/core/protocol"
	"panestra.local/panestra/core/release"
	"path/filepath"
	"strings"
)

func (s *Server) releaseManager() (*release.Manager, error) {
	raw, err := os.ReadFile(filepath.Join(s.DataDir, "publisher.pub"))
	if err != nil {
		return nil, errors.New("本机尚未配置受信发布者公钥")
	}
	key, err := hex.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("本机发布者公钥无效")
	}
	return &release.Manager{Root: filepath.Join(s.DataDir, "releases"), PublisherKey: ed25519.PublicKey(key)}, nil
}
func (s *Server) pluginUpdateStatus(w http.ResponseWriter, r *http.Request, d protocol.Device) {
	manager, err := s.releaseManager()
	if err != nil {
		JSON(w, 200, map[string]any{"available": false, "message": err.Error()})
		return
	}
	pointer, err := manager.Current()
	if err != nil {
		failure(w, err)
		return
	}
	if pointer.ReleaseSequence == 0 {
		JSON(w, 200, map[string]any{"available": false, "message": "没有已验证的待更新版本"})
		return
	}
	if err = manager.ValidateDirectory(pointer, []string{"system-plugin.exe", "plugins/system/manifest.json"}); err != nil {
		failure(w, err)
		return
	}
	raw, err := os.ReadFile(filepath.Join(pointer.Directory, "plugins/system/manifest.json"))
	if err != nil {
		failure(w, err)
		return
	}
	manifest, err := backplane.ParseManifest(raw)
	if err != nil {
		failure(w, err)
		return
	}
	var applied uint64
	s.Store.DB.QueryRow("SELECT applied_seq FROM plugin_release_state WHERE plugin_id='dev.panestra.system'").Scan(&applied)
	JSON(w, 200, map[string]any{"available": pointer.ReleaseSequence > applied, "releaseSequence": pointer.ReleaseSequence, "version": manifest.Version, "permissions": manifest.Permissions})
}
func (s *Server) updatePlugin(w http.ResponseWriter, r *http.Request, d protocol.Device) {
	s.pluginUpdateMu.Lock()
	defer s.pluginUpdateMu.Unlock()
	var body struct {
		Consent []string `json:"consent"`
	}
	if !decode(w, r, &body) {
		return
	}
	manager, err := s.releaseManager()
	if err != nil {
		failure(w, err)
		return
	}
	pointer, err := manager.Current()
	if err != nil {
		failure(w, err)
		return
	}
	var applied uint64
	s.Store.DB.QueryRow("SELECT applied_seq FROM plugin_release_state WHERE plugin_id='dev.panestra.system'").Scan(&applied)
	if pointer.ReleaseSequence <= applied {
		failure(w, errors.New("没有更新的已验证版本"))
		return
	}
	raw, err := os.ReadFile(filepath.Join(pointer.Directory, "plugins/system/manifest.json"))
	if err != nil {
		failure(w, err)
		return
	}
	err = s.Plugin.SwitchVerified(s.Context, filepath.Join(pointer.Directory, "system-plugin.exe"), raw, body.Consent, func() error {
		return manager.ValidateDirectory(pointer, []string{"system-plugin.exe", "plugins/system/manifest.json"})
	}, func(tx *sql.Tx) error {
		_, err := tx.Exec("INSERT INTO plugin_release_state VALUES(?,?,?,?) ON CONFLICT(plugin_id) DO UPDATE SET applied_seq=excluded.applied_seq,version_dir=excluded.version_dir,version=excluded.version", "dev.panestra.system", pointer.ReleaseSequence, pointer.Directory, pointer.Version)
		return err
	})
	result := "success"
	if err != nil {
		result = "failure"
	}
	s.Store.Audit(d.ID, "plugin.update", "dev.panestra.system", result, r.Header.Get("X-Request-ID"))
	if err != nil {
		failure(w, err)
		return
	}
	JSON(w, 200, s.Plugin.Status())
}
