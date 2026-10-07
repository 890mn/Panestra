package server

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAccountAuthorizationAndCredentialRedaction(t *testing.T) {
	s, h, token := setup(t)
	for _, id := range []string{"glm", "deepseek"} {
		base := "/api/v1/integrations/" + id
		code, _ := api(t, h, "", "GET", base, nil)
		if code != 401 {
			t.Fatal("unauthenticated account read", code)
		}
		code, _ = api(t, h, token, "POST", base, map[string]any{"enabled": true})
		if code != 400 {
			t.Fatal("enabled without credential", code)
		}
		code, _ = api(t, h, token, "POST", base, map[string]any{"enabled": false, "apiKey": "fixture-private-key", "endpoint": "http://arbitrary.invalid"})
		if code != 400 {
			t.Fatal("remote endpoint accepted", code)
		}
		code, data := api(t, h, token, "POST", base, map[string]any{"enabled": false, "apiKey": "fixture-private-key"})
		var status struct {
			Enabled       bool
			HasCredential bool
			Windows       []any
			Balances      []any
		}
		if json.Unmarshal(data, &status) != nil || code != 200 || !status.HasCredential || status.Enabled || strings.Contains(string(data), "fixture-private-key") {
			t.Fatalf("unsafe credential response %d %s", code, data)
		}
		for _, role := range []string{"operator", "viewer"} {
			_, _ = s.Store.DB.Exec("UPDATE devices SET role=? WHERE id='owner-device'", role)
			code, _ = api(t, h, token, "POST", base, map[string]any{"clearCredential": true})
			if code != 403 {
				t.Fatal("non-owner changed credential", role, code)
			}
			code, data = api(t, h, token, "GET", base, nil)
			if code != 200 || strings.Contains(string(data), "fixture-private-key") {
				t.Fatal("unsafe read", role, code)
			}
			code, _ = api(t, h, token, "POST", base+"/refresh", map[string]any{})
			if code != 200 {
				t.Fatal("read-only refresh denied", role, code)
			}
		}
		_, _ = s.Store.DB.Exec("UPDATE devices SET role='owner' WHERE id='owner-device'")
		code, data = api(t, h, token, "POST", base, map[string]any{"clearCredential": true})
		if json.Unmarshal(data, &status) != nil || code != 200 || status.HasCredential || len(status.Windows) != 0 || len(status.Balances) != 0 {
			t.Fatal("credential revocation failed", code, string(data))
		}
		s.Hub.mu.Lock()
		latest := s.Hub.latest["dev.panestra."+id+"/account.usage"]
		s.Hub.mu.Unlock()
		if latest.Value.(map[string]any)["hasCredential"] == true {
			t.Fatal("revoked credential remains in telemetry")
		}
		var count int
		if err := s.Store.DB.QueryRow("SELECT count(*) FROM audit_log WHERE actor || action || target || result || request_id LIKE '%fixture-private-key%'").Scan(&count); err != nil || count != 0 {
			t.Fatal("credential audit check failed", err, count)
		}
	}
}
