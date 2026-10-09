package server

// A relay is a separately paired device on the upstream Core. Its credentials never
// leave this service. Every downstream request is checked against both device roles
// and an explicit, per-device route grant; this is not an arbitrary HTTP proxy.
import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"panestra.local/panestra/core/backplane"
	"panestra.local/panestra/core/protocol"
	"panestra.local/panestra/core/security"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type relayConfig struct {
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	URI         string            `json:"uri"`
	Fingerprint string            `json:"fingerprint"`
	ServerID    string            `json:"serverId"`
	Grants      map[string]string `json:"grants"`
}
type relayPlugin struct {
	ID       string `json:"id"`
	Enabled  bool   `json:"enabled"`
	Manifest struct {
		Sources []struct {
			ID string `json:"id"`
		} `json:"sources"`
		Routes []struct {
			Path   string `json:"path"`
			Method string `json:"method"`
			Role   string `json:"role"`
		} `json:"routes"`
	} `json:"manifest"`
}
type relayView struct {
	relayConfig
	Status    string                         `json:"status"`
	Error     string                         `json:"error"`
	Online    bool                           `json:"online"`
	Role      string                         `json:"role"`
	Identity  map[string]any                 `json:"identity"`
	UpdatedAt string                         `json:"updatedAt"`
	Snapshot  *protocol.Snapshot             `json:"snapshot,omitempty"`
	Plugins   json.RawMessage                `json:"plugins,omitempty"`
	Telemetry map[string]backplane.Telemetry `json:"telemetry,omitempty"`
}
type relayRoute struct {
	mu                                             sync.Mutex
	config                                         relayConfig
	status, problem, token, pending, role, updated string
	identity                                       map[string]any
	snapshot                                       *protocol.Snapshot
	plugins                                        json.RawMessage
	manifest                                       []relayPlugin
	telemetry                                      map[string]backplane.Telemetry
	online                                         bool
	client                                         *http.Client
	ctx                                            context.Context
	cancel                                         context.CancelFunc
	wake                                           chan struct{}
	code                                           string // Pairing code is ephemeral and is never persisted or returned.
}
type relayManager struct {
	s      *Server
	mu     sync.Mutex
	routes map[string]*relayRoute
	err    error
}

