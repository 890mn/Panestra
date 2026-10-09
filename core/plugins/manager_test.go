package plugins

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"panestra.local/panestra/core/backplane"
	"panestra.local/panestra/core/release"
	"panestra.local/panestra/core/store"
	"path/filepath"
	"testing"
	"time"
)

func fixture(t *testing.T) (backplane.Manifest, []byte) {
	t.Helper()
	archive, err := zip.OpenReader("../../artifacts/build/plugin-seed/codex.zip")
	if err != nil {
		t.Fatal("prepare independent signed plugin packages before integration checks:", err)
	}
	defer archive.Close()
	var raw, binary []byte
	for _, file := range archive.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		value, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		if file.Name == "manifest.json" {
			raw = value
		} else if file.Name == "codex-plugin.exe" {
			binary = value
		}
	}
	manifest, err := backplane.ParseManifest(raw)
	if err != nil || len(binary) == 0 {
		t.Fatal("invalid independent worker fixture", err)
	}
	return manifest, binary
}

func TestChunkUploadAndBackgroundDownloadAreBoundAndVerified(t *testing.T) {
	manifest, binary := fixture(t)
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	dir := t.TempDir()
	s, err := store.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	manager, err := Open(context.Background(), s, dir, pub)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.StopAll()
	artifact, metadata, signature := signed(t, manifest, binary, 1, key)
	if _, err := manager.BeginUpload(manifest.ID, "owner", int64(len(artifact)+1), metadata, signature); err == nil {
		t.Fatal("incorrect signed upload size accepted")
	}
	token, err := manager.BeginUpload(manifest.ID, "owner", int64(len(artifact)), metadata, signature)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.UploadChunk(token, "other", 0, artifact[:1]); err == nil {
		t.Fatal("another device uploaded bytes")
	}
	if _, err := manager.UploadChunk(token, "owner", 1, artifact[:1]); err == nil {
		t.Fatal("wrong offset accepted")
	}
	if _, err := manager.UploadChunk(token, "owner", 0, artifact[:32769]); err == nil {
		t.Fatal("oversized chunk accepted")
	}
	if _, err := manager.FinishUpload(token, "owner"); err == nil {
		t.Fatal("incomplete upload verified")
	}
	for offset := 0; offset < len(artifact); {
		end := min(offset+32768, len(artifact))
		next, err := manager.UploadChunk(token, "owner", int64(offset), artifact[offset:end])
		if err != nil || next != int64(end) {
			t.Fatal("chunk failed", err, next)
		}
		offset = end
	}
	if _, err := manager.FinishUpload(token, "other"); err == nil {
		t.Fatal("another device finished upload")
	}
	preview, err := manager.FinishUpload(token, "owner")
	if err != nil || preview.Manifest.ID != manifest.ID {
		t.Fatal("signed upload not verified", err)
	}
	if len(manager.All()) != 0 {
		t.Fatal("upload preview executed worker before consent")
	}
	if _, err := manager.FinishUpload(token, "owner"); err == nil {
		t.Fatal("consumed upload replayed")
	}
	corrupt := append([]byte{}, artifact...)
	corrupt[len(corrupt)/2] ^= 1
	token, err = manager.BeginUpload(manifest.ID, "owner", int64(len(corrupt)), metadata, signature)
	if err != nil {
		t.Fatal(err)
	}
	for offset := 0; offset < len(corrupt); offset += 32768 {
		if _, err := manager.UploadChunk(token, "owner", int64(offset), corrupt[offset:min(offset+32768, len(corrupt))]); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := manager.FinishUpload(token, "owner"); err == nil {
		t.Fatal("modified upload passed hash verification")
	}
	manager.Seed = filepath.Join(dir, "seed")
	if err := os.MkdirAll(manager.Seed, 0700); err != nil {
		t.Fatal(err)
	}
	for name, raw := range map[string][]byte{"codex.zip": artifact, "codex.json": metadata, "codex.sig": []byte(base64.StdEncoding.EncodeToString(signature)), "catalog.json": []byte(`{"schemaVersion":1,"plugins":[{"id":"dev.panestra.codex","name":"Codex","version":"0.1.0","package":"codex.zip","manifest":"codex.json","signature":"codex.sig"}]}`)} {
		if err := os.WriteFile(filepath.Join(manager.Seed, name), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	task, err := manager.BeginTask("download", manifest.ID, "owner")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := manager.Task(task.Token, "other"); err == nil {
		t.Fatal("another device read download task")
	}
	deadline := time.Now().Add(5 * time.Second)
	for task.State == "pending" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
		task, err = manager.Task(task.Token, "owner")
		if err != nil {
			t.Fatal(err)
		}
	}
	if task.State != "complete" || task.Preview == nil || task.Preview.Manifest.ID != manifest.ID {
		t.Fatal("background download failed", task.State, task.Error)
	}
	if len(manager.All()) != 0 {
		t.Fatal("download executed worker before consent")
	}
	if _, err := manager.Apply(task.Preview.Token, "owner", nil); err != nil {
		t.Fatal(err)
	}
}
func signed(t *testing.T, m backplane.Manifest, binary []byte, sequence uint64, key ed25519.PrivateKey) ([]byte, []byte, []byte) {
	t.Helper()
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	files := map[string]string{}
	for name, raw := range map[string][]byte{"manifest.json": backplane.Raw(m), m.Engine.Entry: binary} {
		entry, err := archive.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		entry.Write(raw)
		digest := sha256.Sum256(raw)
		files[name] = hex.EncodeToString(digest[:])
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(buffer.Bytes())
	meta := release.Metadata{SchemaVersion: 1, Product: "Panestra", Version: m.Version, ReleaseSequence: sequence, APIVersion: 1, SHA256: hex.EncodeToString(digest[:]), Size: int64(buffer.Len()), Files: files, PluginID: m.ID}
	raw, _ := json.Marshal(meta)
	return buffer.Bytes(), raw, ed25519.Sign(key, raw)
}
func TestSignedLifecycleFailureIsolationAndReinstall(t *testing.T) {
	manifest, binary := fixture(t)
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	dir := t.TempDir()
	s, err := store.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	manager, err := Open(ctx, s, dir, pub)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.StopAll()
	artifact, metadata, signature := signed(t, manifest, binary, 1, key)
	invalid := append([]byte{}, signature...)
	invalid[0] ^= 1
	if _, err = manager.Preview(manifest.ID, "owner", artifact, metadata, invalid); err == nil {
		t.Fatal("forged signature accepted")
	}
	if len(manager.All()) != 0 {
		t.Fatal("unverified package registered")
	}
	preview, err := manager.Preview(manifest.ID, "owner", artifact, metadata, signature)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = manager.Apply(preview.Token, "other-owner", nil); err == nil {
		t.Fatal("another device consumed install preview")
	}
	worker, err := manager.Apply(preview.Token, "owner", nil)
	if err != nil {
		t.Fatal(err)
	}
	originalPID := worker.Status()["pid"]
	if originalPID == 0 || worker.Status()["status"] != "running" {
		t.Fatal("downloaded worker did not run")
	}
	response, err := worker.Request(ctx, backplane.Request{Operation: "status", Role: "viewer", Body: json.RawMessage(`{}`)})
	if err != nil || response.Status != 200 {
		t.Fatal("external worker status failed", err)
	}
	badArtifact, badMetadata, badSignature := signed(t, manifest, []byte("invalid executable"), 2, key)
	failed, err := manager.Preview(manifest.ID, "owner", badArtifact, badMetadata, badSignature)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = manager.Apply(failed.Token, "owner", nil); err == nil {
		t.Fatal("unhealthy candidate accepted")
	}
	if manager.Get(manifest.ID) != worker || worker.Status()["pid"] != originalPID {
		t.Fatal("failed update replaced running worker")
	}
	var applied uint64
	_ = s.DB.QueryRow("SELECT applied_seq FROM plugin_package_state WHERE plugin_id=?", manifest.ID).Scan(&applied)
	if applied != 1 {
		t.Fatal("failed update advanced sequence")
	}
	if _, err = manager.Preview(manifest.ID, "owner", badArtifact, badMetadata, badSignature); err != nil {
		t.Fatal("verified failed package cannot be retried", err)
	}
	if err = manager.SetEnabled(manifest.ID, false); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(ctx, s, dir, pub)
	if err != nil {
		t.Fatal(err)
	}
	if err = restored.StartAll(); err != nil {
		t.Fatal(err)
	}
	defer restored.StopAll()
	if restored.Get(manifest.ID).Status()["pid"] != 0 {
		t.Fatal("disabled plugin auto-started after restart")
	}
	retained := filepath.Join(worker.DataDir, "keep.txt")
	os.WriteFile(retained, []byte("synthetic retained data"), 0600)
	if err = manager.Uninstall(manifest.ID); err != nil {
		t.Fatal(err)
	}
	if manager.Get(manifest.ID) != nil {
		t.Fatal("uninstalled plugin remained executable")
	}
	if _, err = os.Stat(retained); err != nil {
		t.Fatal("uninstall removed data")
	}
	preview, err = manager.Preview(manifest.ID, "owner", artifact, metadata, signature)
	if err != nil {
		t.Fatal("same signed version cannot reinstall", err)
	}
	if _, err = manager.Apply(preview.Token, "owner", nil); err != nil {
		t.Fatal(err)
	}
	if _, err = manager.Preview(manifest.ID, "owner", artifact, metadata, signature); err == nil {
		t.Fatal("installed release replay accepted")
	}
	manager.StopAll()
	reopened, err := Open(ctx, s, dir, pub)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.StopAll()
	if err = reopened.StartAll(); err != nil {
		t.Fatal(err)
	}
	wait, cancelWait := context.WithTimeout(ctx, 5*time.Second)
	defer cancelWait()
	if err = reopened.Get(manifest.ID).WaitReady(wait); err != nil {
		t.Fatal("installed package did not recover offline", err)
	}
}
func TestNewRequiredPermissionNeedsConsentAndCorruptionRefused(t *testing.T) {
	manifest, binary := fixture(t)
	manifest.Permissions = append(manifest.Permissions, backplane.Permission{ID: "example.metrics.read", Required: true})
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	dir := t.TempDir()
	s, err := store.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	manager, err := Open(context.Background(), s, dir, pub)
	if err != nil {
		t.Fatal(err)
	}
	defer manager.StopAll()
	artifact, metadata, signature := signed(t, manifest, binary, 1, key)
	preview, err := manager.Preview(manifest.ID, "owner", artifact, metadata, signature)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = manager.Apply(preview.Token, "owner", nil); err == nil {
		t.Fatal("required permission installed without consent")
	}
	worker, err := manager.Apply(preview.Token, "owner", []string{"example.metrics.read"})
	if err != nil {
		t.Fatal(err)
	}
	worker.Stop()
	if err = os.WriteFile(worker.Binary, []byte("tampered executable"), 0600); err != nil {
		t.Fatal(err)
	}
	if opened, err := Open(context.Background(), s, dir, pub); err == nil {
		opened.StopAll()
		t.Fatal("modified installed executable accepted after restart")
	}
}
