package server

import (
	"encoding/json"
	"panestra.local/panestra/core/security"
	"testing"
	"time"
)

func TestGenericPackageRolesDownloadAndReinstall(t *testing.T) {
	server, httpServer, owner := setup(t)
	_, err := server.Store.DB.Exec("INSERT INTO devices VALUES('package-viewer','Viewer','unused','viewer','now','now',NULL)")
	if err != nil {
		t.Fatal(err)
	}
	viewer := "package-viewer-session"
	_, err = server.Store.DB.Exec("INSERT INTO sessions VALUES(?,?,?)", security.Hash(viewer), "package-viewer", time.Now().Add(time.Minute).Unix())
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/plugins/uploads", "/plugins/uploads/unknown/chunk", "/plugins/uploads/unknown/finish", "/plugins/download", "/plugins/import", "/plugins/install", "/plugins/dev.panestra.codex/state", "/plugins/dev.panestra.codex/uninstall"} {
		status, _ := api(t, httpServer, viewer, "POST", "/api/v1"+path, map[string]any{})
		if status != 403 {
			t.Fatal("viewer reached package mutation", path, status)
		}
	}
	status, _ := api(t, httpServer, viewer, "POST", "/api/v1/plugins/tasks", map[string]any{"action": "download", "id": "dev.panestra.codex"})
	if status != 403 {
		t.Fatal("viewer started download task", status)
	}
	status, body := api(t, httpServer, viewer, "GET", "/api/v1/plugins/catalog", nil)
	if status != 200 {
		t.Fatal(status, string(body))
	}
	var catalog struct {
		Plugins []struct {
			ID string `json:"id"`
		} `json:"plugins"`
	}
	if json.Unmarshal(body, &catalog) != nil || len(catalog.Plugins) != 7 {
		t.Fatal("catalog unavailable to paired viewer")
	}
	var before int
	_ = server.Store.DB.QueryRow("SELECT count(*) FROM widgets").Scan(&before)
	status, body = api(t, httpServer, owner, "POST", "/api/v1/plugins/dev.panestra.codex/uninstall", map[string]any{})
	if status != 200 || server.Plugins.Get("dev.panestra.codex") != nil {
		t.Fatal("uninstall failed", status, string(body))
	}
	status, body = api(t, httpServer, owner, "POST", "/api/v1/plugins/download", map[string]any{"id": "dev.panestra.codex"})
	if status != 200 {
		t.Fatal("offline catalog download failed", status, string(body))
	}
	var preview struct {
		Token    string `json:"token"`
		Manifest struct {
			ID string `json:"id"`
		} `json:"manifest"`
	}
	if json.Unmarshal(body, &preview) != nil || preview.Token == "" || preview.Manifest.ID != "dev.panestra.codex" {
		t.Fatal("invalid permission preview")
	}
	status, body = api(t, httpServer, owner, "POST", "/api/v1/plugins/install", map[string]any{"token": preview.Token, "consent": []string{}})
	if status != 200 || server.Plugins.Get("dev.panestra.codex") == nil {
		t.Fatal("reinstall failed", status, string(body))
	}
	var after int
	_ = server.Store.DB.QueryRow("SELECT count(*) FROM widgets").Scan(&after)
	if after != before {
		t.Fatal("package management changed existing layout")
	}
	status, _ = api(t, httpServer, owner, "POST", "/api/v1/plugins/install", map[string]any{"token": preview.Token, "consent": []string{}})
	if status != 400 {
		t.Fatal("consumed install preview replayed")
	}
	status, _ = api(t, httpServer, owner, "POST", "/api/v1/plugins/dev.panestra.codex/state", map[string]any{"enabled": true, "grants": map[string]bool{"undeclared.read": true}})
	if status != 400 {
		t.Fatal("undeclared grant accepted")
	}
	status, body = api(t, httpServer, owner, "POST", "/api/v1/plugins/dev.panestra.codex/state", map[string]any{"enabled": false})
	if status != 200 {
		t.Fatal("stop failed", status, string(body))
	}
	server.Hub.mu.Lock()
	_, retained := server.Hub.latest["dev.panestra.codex/account.usage"]
	server.Hub.mu.Unlock()
	if retained {
		t.Fatal("disabled plugin retained live telemetry")
	}
}
