package clash

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestLocalControllerAndYAMLDiscovery(t *testing.T) {
	for _, bad := range []string{"pipe://bad/name", "pipe://host:9090", "pipe://..%2fprivate", "https://example.com:9443", "http://192.168.1.1:9090", "http://localhost", "http://localhost:9090/configs", "http://user:secret@127.0.0.1:9090", "http://127.0.0.1:9090?token=private", "file:///tmp/config", "http://127.0.0.1:70000"} {
		if _, err := Controller(bad); err == nil {
			t.Fatal("unsafe controller accepted", bad)
		}
	}
	for _, good := range []string{`\\.\pipe\verge-local`, "pipe://verge-local", "http://127.0.0.1:9097", "https://[::1]:9090/", "http://localhost:9090"} {
		if _, err := Controller(good); err != nil {
			t.Fatal(err)
		}
	}
	root := t.TempDir()
	dir := filepath.Join(root, "io.github.clash-verge-rev.clash-verge-rev")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "clash-verge.yaml")
	if err := os.WriteFile(file, []byte("external-controller: '0.0.0.0:9097'\nsecret: 'test # only: controller'\nproxies: []\n"), 0600); err != nil {
		t.Fatal(err)
	}
	found, err := Detect(root)
	if err != nil || found.Controller != "http://127.0.0.1:9097" || found.Secret != "test # only: controller" {
		t.Fatal("YAML discovery failed", err)
	}
	if err := os.WriteFile(file, []byte("external-controller: '192.168.1.1:9090'\nsecret: 'test-only'"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Detect(root); err == nil {
		t.Fatal("nonlocal detected controller accepted")
	}
	if err := os.WriteFile(file, []byte("external-controller: ''\nexternal-controller-pipe: '\\\\.\\pipe\\verge-local'\nsecret: 'fixture-secret'"), 0600); err != nil {
		t.Fatal(err)
	}
	found, err = Detect(root)
	if err != nil || found.Controller != "pipe://verge-local" {
		t.Fatal("named pipe discovery failed", err)
	}
}

func TestMihomoReadAndControlContracts(t *testing.T) {
	mode, node := "rule", "Tokyo"
	var patches, puts atomic.Int32
	unauthorized := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-only-controller-secret" {
			t.Error("wrong controller authorization")
		}
		w.Header().Set("Content-Type", "application/json")
		if unauthorized {
			w.WriteHeader(401)
			_, _ = w.Write([]byte(`{"error":"test-only-controller-secret"}`))
			return
		}
		switch {
		case r.Method == "GET" && r.URL.Path == "/configs":
			json.NewEncoder(w).Encode(map[string]string{"mode": mode})
		case r.Method == "GET" && r.URL.Path == "/proxies":
			json.NewEncoder(w).Encode(map[string]any{"proxies": map[string]any{
				"选择 / JP": map[string]any{"type": "Selector", "now": node, "all": []string{"Tokyo", "Osaka"}},
				"自动":      map[string]any{"type": "URLTest", "now": "Tokyo", "all": []string{"Tokyo", "Osaka"}},
				"DIRECT":  map[string]any{"type": "Direct"},
			}})
		case r.Method == "GET" && r.URL.Path == "/version":
			_, _ = w.Write([]byte(`{"version":"test-version"}`))
		case r.Method == "GET" && r.URL.Path == "/traffic":
			_, _ = w.Write([]byte("{\"up\":1024,\"down\":4096}\n"))
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		case r.Method == "PATCH" && r.URL.Path == "/configs":
			var change struct {
				Mode string `json:"mode"`
			}
			_ = json.NewDecoder(r.Body).Decode(&change)
			mode = change.Mode
			patches.Add(1)
			w.WriteHeader(204)
		case r.Method == "PUT" && r.URL.Path == "/proxies/选择 / JP":
			var change struct {
				Name string `json:"name"`
			}
			_ = json.NewDecoder(r.Body).Decode(&change)
			node = change.Name
			puts.Add(1)
			w.WriteHeader(204)
		default:
			t.Errorf("unexpected controller request %s %s", r.Method, r.URL.Path)
			w.WriteHeader(404)
		}
	}))
	defer server.Close()
	c := Config{Enabled: true, Controller: server.URL, Secret: "test-only-controller-secret"}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	reading, err := Read(ctx, c)
	if err != nil || reading.Mode != "rule" || len(reading.Groups) != 2 || reading.Upload == nil || *reading.Upload != 1024 || *reading.Download != 4096 {
		t.Fatal("real-shaped controller reading failed", reading, err)
	}
	if err := Execute(ctx, c, Action{Action: "mode", Mode: "global"}); err == nil || patches.Load() != 0 {
		t.Fatal("read-only configuration controlled mode")
	}
	c.AllowControl = true
	if err := Execute(ctx, c, Action{Action: "mode", Mode: "global"}); err != nil || mode != "global" || patches.Load() != 1 {
		t.Fatal("mode switch failed", err)
	}
	if err := Execute(ctx, c, Action{Action: "node", Group: "选择 / JP", Node: "Osaka"}); err != nil || node != "Osaka" || puts.Load() != 1 {
		t.Fatal("escaped group selection failed", err)
	}
	for _, action := range []Action{{Action: "system-proxy"}, {Action: "mode", Mode: "invalid"}, {Action: "node", Group: "自动", Node: "Tokyo"}, {Action: "node", Group: "选择 / JP", Node: "missing"}} {
		if err := Execute(ctx, c, action); err == nil {
			t.Fatal("unsupported control accepted", action)
		}
	}
	if puts.Load() != 1 || patches.Load() != 1 {
		t.Fatal("invalid action reached controller")
	}
	unauthorized = true
	_, err = Read(ctx, c)
	if err == nil || strings.Contains(err.Error(), c.Secret) {
		t.Fatal("authentication failure leaked secret")
	}
}

func TestProtectedConfigurationAndLatePollRevocation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := NewService(ctx, t.TempDir(), nil)
	started, finish := make(chan struct{}), make(chan struct{})
	s.fetch = func(context.Context, Config) (Reading, error) {
		close(started)
		<-finish
		return Reading{Mode: "global", Groups: []Group{}}, nil
	}
	enabled, automatic, control := true, false, true
	controller, secret := "http://127.0.0.1:9097", "test-only-private-controller-secret"
	status, err := s.Configure(Change{Enabled: &enabled, AutoDetect: &automatic, AllowControl: &control, Controller: &controller, Secret: &secret})
	if err != nil || status.State != "connecting" {
		t.Fatal(err, status)
	}
	<-started
	raw, err := os.ReadFile(s.filename)
	if err != nil || strings.Contains(string(raw), secret) {
		t.Fatal("controller secret not protected", err)
	}
	public, _ := json.Marshal(status)
	if strings.Contains(string(public), secret) {
		t.Fatal("controller secret reached public status")
	}
	enabled = false
	control = false
	if _, err = s.Configure(Change{Enabled: &enabled, AllowControl: &control}); err != nil {
		t.Fatal(err)
	}
	close(finish)
	time.Sleep(20 * time.Millisecond)
	if s.Snapshot().Enabled || s.Snapshot().Mode != "" {
		t.Fatal("late poll undid revocation")
	}
	if err = s.Control(ctx, Action{Action: "mode", Mode: "direct"}); err == nil {
		t.Fatal("revoked controller permission remained usable")
	}
	loaded := NewService(ctx, filepath.Dir(s.filename), nil).Snapshot()
	if loaded.Enabled || loaded.AllowControl || !loaded.HasCredential {
		t.Fatal("configuration persistence failed", loaded)
	}
}
