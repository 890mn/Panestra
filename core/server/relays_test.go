package server

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"panestra.local/panestra/core/backplane"
	"panestra.local/panestra/core/protocol"
	"panestra.local/panestra/core/security"
	"strings"
	"testing"
	"time"
)

func relayFixture(t *testing.T, id string) (*Server, *httptest.Server, string) {
	t.Helper()
	s, old, owner := setup(t)
	old.Close()
	s.Auth.Identity.ServerID = id
	parsed, _ := x509.ParsePKCS8PrivateKey(s.Auth.Identity.PrivateKey)
	key := parsed.(*ecdsa.PrivateKey)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), IPAddresses: []net.IP{net.ParseIP("127.0.0.1")}, NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	cert, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	s.Auth.Identity.Cert = cert
	tlsCert, err := s.Auth.Identity.TLS()
	if err != nil {
		t.Fatal(err)
	}
	h := httptest.NewUnstartedServer(s.Handler(http.NotFoundHandler()))
	h.TLS = &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{tlsCert}}
	h.StartTLS()
	t.Cleanup(func() {
		s.Relays.mu.Lock()
		for _, r := range s.Relays.routes {
			r.cancel()
		}
		s.Relays.mu.Unlock()
		s.Hub.Close()
		h.Close()
	})
	return s, h, owner
}
func relayDevice(t *testing.T, s *Server, id, role string) string {
	t.Helper()
	owner, err := s.Auth.Device("owner-device")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Store.DB.Exec("INSERT INTO devices VALUES(?,?,?,?,'now','now',NULL)", id, id, owner.PublicKey, role); err != nil {
		t.Fatal(err)
	}
	token := "relay-test-" + id
	if _, err = s.Store.DB.Exec("INSERT INTO sessions VALUES(?,?,?)", security.Hash(token), id, int64(4102444800)); err != nil {
		t.Fatal(err)
	}
	return token
}
func waitRelay(t *testing.T, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if check() {
			return
		}
		time.Sleep(40 * time.Millisecond)
	}
	t.Fatal("relay state did not converge")
}
func TestRelayRealPairingDelegationAndRevocation(t *testing.T) {
	gw, gwh, owner := relayFixture(t, "gateway-core")
	remote, rh, _ := relayFixture(t, "remote-core")
	viewer := relayDevice(t, gw, "tablet-reader", "viewer")
	operator := relayDevice(t, gw, "tablet-control", "operator")
	stranger := relayDevice(t, gw, "unshared", "operator")
	window := remote.Auth.OpenWindow(true)
	config := map[string]any{"uri": rh.URL, "fingerprint": remote.Auth.Identity.Fingerprint(), "name": "Home PC", "code": window.Code, "grants": map[string]string{"owner-device": "operator", "tablet-reader": "operator", "tablet-control": "operator"}}
	if status, _ := api(t, gwh, viewer, "POST", "/api/v1/relays", config); status != 403 {
		t.Fatal("viewer configured relay", status)
	}
	bad := map[string]any{"uri": rh.URL, "fingerprint": strings.Repeat("0", 64), "code": window.Code}
	if status, _ := api(t, gwh, owner, "POST", "/api/v1/relays", bad); status == 200 {
		t.Fatal("wrong remote pin accepted")
	}
	status, raw := api(t, gwh, owner, "POST", "/api/v1/relays", config)
	if status != 200 {
		t.Fatalf("configure %d %s", status, raw)
	}
	var view relayView
	if json.Unmarshal(raw, &view) != nil || view.ServerID != "remote-core" {
		t.Fatal("bad route identity", string(raw))
	}
	statePath := "/api/v1/relays/remote-core/state"
	requestPath := "/api/v1/relays/remote-core/request"
	if status, _ = api(t, gwh, stranger, "GET", statePath, nil); status != 403 {
		t.Fatal("unshared device read state", status)
	}
	if status, raw = api(t, gwh, stranger, "GET", "/api/v1/relays", nil); status != 200 || string(raw) != "[]\n" {
		t.Fatal("unshared route exposed", status, string(raw))
	}
	waitRelay(t, func() bool { return len(remote.Auth.Pending()) == 1 })
	pending := remote.Auth.Pending()[0]
	pub, _ := base64.StdEncoding.DecodeString(pending.PublicKey)
	pubHash := sha256.Sum256(pub)
	if pending.DeviceID != "relay-gateway-core" || hex.EncodeToString(pubHash[:]) != gw.Auth.Identity.Fingerprint() {
		t.Fatal("relay not bound to persistent gateway key")
	}
	if err := remote.Auth.Approve(pending.ID, "operator", true); err != nil {
		t.Fatal(err)
	}
	waitRelay(t, func() bool {
		_, raw = api(t, gwh, operator, "GET", statePath, nil)
		_ = json.Unmarshal(raw, &view)
		return view.Online
	})
	if status, raw = api(t, gwh, viewer, "GET", statePath, nil); status != 200 {
		t.Fatal(status, string(raw))
	}
	_ = json.Unmarshal(raw, &view)
	if view.Role != "viewer" || view.Snapshot == nil || view.Identity["serverId"] != "remote-core" || view.Grants != nil {
		t.Fatal("role clamp or remote snapshot failed", string(raw))
	}
	if strings.Contains(string(raw), "publicKey\":\"relay-test") || strings.Contains(string(raw), "token\"") {
		t.Fatal("remote token exposed")
	}
	var persisted string
	_ = gw.Store.DB.QueryRow("SELECT config FROM core_relays WHERE id='remote-core'").Scan(&persisted)
	if strings.Contains(persisted, window.Code) || strings.Contains(persisted, "token") {
		t.Fatal("pairing secret persisted")
	}
	command := map[string]any{"opId": "relay-edit-one", "deviceId": "forged-device", "entityId": "widget-cpu", "baseRev": 1, "command": "widget.update", "payload": map[string]string{"title": "Relayed processor"}}
	if status, _ = api(t, gwh, viewer, "POST", requestPath, map[string]any{"path": "/commands", "body": command}); status != 403 {
		t.Fatal("viewer wrote remote", status)
	}
	for _, path := range []string{"/devices", "/pairing/pending", "/relays", "/plugins/tasks", "/integrations/netease/config", "/snapshot?secret=x"} {
		if status, _ = api(t, gwh, operator, "POST", requestPath, map[string]any{"path": path}); status != 403 {
			t.Fatal("forbidden proxy path accepted", path, status)
		}
	}
	if status, raw = api(t, gwh, operator, "POST", requestPath, map[string]any{"path": "/commands", "body": command}); status != 200 {
		t.Fatalf("remote write %d %s", status, raw)
	}
	var event protocol.Event
	_ = json.Unmarshal(raw, &event)
	if event.DeviceID != "relay-gateway-core" {
		t.Fatal("did not substitute delegated actor")
	}
	waitRelay(t, func() bool {
		_, raw = api(t, gwh, operator, "GET", statePath, nil)
		_ = json.Unmarshal(raw, &view)
		return view.Snapshot != nil && view.Snapshot.ServerSeq == event.ServerSeq
	})
	remote.Hub.Telemetry(backplane.Telemetry{Type: "telemetry", Topic: "dev.panestra.system/cpu.usage", Seq: 12, TS: time.Now().Format(time.RFC3339), Value: 43.0})
	waitRelay(t, func() bool {
		_, raw = api(t, gwh, operator, "GET", statePath, nil)
		_ = json.Unmarshal(raw, &view)
		return view.Telemetry["dev.panestra.system/cpu.usage"].Seq == 12
	})
	// Restart only the gateway relay service, restoring the same approved identity
	// from persisted route config, without a code or another upstream approval.
	gw.Relays.mu.Lock()
	route := gw.Relays.routes["remote-core"]
	route.cancel()
	gw.Relays.mu.Unlock()
	restored := newRelayManager(gw)
	if restored.err != nil {
		t.Fatal(restored.err)
	}
	defer func() {
		for _, r := range restored.routes {
			r.cancel()
		}
	}()
	waitRelay(t, func() bool {
		return restored.routes["remote-core"].view(protocol.Device{ID: "tablet-control", Role: "operator"}, true).Online
	})
	if len(remote.Auth.Pending()) != 0 {
		t.Fatal("restart unexpectedly requested pairing")
	}
	// Revoke the remote gateway device: its socket is closed and no delegated
	// action can bypass the upstream authorization check with a cached token.
	if err := remote.Auth.Revoke("relay-gateway-core"); err != nil {
		t.Fatal(err)
	}
	remote.Hub.Revoke("relay-gateway-core")
	waitRelay(t, func() bool {
		return !restored.routes["remote-core"].view(protocol.Device{ID: "tablet-control", Role: "operator"}, true).Online
	})
	if status, _ = api(t, gwh, owner, "POST", "/api/v1/relays/remote-core/remove", map[string]bool{}); status != 200 {
		t.Fatal("remove failed")
	}
	if status, _ = api(t, gwh, operator, "GET", statePath, nil); status != 403 {
		t.Fatal("removed relay still exposed")
	}
}
