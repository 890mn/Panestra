package server

import (
	"archive/zip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"panestra.local/panestra/core/release"
	"panestra.local/panestra/core/security"
	"path/filepath"
	"testing"
	"time"
)

func TestOwnerSignedLiveUpdateAndConsentBoundary(t *testing.T) {
	binary, _ := filepath.Abs("../../artifacts/system-plugin.exe")
	worker, err := os.ReadFile(binary)
	if err != nil {
		t.Skip("build bundled worker first")
	}
	s, httpServer, token := setup(t)
	s.Plugin.Binary = binary
	s.Plugin.Grant("system.metrics.read", true)
	if err = s.Plugin.Start(s.Context); err != nil {
		t.Fatal(err)
	}
	defer s.Plugin.Stop()
	s.Store.DB.Exec("INSERT INTO devices VALUES('operator-device','Operator','unused','operator','now','now',NULL)")
	operatorToken := "operator-test-token"
	s.Store.DB.Exec("INSERT INTO sessions VALUES(?,?,?)", security.Hash(operatorToken), "operator-device", time.Now().Add(time.Minute).Unix())
	status, _ := api(t, httpServer, operatorToken, "POST", "/api/v1/actions/lock", map[string]any{"opId": "lock-role-test", "confirm": true})
	if status != 403 {
		t.Fatal("operator may lock owner session", status)
	}
	status, _ = api(t, httpServer, operatorToken, "POST", "/api/v1/plugins/system/update", map[string]any{"consent": []string{}})
	if status != 403 {
		t.Fatal("operator may update plugin", status)
	}
	status, _ = api(t, httpServer, token, "POST", "/api/v1/plugins/system/update", map[string]any{"consent": []string{}})
	if status != 400 {
		t.Fatal("missing trust root accepted")
	}
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	os.WriteFile(filepath.Join(s.DataDir, "publisher.pub"), []byte(hex.EncodeToString(pub)), 0600)
	manifest, _ := os.ReadFile("../../plugins/system/manifest.json")
	artifact := filepath.Join(s.DataDir, "release.zip")
	file, _ := os.Create(artifact)
	archive := zip.NewWriter(file)
	digests := map[string]string{}
	for name, value := range map[string][]byte{"panestra-core.exe": []byte("unused preflight fixture"), "system-plugin.exe": worker, "plugins/system/manifest.json": manifest} {
		entry, err := archive.CreateHeader(&zip.FileHeader{Name: name, Method: zip.Store})
		if err != nil {
			t.Fatal(err)
		}
		entry.Write(value)
		hash := sha256.Sum256(value)
		digests[name] = hex.EncodeToString(hash[:])
	}
	archive.Close()
	file.Close()
	rawArchive, _ := os.ReadFile(artifact)
	hash := sha256.Sum256(rawArchive)
	raw, _, _ := release.SignMetadata(release.Metadata{SchemaVersion: 1, Product: "Panestra", Version: "0.1.0", ReleaseSequence: 1, APIVersion: 1, SHA256: hex.EncodeToString(hash[:]), Size: int64(len(rawArchive)), Files: digests}, key)
	manager := release.Manager{Root: filepath.Join(s.DataDir, "releases"), PublisherKey: pub}
	pointer, err := manager.Stage(artifact, raw, ed25519.Sign(key, raw))
	if err != nil {
		t.Fatal(err)
	}
	if err = manager.Activate(pointer, func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	status, body := api(t, httpServer, token, "POST", "/api/v1/plugins/system/update", map[string]any{"consent": []string{}})
	if status != 200 {
		t.Fatal(status, string(body))
	}
	var applied int
	var directory string
	if err = s.Store.DB.QueryRow("SELECT applied_seq,version_dir FROM plugin_release_state WHERE plugin_id='dev.panestra.system'").Scan(&applied, &directory); err != nil || applied != 1 || directory != pointer.Directory {
		t.Fatal("activation state not persisted", err)
	}
	status, _ = api(t, httpServer, token, "POST", "/api/v1/plugins/system/update", map[string]any{"consent": []string{}})
	if status != 400 {
		t.Fatal("same release reapplied")
	}
	if !s.Plugin.Granted("system.metrics.read") || s.Plugin.Granted("system.session.lock") {
		t.Fatal("permissions changed during upgrade")
	}
}
