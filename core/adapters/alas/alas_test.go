package alas

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestBridgeAuthenticationIdentityAndResponseValidation(t *testing.T) {
	reading := Reading{Schema: 1, BridgeID: "test-bridge", ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Instances: []Instance{{Name: "alas", State: "running", CurrentTask: "Main", Tasks: []Task{{Name: "Reward", NextRun: time.Now().UTC().Format(time.RFC3339)}}}}}
	code := 200
	host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/panestra/status" || r.Method != "GET" || r.Header.Get("Authorization") != "Bearer test-secret" {
			t.Error("incorrect bridge request")
		}
		w.WriteHeader(code)
		json.NewEncoder(w).Encode(reading)
	}))
	defer host.Close()
	_, rawPort, _ := net.SplitHostPort(strings.TrimPrefix(host.URL, "http://"))
	port, _ := strconv.Atoi(rawPort)
	c := Config{Port: port, Secret: "test-secret", BridgeID: "test-bridge"}
	if _, err := Read(context.Background(), c); err != nil {
		t.Fatal(err)
	}
	original := reading
	for _, change := range []func(){func() { reading.BridgeID = "other" }, func() { reading.ObservedAt = time.Now().Add(-3 * time.Minute).Format(time.RFC3339) }, func() { reading.Instances = nil }, func() { reading.Instances = []Instance{original.Instances[0], original.Instances[0]} }, func() { reading.Instances = []Instance{{Name: "../other", State: "running"}} }, func() { reading.Instances = []Instance{{Name: "alas", State: "invented"}} }, func() {
		reading.Instances = []Instance{{Name: "alas", State: "running", CurrentTask: "secret arbitrary text"}}
	}} {
		reading = original
		change()
		if _, err := Read(context.Background(), c); err == nil {
			t.Fatal("invalid reading accepted")
		}
	}
	reading = original
	for _, value := range []int{302, 401, 403, 404, 500} {
		code = value
		if _, err := Read(context.Background(), c); err == nil || strings.Contains(err.Error(), c.Secret) {
			t.Fatal("HTTP failure not safely handled", value)
		}
	}
}

func fakeRoot(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, file := range []string{"gui.py", "module/webui/process_manager.py", "toolkit/python.exe"} {
		filename := filepath.Join(root, filepath.FromSlash(file))
		os.MkdirAll(filepath.Dir(filename), 0700)
		os.WriteFile(filename, []byte("unchanged fixture"), 0600)
	}
	return root
}
func TestPreparationIsReadOnlyAndPublicStatusHasNoPrivatePaths(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := NewService(ctx, t.TempDir(), nil)
	root := fakeRoot(t)
	on := true
	port := 22268
	instance := "alas"
	if _, err := s.Configure(Change{Root: &root, Port: &port, Instance: &instance, Enabled: &on}, true); err != nil {
		t.Fatal(err)
	}
	setup := s.Setup()
	resolvedRoot, _ := filepath.EvalSymlinks(root)
	if !setup.Prepared || setup.Root != resolvedRoot {
		t.Fatal("preparation missing")
	}
	raw, err := os.ReadFile(setup.Launcher)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), s.config.Secret) || !strings.Contains(string(raw), "--port 22268") {
		t.Fatal("launcher leaked credential or wrong port")
	}
	public, _ := json.Marshal(s.Snapshot())
	if strings.Contains(string(public), root) || strings.Contains(string(public), s.config.Secret) || strings.Contains(string(public), s.config.BridgeID) {
		t.Fatal("public status leaks private configuration")
	}
	protected, _ := os.ReadFile(s.filename)
	if strings.Contains(string(protected), s.config.Secret) {
		t.Fatal("plaintext persisted")
	}
	for _, file := range []string{"gui.py", "module/webui/process_manager.py", "toolkit/python.exe"} {
		raw, _ := os.ReadFile(filepath.Join(root, filepath.FromSlash(file)))
		if string(raw) != "unchanged fixture" {
			t.Fatal("ALAS source changed")
		}
	}
	oldID := s.config.BridgeID
	nextPort := 22269
	if _, err := s.Configure(Change{Port: &nextPort}, false); err == nil {
		t.Fatal("port changed without prepared launcher")
	}
	if _, err := s.Configure(Change{Port: &nextPort}, true); err != nil {
		t.Fatal(err)
	}
	if oldID == s.config.BridgeID {
		t.Fatal("old server can accept changed bridge configuration")
	}
	if _, err := s.Configure(Change{ClearConfiguration: true}, false); err != nil {
		t.Fatal(err)
	}
	if s.Snapshot().Enabled || s.Setup().Root != "" || s.Snapshot().HasConfiguration {
		t.Fatal("forget did not clear configuration")
	}
}

func TestLatePollCannotRestoreClearedConnection(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := NewService(ctx, t.TempDir(), nil)
	entered, release := make(chan struct{}), make(chan struct{})
	s.fetch = func(context.Context, Config) (Reading, error) {
		close(entered)
		<-release
		return Reading{ObservedAt: time.Now().UTC().Format(time.RFC3339), Instances: []Instance{{Name: "alas", State: "running"}}}, nil
	}
	root := fakeRoot(t)
	on := true
	if _, err := s.Configure(Change{Root: &root, Enabled: &on}, true); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("poll did not start")
	}
	if _, err := s.Configure(Change{ClearConfiguration: true}, false); err != nil {
		t.Fatal(err)
	}
	close(release)
	time.Sleep(30 * time.Millisecond)
	if s.Snapshot().State != "disabled" || len(s.Snapshot().Instances) != 0 {
		t.Fatal("old poll restored state")
	}
}
