package server

import "testing"

func TestAlasAuthorizationAndReadOnlyRoutes(t *testing.T) {
	s, h, token := setup(t)
	base := "/api/v1/integrations/alas"
	if code, _ := api(t, h, "", "GET", base, nil); code != 401 {
		t.Fatal("anonymous read", code)
	}
	if code, _ := api(t, h, token, "POST", base, map[string]any{"enabled": false, "executable": "arbitrary"}); code != 400 {
		t.Fatal("arbitrary executable accepted", code)
	}
	if code, _ := api(t, h, token, "GET", base+"/setup", nil); code != 200 {
		t.Fatal("owner setup denied", code)
	}
	for _, role := range []string{"operator", "viewer"} {
		s.Store.DB.Exec("UPDATE devices SET role=? WHERE id='owner-device'", role)
		if code, _ := api(t, h, token, "GET", base, nil); code != 200 {
			t.Fatal("paired read denied", role, code)
		}
		if code, _ := api(t, h, token, "GET", base+"/setup", nil); code != 403 {
			t.Fatal("private path exposed", role, code)
		}
		for _, suffix := range []string{"", "/prepare"} {
			if code, _ := api(t, h, token, "POST", base+suffix, map[string]any{"enabled": true}); code != 403 {
				t.Fatal("non-owner configured", role, code)
			}
		}
		if code, _ := api(t, h, token, "POST", base+"/actions", map[string]any{"action": "start"}); code != 405 && code != 404 {
			t.Fatal("task execution route exposed", code)
		}
	}
}
