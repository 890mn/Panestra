package server

import (
	"encoding/json"
	"panestra.local/panestra/core/protocol"
	"panestra.local/panestra/core/security"
	"testing"
)

func TestDeviceUpdateAuthorization(t *testing.T) {
	s, httpServer, token := setup(t)
	if status, _ := api(t, httpServer, token, "POST", "/api/v1/devices/owner-device/update", map[string]string{"name": "My Core", "role": "viewer"}); status != 403 {
		t.Fatal("owner changed its own role", status)
	}
	if status, raw := api(t, httpServer, token, "POST", "/api/v1/devices/owner-device/update", map[string]string{"name": "家中电脑", "role": "owner"}); status != 200 {
		t.Fatalf("rename failed %d %s", status, raw)
	}
	owner, err := s.Auth.Device("owner-device")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Store.DB.Exec("INSERT INTO devices VALUES('reader-device','Reader',?,'viewer','now','now',NULL)", owner.PublicKey); err != nil {
		t.Fatal(err)
	}
	// Insert a hashed test bearer; production validation still checks its role.
	const viewerToken = "device-update-test-token"
	if _, err = s.Store.DB.Exec("INSERT INTO sessions VALUES(?,?,?)", security.Hash(viewerToken), "reader-device", int64(4102444800)); err != nil {
		t.Fatal(err)
	}
	if status, _ := api(t, httpServer, viewerToken, "POST", "/api/v1/devices/owner-device/update", map[string]string{"name": "Bad", "role": "viewer"}); status != 403 {
		t.Fatal("viewer updated devices", status)
	}
	status, raw := api(t, httpServer, token, "POST", "/api/v1/devices/reader-device/update", map[string]string{"name": "平板", "role": "operator"})
	var updated protocol.Device
	if status != 200 || json.Unmarshal(raw, &updated) != nil || updated.PublicKey != "" || updated.Name != "平板" || updated.Role != "operator" {
		t.Fatalf("invalid update response %d %s", status, raw)
	}
}
