package backplane

import (
	"bytes"
	"context"
	"encoding/binary"
	"os"
	"panestra.local/panestra/core/store"
	"path/filepath"
	"testing"
	"time"
)

func TestFrameBoundsAndCompatibility(t *testing.T) {
	var buffer bytes.Buffer
	f := Framer{R: &buffer, W: &buffer}
	if err := f.Write(Message{ID: "one", Method: "hello", Params: Raw(map[string]int{"protocolVersion": 1})}); err != nil {
		t.Fatal(err)
	}
	m, err := f.Read()
	if err != nil || m.ID != "one" {
		t.Fatal(m, err)
	}
	binary.Write(&buffer, binary.BigEndian, uint32(MaxFrame+1))
	if _, err = f.Read(); err == nil {
		t.Fatal("oversized frame accepted")
	}
	manifest, err := os.ReadFile("../../plugins/system/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = ParseManifest(manifest); err != nil {
		t.Fatal(err)
	}
	bad := bytes.Replace(manifest, []byte(`"required": true`), []byte(`"required": true`), 1)
	bad = bytes.Replace(bad, []byte("system.metrics.read"), []byte("unknown.required"), 1)
	if _, err = ParseManifest(bad); err == nil {
		t.Fatal("unknown required capability accepted")
	}
	bad = bytes.Replace(manifest, []byte("declarative"), []byte("host-js"), 1)
	if _, err = ParseManifest(bad); err == nil {
		t.Fatal("host JS accepted")
	}
}
func TestFilesystemScope(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "a.txt")
	os.WriteFile(inside, []byte("a"), 0600)
	outside := filepath.Join(t.TempDir(), "b.txt")
	os.WriteFile(outside, []byte("b"), 0600)
	if !WithinPath(root, inside) {
		r, re := filepath.EvalSymlinks(root)
		p, pe := filepath.EvalSymlinks(inside)
		rel, le := filepath.Rel(r, p)
		t.Fatalf("inside denied: root=%s target=%s resolved=%s %s errors=%v %v rel=%s %v", root, inside, r, p, re, pe, rel, le)
	}
	if WithinPath(root, outside) || WithinPath(root, filepath.Join(root, "..", "secret")) {
		t.Fatal("scope escape allowed")
	}
}
func TestPluginCrashIsolation(t *testing.T) {
	binary, err := filepath.Abs("../../artifacts/system-plugin.exe")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(binary); err != nil {
		t.Skip("build System Plugin before runtime integration test")
	}
	s, err := store.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	manifest, _ := os.ReadFile("../../plugins/system/manifest.json")
	r, err := NewRuntime(s, binary, manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err = r.Start(context.Background()); err == nil {
		t.Fatal("worker started without required grant")
	}
	if err = r.Grant("not.declared", true); err == nil {
		t.Fatal("undeclared capability granted")
	}
	r.Grant("system.metrics.read", true)
	samples := make(chan Telemetry, 32)
	r.Publish = func(t Telemetry) {
		select {
		case samples <- t:
		default:
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err = r.Start(ctx); err != nil {
		t.Fatal(err)
	}
	defer r.Stop()
	select {
	case sample := <-samples:
		if sample.Topic == "" {
			t.Fatal("empty sample")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("no real telemetry")
	}
	r.CrashForTest()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if r.Status()["restarts"].(int) > 0 && r.Status()["status"] == "running" {
			if _, err = s.Snapshot(); err != nil {
				t.Fatal("Core store failed after plugin crash", err)
			}
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatal("plugin did not recover")
}
func FuzzFrameParser(f *testing.F) {
	f.Add([]byte{0, 0, 0, 2, '{', '}'})
	f.Add([]byte{255, 255, 255, 255})
	f.Fuzz(func(t *testing.T, data []byte) { frame := Framer{R: bytes.NewReader(data)}; _, _ = frame.Read() })
}
