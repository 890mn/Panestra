package server

import (
	"encoding/json"
	"panestra.local/panestra/core/adapters/codex"
	"path/filepath"
	"testing"
	"time"
)

func TestCodexPermissionAndSafeFailure(t *testing.T) {
	t.Setenv("PANESTRA_CODEX_EXECUTABLE", filepath.Join(t.TempDir(), "missing.exe"))
	s, httpServer, token := setup(t)
	code, _ := api(t, httpServer, "", "GET", "/api/v1/integrations/codex", nil)
	if code != 401 {
		t.Fatal(code)
	}
	code, data := api(t, httpServer, token, "GET", "/api/v1/integrations/codex", nil)
	var status codex.Status
	_ = json.Unmarshal(data, &status)
	if code != 200 || status.Enabled {
		t.Fatalf("%d %s", code, data)
	}
	code, _ = api(t, httpServer, token, "POST", "/api/v1/integrations/codex", map[string]any{})
	if code != 400 {
		t.Fatal("missing flag accepted")
	}
	code, _ = api(t, httpServer, token, "POST", "/api/v1/integrations/codex", map[string]any{"enabled": true, "executable": "arbitrary.exe"})
	if code != 400 {
		t.Fatal("remote executable accepted")
	}
	code, _ = api(t, httpServer, token, "POST", "/api/v1/integrations/codex", map[string]any{"enabled": true})
	if code != 200 {
		t.Fatal(code)
	}
	end := time.Now().Add(time.Second)
	for time.Now().Before(end) && s.Codex.Snapshot().State != "not_found" {
		time.Sleep(time.Millisecond)
	}
	if s.Codex.Snapshot().State != "not_found" {
		t.Fatal(s.Codex.Snapshot())
	}
	var granted bool
	_ = s.Store.DB.QueryRow("SELECT granted FROM plugin_permissions WHERE plugin_id=? AND capability=?", codex.ID, codex.Permission).Scan(&granted)
	if !granted {
		t.Fatal("grant not persisted")
	}
	_, _ = s.Store.DB.Exec("UPDATE devices SET role='operator' WHERE id='owner-device'")
	code, _ = api(t, httpServer, token, "POST", "/api/v1/integrations/codex", map[string]any{"enabled": false})
	if code != 403 {
		t.Fatal("operator changed grant", code)
	}
	code, _ = api(t, httpServer, token, "POST", "/api/v1/integrations/codex/refresh", map[string]any{})
	if code != 200 {
		t.Fatal("operator cannot refresh", code)
	}
	_, _ = s.Store.DB.Exec("UPDATE devices SET role='owner' WHERE id='owner-device'")
	code, data = api(t, httpServer, token, "POST", "/api/v1/integrations/codex", map[string]any{"enabled": false})
	_ = json.Unmarshal(data, &status)
	if code != 200 || status.State != "disabled" || len(status.Buckets) != 0 {
		t.Fatalf("%d %s", code, data)
	}
	s.Hub.mu.Lock()
	latest := s.Hub.latest[codex.Topic]
	s.Hub.mu.Unlock()
	if latest.Value.(codex.Status).Enabled {
		t.Fatal("latest telemetry not cleared")
	}
}