func newRelayManager(s *Server) *relayManager {
	m := &relayManager{s: s, routes: map[string]*relayRoute{}}
	_, m.err = s.Store.DB.Exec("CREATE TABLE IF NOT EXISTS core_relays(id TEXT PRIMARY KEY, config TEXT NOT NULL)")
	if m.err != nil {
		return m
	}
	rows, err := s.Store.DB.Query("SELECT config FROM core_relays")
	if err != nil {
		m.err = err
		return m
	}
	var configs []relayConfig
	for rows.Next() {
		var raw string
		var c relayConfig
		if err = rows.Scan(&raw); err != nil {
			break
		}
		if err = json.Unmarshal([]byte(raw), &c); err != nil {
			break
		}
		configs = append(configs, c)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		m.err = err
		return m
	}
	for _, c := range configs {
		m.start(c, "")
	}
	return m
}
func relayHTTP(pin string) *http.Client {
	return &http.Client{Timeout: 12 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("中转地址不允许重定向") }, Transport: &http.Transport{Proxy: nil, TLSClientConfig: &tls.Config{
		MinVersion: tls.VersionTLS13,
		// Core certificates are self-signed. Replace PKI validation with the exact
		// user-confirmed SPKI pin, certificate lifetime and identity proof below.
		InsecureSkipVerify: true,
		VerifyConnection: func(cs tls.ConnectionState) error {
			if len(cs.PeerCertificates) == 0 {
				return errors.New("远端没有提供证书")
			}
			cert := cs.PeerCertificates[0]
			hash := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
			if hex.EncodeToString(hash[:]) != pin {
				return errors.New("远端 Core 身份指纹不匹配")
			}
			if time.Now().Before(cert.NotBefore) || time.Now().After(cert.NotAfter) {
				return errors.New("远端 Core 证书已过期或尚未生效")
			}
			return nil
		},
	}}}
}
func (m *relayManager) start(c relayConfig, code string) *relayRoute {
	ctx, cancel := context.WithCancel(m.s.Context)
	r := &relayRoute{config: c, ctx: ctx, cancel: cancel, client: relayHTTP(c.Fingerprint), wake: make(chan struct{}, 1), code: code, status: "connecting", telemetry: map[string]backplane.Telemetry{}, plugins: json.RawMessage("[]")}
	m.routes[c.ID] = r
	go r.run(m.s.Auth.Identity)
	return r
}
func (r *relayRoute) request(ctx context.Context, method, path, token string, body any, out any) error {
	var raw []byte
	var err error
	if body != nil {
		raw, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	req, err := http.NewRequestWithContext(ctx, method, r.config.URI+"/api/v1"+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	response, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 8*1024*1024+1))
	if err != nil {
		return err
	}
	if len(data) > 8*1024*1024 {
		return errors.New("远端响应过大")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var pe protocol.Error
		if json.Unmarshal(data, &pe) == nil && pe.Code != "" {
			return &pe
		}
		return fmt.Errorf("远端 Core 返回 HTTP %d", response.StatusCode)
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}
func (r *relayRoute) verify(ctx context.Context, localID string) error {
	nonce := security.RandomToken()
	var proof map[string]any
	if err := r.request(ctx, "GET", "/identity?nonce="+nonce, "", nil, &proof); err != nil {
		return err
	}
	serverID, _ := proof["serverId"].(string)
	pub, _ := proof["publicKey"].(string)
	sig, _ := proof["signature"].(string)
	decoded, err := base64.StdEncoding.DecodeString(pub)
	if err != nil {
		return errors.New("远端 Core 身份证明无效")
	}
	hash := sha256.Sum256(decoded)
	if serverID != r.config.ServerID || serverID == localID || hex.EncodeToString(hash[:]) != r.config.Fingerprint || !security.Verify(pub, "panestra:server:v1:"+nonce+":"+serverID, sig) {
		return errors.New("远端 Core 身份证明不匹配")
	}
	r.mu.Lock()
	r.identity = proof
	r.mu.Unlock()
	return nil
}
func (r *relayRoute) auth(id *security.Identity, purpose, code string) error {
	if err := r.verify(r.ctx, id.ServerID); err != nil {
		return err
	}
	parsed, err := x509.ParsePKCS8PrivateKey(id.PrivateKey)
	if err != nil {
		return err
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return errors.New("中转身份密钥类型无效")
	}
	pub, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return err
	}
	var challenge struct{ ID, Message string }
	if err = r.request(r.ctx, "POST", "/auth/challenge", "", map[string]string{"deviceId": "relay-" + id.ServerID, "publicKey": base64.StdEncoding.EncodeToString(pub), "purpose": purpose}, &challenge); err != nil {
		return err
	}
	prefix := "panestra:v1:" + r.config.ServerID + ":" + purpose + ":relay-" + id.ServerID + ":"
	if !strings.HasPrefix(challenge.Message, prefix) || len(strings.TrimPrefix(challenge.Message, prefix)) < 16 || len(challenge.Message) > 1024 {
		return errors.New("远端认证挑战未绑定中转身份")
	}
	hash := sha256.Sum256([]byte(challenge.Message))
	signature, err := ecdsa.SignASN1(rand.Reader, key, hash[:])
	if err != nil {
		return err
	}
	body := map[string]string{"challengeId": challenge.ID, "signature": base64.StdEncoding.EncodeToString(signature)}
	if purpose == "pair" {
		host, _ := os.Hostname()
		if host == "" {
			host = id.ServerID
		}
		body["name"] = "Panestra 中转 · " + host
		body["code"] = code
		var pending struct{ ID string }
		if err = r.request(r.ctx, "POST", "/pairing/request", "", body, &pending); err != nil {
			return err
		}
		r.mu.Lock()
		r.pending = pending.ID
		r.status = "pending"
		r.problem = ""
		r.mu.Unlock()
		return nil
	}
	var session struct {
		Token  string
		Device protocol.Device
	}
	if err = r.request(r.ctx, "POST", "/auth/login", "", body, &session); err != nil {
		return err
	}
	if session.Token == "" || session.Device.ID != "relay-"+id.ServerID || !roleAllows(session.Device.Role, "viewer") {
		return errors.New("远端返回的中转会话身份无效")
	}
	r.mu.Lock()
	r.token = session.Token
	r.role = session.Device.Role
	r.pending = ""
	r.status = "connecting"
	r.problem = ""
	r.mu.Unlock()
	return nil
}
func (r *relayRoute) pollPair(id *security.Identity) error {
	r.mu.Lock()
	pending := r.pending
	r.mu.Unlock()
	var result struct{ Status, Token string }
	if err := r.request(r.ctx, "GET", "/pairing/status/"+pending, "", nil, &result); err != nil {
		return err
	}
	if result.Status == "denied" {
		return errors.New("远端已拒绝中转配对")
	}
	if result.Status != "approved" {
		return nil
	}
	var d protocol.Device
	if err := r.request(r.ctx, "GET", "/me", result.Token, nil, &d); err != nil {
		return err
	}
	if d.ID != "relay-"+id.ServerID || !roleAllows(d.Role, "viewer") {
		return errors.New("远端配对身份不匹配")
	}
	r.mu.Lock()
	r.token = result.Token
	r.role = d.Role
	r.pending = ""
	r.problem = ""
	r.status = "connecting"
	r.mu.Unlock()
	return nil
}
func (r *relayRoute) run(id *security.Identity) {
	defer r.client.CloseIdleConnections()
	for r.ctx.Err() == nil {
		r.mu.Lock()
		code := r.code
		r.code = ""
		pending := r.pending
		token := r.token
		r.mu.Unlock()
		var err error
		if code != "" {
			err = r.auth(id, "pair", code)
		} else if pending != "" {
			err = r.pollPair(id)
		} else if token == "" {
			err = r.auth(id, "login", "")
		} else {
			err = r.stream(token)
		}
		if r.ctx.Err() != nil {
			return
		}
		if err != nil {
			var pe *protocol.Error
			needsPair := errors.As(err, &pe) && (pe.Code == "DEVICE_NOT_PAIRED" || pe.Code == "DEVICE_REVOKED" || pe.Code == "UNAUTHORIZED")
			r.mu.Lock()
			r.online = false
			r.token = ""
			r.problem = err.Error()
			r.status = "offline"
			if needsPair || pending != "" || code != "" {
				r.status = "pairing-required"
				r.pending = ""
				r.snapshot = nil
				r.telemetry = map[string]backplane.Telemetry{}
			}
			r.mu.Unlock()
		}
		r.mu.Lock()
		needsPair := r.status == "pairing-required"
		r.mu.Unlock()
		if needsPair {
			select {
			case <-r.ctx.Done():
				return
			case <-r.wake:
			}
		} else {
			select {
			case <-r.ctx.Done():
				return
			case <-r.wake:
			case <-time.After(2 * time.Second):
			}
		}
	}
}
func (r *relayRoute) refresh(ctx context.Context, token string) error {
	var snapshot protocol.Snapshot
	var plugins json.RawMessage
	var manifest []relayPlugin
	if err := r.request(ctx, "GET", "/snapshot", token, nil, &snapshot); err != nil {
		return err
	}
	if err := r.request(ctx, "GET", "/plugins", token, nil, &plugins); err != nil {
		return err
	}
	if err := json.Unmarshal(plugins, &manifest); err != nil {
		return err
	}
	r.mu.Lock()
	r.snapshot = &snapshot
	r.plugins = plugins
	r.manifest = manifest
	allowed := map[string]bool{}
	for _, p := range manifest {
		if p.Enabled {
			for _, source := range p.Manifest.Sources {
				allowed[p.ID+"/"+source.ID] = true
			}
		}
	}
	for topic := range r.telemetry {
		if !allowed[topic] {
			delete(r.telemetry, topic)
		}
	}
	r.updated = time.Now().UTC().Format(time.RFC3339)
	r.mu.Unlock()
	return nil
}
func (r *relayRoute) topics() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	topics := []string{}
	for _, p := range r.manifest {
		if p.Enabled {
			for _, source := range p.Manifest.Sources {
				topics = append(topics, p.ID+"/"+source.ID)
			}
		}
	}
	return topics
}
func (r *relayRoute) stream(token string) error {
	// A bounded stream lifetime renews remote authorization and the 15-minute token.
	ctx, cancel := context.WithTimeout(r.ctx, 10*time.Minute)
	defer cancel()
	if err := r.refresh(ctx, token); err != nil {
		return err
	}
	wsURL := strings.Replace(r.config.URI, "https://", "wss://", 1) + "/ws/v1"
	conn, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPClient: r.client})
	if err != nil {
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(8 * 1024 * 1024)
	write := func(value any) error {
		data, _ := json.Marshal(value)
		return conn.Write(ctx, websocket.MessageText, data)
	}
	if err = write(map[string]any{"type": "auth", "token": token, "lastServerSeq": 0}); err != nil {
		return err
	}
	if err = write(map[string]any{"type": "subscribe", "topics": r.topics()}); err != nil {
		return err
	}
	refreshCtx, stop := context.WithCancel(ctx)
	defer stop()
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-refreshCtx.Done():
				return
			case <-ticker.C:
				if r.refresh(refreshCtx, token) != nil {
					cancel()
					return
				}
				if write(map[string]any{"type": "subscribe", "topics": r.topics()}) != nil {
					cancel()
					return
				}
			}
		}
	}()
	for {
		_, raw, e := conn.Read(ctx)
		if e != nil {
			return e
		}
		var envelope struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(raw, &envelope) != nil {
			continue
		}
		switch envelope.Type {
		case "snapshot":
			var snapshot protocol.Snapshot
			if json.Unmarshal(raw, &snapshot) != nil {
				continue
			}
			r.mu.Lock()
			r.snapshot = &snapshot
			r.online = true
			r.status = "online"
			r.problem = ""
			r.updated = time.Now().UTC().Format(time.RFC3339)
			r.mu.Unlock()
		case "event":
			if e = r.refresh(ctx, token); e != nil {
				return e
			}
		case "telemetry":
			var t backplane.Telemetry
			if json.Unmarshal(raw, &t) != nil {
				continue
			}
			r.mu.Lock()
			r.telemetry[t.Topic] = t
			r.updated = time.Now().UTC().Format(time.RFC3339)
			r.mu.Unlock()
		}
	}
}
func effectiveRelayRole(local, grant, remote string) string {
	if grant == "" {
		return ""
	}
	if roleAllows(local, "operator") && grant == "operator" && roleAllows(remote, "operator") {
		return "operator"
	}
	return "viewer"
}
func (r *relayRoute) view(d protocol.Device, full bool) relayView {
	r.mu.Lock()
	defer r.mu.Unlock()
	c := r.config
	c.Grants = nil
	role := effectiveRelayRole(d.Role, r.config.Grants[d.ID], r.role)
	if d.Role == "owner" {
		c.Grants = make(map[string]string, len(r.config.Grants))
		for id, grant := range r.config.Grants {
			c.Grants[id] = grant
		}
	}
	v := relayView{relayConfig: c, Role: role, Status: r.status, Error: r.problem, Online: r.online, Identity: r.identity, UpdatedAt: r.updated}
	// Owners can configure the route but reading upstream data also needs a grant.
	if full && role != "" {
		v.Snapshot = r.snapshot
		v.Plugins = r.plugins
		v.Telemetry = make(map[string]backplane.Telemetry, len(r.telemetry))
		for topic, item := range r.telemetry {
			v.Telemetry[topic] = item
		}
	}
	return v
}
func (s *Server) relayRoutes(mux *http.ServeMux, protect func(bool, func(http.ResponseWriter, *http.Request, protocol.Device)) http.HandlerFunc) {
	m := s.Relays
	mux.HandleFunc("GET /api/v1/relays", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.err != nil {
			failure(w, m.err)
			return
		}
		views := []relayView{}
		for _, route := range m.routes {
			route.mu.Lock()
			visible := d.Role == "owner" || route.config.Grants[d.ID] != ""
			route.mu.Unlock()
			if visible {
				views = append(views, route.view(d, false))
			}
		}
		JSON(w, 200, views)
	}))
	mux.HandleFunc("POST /api/v1/relays", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		var request struct {
			URI         string            `json:"uri"`
			Fingerprint string            `json:"fingerprint"`
			Name        string            `json:"name"`
			Code        string            `json:"code"`
			Grants      map[string]string `json:"grants"`
		}
		if !decode(w, r, &request) {
			return
		}
		u, err := url.Parse(strings.TrimSpace(request.URI))
		pin := strings.ToLower(strings.TrimSpace(request.Fingerprint))
		decoded, pe := hex.DecodeString(pin)
		if err != nil || u == nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || pe != nil || len(decoded) != 32 {
			failure(w, errors.New("请填写完整 HTTPS 地址和 64 位 SHA-256 指纹"))
			return
		}
		if pin == s.Auth.Identity.Fingerprint() {
			failure(w, errors.New("不能把当前 Core 中转给自身"))
			return
		}
		if len(request.Name) > 128 || len(request.Grants) > 128 || len(request.Code) > 64 {
			failure(w, errors.New("中转设置过长"))
			return
		}
		for id, role := range request.Grants {
			if role != "viewer" && role != "operator" {
				failure(w, errors.New("中转仅支持查看或操作权限"))
				return
			}
			var n int
			if err = s.Store.DB.QueryRow("SELECT count(*) FROM devices WHERE id=? AND revoked_at IS NULL", id).Scan(&n); err != nil || n != 1 {
				failure(w, errors.New("授权设备不存在或已撤销"))
				return
			}
		}
		c := relayConfig{URI: strings.TrimRight(u.String(), "/"), Fingerprint: pin, Name: strings.TrimSpace(request.Name), Grants: request.Grants}
		if c.Name == "" {
			c.Name = u.Host
		}
		probe := &relayRoute{config: c, client: relayHTTP(pin)}
		defer probe.client.CloseIdleConnections()
		nonce := security.RandomToken()
		var proof map[string]any
		if err = probe.request(r.Context(), "GET", "/identity?nonce="+nonce, "", nil, &proof); err != nil {
			failure(w, err)
			return
		}
		c.ServerID, _ = proof["serverId"].(string)
		c.ID = c.ServerID
		probe.config = c
		if err = probe.verify(r.Context(), s.Auth.Identity.ServerID); err != nil {
			failure(w, err)
			return
		}
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.err != nil {
			failure(w, m.err)
			return
		}
		if len(m.routes) >= 16 && m.routes[c.ID] == nil {
			failure(w, errors.New("最多可中转 16 台 Core"))
			return
		}
		raw, _ := json.Marshal(c)
		if _, err = s.Store.DB.Exec("INSERT INTO core_relays(id,config) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config", c.ID, string(raw)); err != nil {
			failure(w, err)
			return
		}
		if old := m.routes[c.ID]; old != nil {
			old.cancel()
		}
		route := m.start(c, request.Code)
		s.Store.Audit(d.ID, "relay.configure", c.ID, "success", r.Header.Get("X-Request-ID"))
		JSON(w, 200, route.view(d, false))
	}))
	mux.HandleFunc("POST /api/v1/relays/{id}/remove", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		m.mu.Lock()
		defer m.mu.Unlock()
		id := r.PathValue("id")
		if _, err := s.Store.DB.Exec("DELETE FROM core_relays WHERE id=?", id); err != nil {
			failure(w, err)
			return
		}
		if route := m.routes[id]; route != nil {
			route.cancel()
			delete(m.routes, id)
		}
		s.Store.Audit(d.ID, "relay.remove", id, "success", r.Header.Get("X-Request-ID"))
		JSON(w, 200, map[string]bool{"ok": true})
	}))
	lookup := func(id string, d protocol.Device) (*relayRoute, error) {
		m.mu.Lock()
		route := m.routes[id]
		m.mu.Unlock()
		if route == nil {
			return nil, &protocol.Error{Code: "FORBIDDEN", Message: "此设备没有该主机的中转权限"}
		}
		route.mu.Lock()
		grant := route.config.Grants[d.ID]
		route.mu.Unlock()
		if grant == "" {
			return nil, &protocol.Error{Code: "FORBIDDEN", Message: "此设备没有该主机的中转权限"}
		}
		return route, nil
	}
	mux.HandleFunc("GET /api/v1/relays/{id}/state", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		route, err := lookup(r.PathValue("id"), d)
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, route.view(d, true))
	}))
	mux.HandleFunc("POST /api/v1/relays/{id}/request", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		route, err := lookup(r.PathValue("id"), d)
		if err != nil {
			failure(w, err)
			return
		}
		var request struct {
			Path string          `json:"path"`
			Body json.RawMessage `json:"body,omitempty"`
		}
		if !decode(w, r, &request) {
			return
		}
		method := "GET"
		if len(request.Body) > 0 {
			method = "POST"
		}
		route.mu.Lock()
		token := route.token
		online := route.online
		role := effectiveRelayRole(d.Role, route.config.Grants[d.ID], route.role)
		manifest := route.manifest
		route.mu.Unlock()
		if !online || token == "" {
			failure(w, errors.New("中转主机离线，暂时无法操作"))
			return
		}
		allowed := method == "GET" && (request.Path == "/snapshot" || request.Path == "/plugins")
		if method == "POST" && request.Path == "/commands" && role == "operator" {
			allowed = true
			var command protocol.Command
			if err = json.Unmarshal(request.Body, &command); err != nil {
				failure(w, err)
				return
			}
			command.DeviceID = "relay-" + s.Auth.Identity.ServerID
			request.Body, _ = json.Marshal(command)
		}
		for _, p := range manifest {
			if p.Enabled {
				for _, v := range p.Manifest.Routes {
					if strings.HasPrefix(v.Path, "/integrations/") && v.Path == request.Path && v.Method == method && (v.Role == "viewer" || v.Role == "operator") && roleAllows(role, v.Role) {
						allowed = true
					}
				}
			}
		}
		// Never delegate plugin installation/configuration, pairing, device management
		// or another relay, even if a manifest were to name those reserved paths.
		if strings.Contains(request.Path, "..") || strings.ContainsAny(request.Path, "?%#\\") || strings.HasPrefix(request.Path, "/relays") || strings.HasPrefix(request.Path, "/auth") || strings.HasPrefix(request.Path, "/devices") || strings.HasPrefix(request.Path, "/pairing") {
			allowed = false
		}
		if !allowed {
			failure(w, &protocol.Error{Code: "FORBIDDEN", Message: "中转权限不允许此操作，请在主机上管理插件和设备"})
			return
		}
		var out json.RawMessage
		ctx, cancel := context.WithCancel(r.Context())
		stop := context.AfterFunc(route.ctx, cancel)
		defer stop()
		defer cancel()
		err = route.request(ctx, method, request.Path, token, request.Body, &out)
		s.Store.Audit(d.ID, "relay."+strings.ToLower(method), route.config.ID, fmt.Sprint(err == nil), r.Header.Get("X-Request-ID"))
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, out)
	}))
}
