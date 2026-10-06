package server

import "testing"

func TestNeteaseAuthorizationAndNoArbitraryExecution(t *testing.T) {
	s, h, token := setup(t)
	base := "/api/v1/integrations/netease"
	if code, _ := api(t, h, "", "GET", base, nil); code != 401 {
		t.Fatal("unauthenticated read", code)
	}
	if code, _ := api(t, h, token, "POST", base, map[string]any{"enabled": false, "executable": "arbitrary.exe"}); code != 400 {
		t.Fatal("arbitrary executable accepted", code)
	}
	if code, _ := api(t, h, token, "POST", base, map[string]any{"enabled": false}); code != 200 {
		t.Fatal("owner configuration denied", code)
	}
	for _, role := range []string{"operator", "viewer"} {
		s.Store.DB.Exec("UPDATE devices SET role=? WHERE id='owner-device'", role)
		if code, _ := api(t, h, token, "POST", base, map[string]any{"allowControl": true}); code != 403 {
			t.Fatal("non-owner granted control", role, code)
		}
		if code, _ := api(t, h, token, "GET", base, nil); code != 200 {
			t.Fatal("paired read denied", role, code)
		}
		if code, _ := api(t, h, token, "POST", base+"/actions", map[string]any{"action": "toggle"}); code != 403 {
			t.Fatal("ungranted playback accepted", role, code)
		}
	}
}
