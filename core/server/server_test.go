package server

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"github.com/coder/websocket"
	"io"
	"net/http"
	"net/http/httptest"
	"panestra.local/panestra/core/backplane"
	"panestra.local/panestra/core/plugins"
	"panestra.local/panestra/core/protocol"
	"panestra.local/panestra/core/security"
	"panestra.local/panestra/core/store"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func setup(t *testing.T) (*Server, *httptest.Server, string) {
	t.Helper()
	dir := t.TempDir()
	s, err := store.Open(filepath.Join(dir, "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.DB.Close() })
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pkcs8, _ := x509.MarshalPKCS8PrivateKey(key)
	auth := security.NewAuth(s, &security.Identity{ServerID: "test-core", PrivateKey: pkcs8})
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	manager, err := plugins.Open(ctx, s, dir, plugins.PublisherKey())
	if err != nil {
		t.Fatal(err)
	}
	if err = manager.Bootstrap("../../artifacts/plugin-seed"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.StopAll)
	server := New(s, auth, manager.Get("dev.panestra.system"), dir, ctx)
	server.AttachPlugins(manager)
	httpServer := httptest.NewTLSServer(server.Handler(http.NotFoundHandler()))
	t.Cleanup(func() { server.Hub.Close(); httpServer.Close() })
	dkey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	pub, _ := x509.MarshalPKIXPublicKey(&dkey.PublicKey)
	challenge, _ := auth.Challenge("owner-device", base64.StdEncoding.EncodeToString(pub), "bootstrap")
	hash := sha256.Sum256([]byte(challenge.Message))
	sig, _ := ecdsa.SignASN1(rand.Reader, dkey, hash[:])
	token, _, err := auth.Bootstrap(auth.BootstrapCode(), "Owner", challenge.ID, base64.StdEncoding.EncodeToString(sig))
	if err != nil {
		t.Fatal(err)
	}
	return server, httpServer, token
}
func api(t *testing.T, server *httptest.Server, token, method, path string, body any) (int, []byte) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(method, server.URL+path, bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	response, err := server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	return response.StatusCode, raw
}
func socket(t *testing.T, s *httptest.Server, token string, lastSeq int64) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws, _, err := websocket.Dial(ctx, s.URL+"/ws/v1", &websocket.DialOptions{HTTPClient: s.Client()})
	if err != nil {
		t.Fatal(err)
	}
	ws.SetReadLimit(8 * 1024 * 1024)
	b, _ := json.Marshal(map[string]any{"type": "auth", "token": token, "lastServerSeq": lastSeq})
	if err = ws.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ws.CloseNow() })
	return ws
}
func readMessage(t *testing.T, ws *websocket.Conn) map[string]json.RawMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, b, err := ws.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var msg map[string]json.RawMessage
	if err = json.Unmarshal(b, &msg); err != nil {
		t.Fatal(err)
	}
	return msg
}
func TestTwoClientsConflictCatchupAndRevocation(t *testing.T) {
	server, httpServer, token := setup(t)
	first := socket(t, httpServer, token, 0)
	second := socket(t, httpServer, token, 0)
	readMessage(t, first)
	readMessage(t, second)
	var wg sync.WaitGroup
	codes := make(chan int, 2)
	for _, op := range []string{"operation-first", "operation-second"} {
		wg.Add(1)
		go func(op string) {
			defer wg.Done()
			status, _ := api(t, httpServer, token, "POST", "/api/v1/commands", protocol.Command{OpID: op, DeviceID: "owner-device", EntityID: "widget-cpu", BaseRev: 1, Command: "widget.update", Payload: json.RawMessage(`{"title":"同步标题"}`)})
			codes <- status
		}(op)
	}
	wg.Wait()
	a, b := <-codes, <-codes
	if !((a == 200 && b == 409) || (a == 409 && b == 200)) {
		t.Fatalf("expected success+conflict, got %d %d", a, b)
	}
	for _, ws := range []*websocket.Conn{first, second} {
		msg := readMessage(t, ws)
		if string(msg["type"]) != `"event"` || string(msg["serverSeq"]) != "1" {
			t.Fatalf("missing canonical event: %s", msg["serverSeq"])
		}
	}
	status, raw := api(t, httpServer, token, "POST", "/api/v1/commands", protocol.Command{OpID: "operation-third", DeviceID: "owner-device", EntityID: "widget-memory", BaseRev: 1, Command: "widget.update", Payload: json.RawMessage(`{"title":"内存同步"}`)})
	if status != 200 {
		t.Fatal(status, string(raw))
	}
	reconnect := socket(t, httpServer, token, 1)
	msg := readMessage(t, reconnect)
	if string(msg["serverSeq"]) != "2" {
		t.Fatal("catch-up gap", string(msg["serverSeq"]))
	}
	msg = readMessage(t, reconnect)
	if string(msg["type"]) != `"snapshot"` {
		t.Fatal("snapshot missing")
	}
	server.Store.DB.Exec("INSERT INTO devices VALUES('phone-device','Phone','unused','operator','now','now',NULL)")
	fakeToken := security.RandomToken()
	server.Store.DB.Exec("INSERT INTO sessions VALUES(?,?,?)", security.Hash(fakeToken), "phone-device", time.Now().Add(time.Minute).Unix())
	phone := socket(t, httpServer, fakeToken, 0)
	readMessage(t, phone)
	status, _ = api(t, httpServer, token, "POST", "/api/v1/devices/phone-device/revoke", map[string]any{})
	if status != 200 {
		t.Fatal("revoke failed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, _, err := phone.Read(ctx); err == nil {
		t.Fatal("revoked websocket stayed open")
	}
	status, _ = api(t, httpServer, fakeToken, "GET", "/api/v1/snapshot", nil)
	if status != 401 {
		t.Fatal("revoked bearer accepted")
	}
	for deviceID, wantCode := range map[string]string{"phone-device": "DEVICE_REVOKED", "unknown-device": "DEVICE_NOT_PAIRED"} {
		status, body := api(t, httpServer, "", "POST", "/api/v1/auth/challenge", map[string]any{"deviceId": deviceID, "publicKey": "", "purpose": "login"})
		var authError protocol.Error
		if err := json.Unmarshal(body, &authError); err != nil || status != 401 || authError.Code != wantCode {
			t.Fatalf("device auth error: status %d, body %s, error %v", status, body, err)
		}
	}
}
func TestAnonymousOriginAndRemotePairingDenied(t *testing.T) {
	s, _, _ := setup(t)
	handler := s.Handler(http.NotFoundHandler())
	for _, tt := range []struct {
		path, method, origin, remote, body string
		want                               int
	}{{"/api/v1/snapshot", "GET", "", "127.0.0.1:1", "", 401}, {"/api/v1/identity", "GET", "https://evil.example", "127.0.0.1:1", "", 403}, {"/ws/v1", "GET", "https://evil.example", "127.0.0.1:1", "", 403}, {"/api/v1/auth/bootstrap", "POST", "", "203.0.113.1:1", "{}", 403}, {"/api/v1/pairing/request", "POST", "", "203.0.113.1:1", `{"code":"guess","name":"Phone","challengeId":"fake","signature":"bad"}`, 400}} {
		req := httptest.NewRequest(tt.method, tt.path, bytes.NewBufferString(tt.body))
		req.RemoteAddr = tt.remote
		req.Header.Set("Origin", tt.origin)
		req.Header.Set("X-Forwarded-For", "127.0.0.1")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		if w.Code != tt.want {
			t.Errorf("%s got %d want %d: %s", tt.path, w.Code, tt.want, w.Body.String())
		}
	}
}
func TestTelemetryBackpressureAndPersistentDelivery(t *testing.T) {
	h := NewHub()
	p := &peer{events: make(chan []byte, 2), telemetry: make(chan []byte, 2), done: make(chan struct{}), topics: map[string]bool{"test/topic": true}}
	h.peers[p] = true
	for i := 0; i < 10000; i++ {
		h.Telemetry(backplane.Telemetry{Type: "telemetry", Topic: "test/topic", Seq: uint64(i)})
	}
	if h.dropped == 0 || len(p.telemetry) != 2 {
		t.Fatal("telemetry not bounded")
	}
	h.Event(protocol.Event{ServerSeq: 1})
	if len(p.events) != 1 {
		t.Fatal("telemetry blocked persistent event")
	}
	h.Event(protocol.Event{ServerSeq: 2})
	h.Event(protocol.Event{ServerSeq: 3})
	select {
	case <-p.done:
	default:
		t.Fatal("slow persistent subscriber not disconnected")
	}
}
