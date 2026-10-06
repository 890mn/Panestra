package server

import (
	"strings"
	"testing"
)

func TestClashAuthorizationAndSecretRedaction(t *testing.T) {
	s, h, token := setup(t)
	base := "/api/v1/integrations/clash"
	code, _ := api(t, h, "", "GET", base, nil)
	if code != 401 {
		t.Fatal("unauthenticated read", code)
	}
	code, data := api(t, h, token, "POST", base, map[string]any{"enabled": false, "autoDetect": false, "controller": "http://127.0.0.1:9097", "secret": "fixture-clash-private"})
	if code != 200 || strings.Contains(string(data), "fixture-clash-private") {
		t.Fatal("unsafe credential response", code)
	}
	for _, role := range []string{"operator", "viewer"} {
		s.Store.DB.Exec("UPDATE devices SET role=? WHERE id='owner-device'", role)
		code, _ = api(t, h, token, "POST", base, map[string]any{"allowControl": true})
		if code != 403 {
			t.Fatal("non-owner granted control", role, code)
		}
		code, data = api(t, h, token, "GET", base, nil)
		if code != 200 || strings.Contains(string(data), "fixture-clash-private") {
			t.Fatal("unsafe status", role, code)
		}
		code, _ = api(t, h, token, "POST", base+"/actions", map[string]any{"action": "mode", "mode": "global"})
		if code != 403 {
			t.Fatal("ungranted control accepted", role, code)
		}
	}
	s.Store.DB.Exec("UPDATE devices SET role='owner' WHERE id='owner-device'")
	code, _ = api(t, h, token, "POST", base, map[string]any{"controller": "http://192.168.1.1:9090"})
	if code != 400 {
		t.Fatal("remote controller accepted", code)
	}
	code, _ = api(t, h, token, "POST", base, map[string]any{"endpoint": "http://arbitrary.invalid"})
	if code != 400 {
		t.Fatal("unknown endpoint override accepted", code)
	}
	code, _ = api(t, h, token, "POST", base, map[string]any{"clearCredential": true})
	if code != 200 {
		t.Fatal("revocation failed", code)
	}
	var count int
	if err := s.Store.DB.QueryRow("SELECT count(*) FROM audit_log WHERE actor || action || target || result || request_id LIKE '%fixture-clash-private%'").Scan(&count); err != nil || count != 0 {
		t.Fatal("secret reached audit", err, count)
	}
}
