package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"panestra.local/panestra/core/adapters/accounts"
	"panestra.local/panestra/core/adapters/clash"
	"panestra.local/panestra/core/adapters/codex"
	"panestra.local/panestra/core/adapters/netease"
	"panestra.local/panestra/core/backplane"
	"panestra.local/panestra/core/protocol"
	"panestra.local/panestra/core/security"
	"panestra.local/panestra/core/store"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

type bucket struct {
	at    time.Time
	count int
}
type Server struct {
	Store          *store.Store
	Auth           *security.Auth
	Plugin         *backplane.Runtime
	Codex          *codex.Service
	Accounts       map[string]*accounts.Service
	Clash          *clash.Service
	Netease        *netease.Service
	codexUpdateMu  sync.Mutex
	Hub            *Hub
	DataDir        string
	Origins        map[string]bool
	Context        context.Context
	mu             sync.Mutex
	rates          map[string]bucket
	Started        time.Time
	pluginUpdateMu sync.Mutex
	ListenAddress  string
}

func New(s *store.Store, a *security.Auth, p *backplane.Runtime, dir string, ctx context.Context) *Server {
	srv := &Server{Store: s, Auth: a, Plugin: p, Hub: NewHub(), DataDir: dir, Context: ctx, Origins: map[string]bool{}, rates: map[string]bucket{}, Started: time.Now()}
	s.OnEvent = srv.Hub.Event
	srv.Accounts = map[string]*accounts.Service{}
	for _, id := range accounts.IDs {
		srv.Accounts[id] = accounts.NewService(ctx, id, filepath.Join(dir, "integrations"), func(status accounts.Status, seq uint64) {
			srv.Hub.Telemetry(backplane.Telemetry{Type: "telemetry", Topic: accounts.Topic(id), Seq: seq, TS: time.Now().UTC().Format(time.RFC3339), Value: status})
		})
	}
	p.Publish = srv.Hub.Telemetry
	srv.Clash = clash.NewService(ctx, filepath.Join(dir, "integrations"), func(status clash.Status, seq uint64) {
		srv.Hub.Telemetry(backplane.Telemetry{Type: "telemetry", Topic: clash.Topic, Seq: seq, TS: time.Now().UTC().Format(time.RFC3339), Value: status})
	})
	srv.Codex = codex.NewService(ctx, func(status codex.Status, seq uint64) {
		srv.Hub.Telemetry(backplane.Telemetry{Type: "telemetry", Topic: codex.Topic, Seq: seq, TS: time.Now().UTC().Format(time.RFC3339), Value: status})
	})
	srv.Netease = netease.NewService(ctx, filepath.Join(dir, "integrations"), func(status netease.Status, seq uint64) {
		srv.Hub.Telemetry(backplane.Telemetry{Type: "telemetry", Topic: netease.Topic, Seq: seq, TS: time.Now().UTC().Format(time.RFC3339), Value: status})
	})
	var granted bool
	_ = s.DB.QueryRow("SELECT granted FROM plugin_permissions WHERE plugin_id=? AND capability=?", codex.ID, codex.Permission).Scan(&granted)
	srv.Codex.SetEnabled(granted)
	return srv
}
func JSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func failure(w http.ResponseWriter, err error) {
	var pe *protocol.Error
	if errors.As(err, &pe) {
		status := 400
		switch pe.Code {
		case "REVISION_CONFLICT", "ENTITY_DELETED":
			status = 409
		case "UNAUTHORIZED", "DEVICE_REVOKED", "DEVICE_NOT_PAIRED":
			status = 401
		case "FORBIDDEN":
			status = 403
		}
		JSON(w, status, pe)
		return
	}
	JSON(w, 400, protocol.Error{Code: "REQUEST_FAILED", Message: err.Error()})
}
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		JSON(w, 400, protocol.Error{Code: "INVALID_JSON", Message: "请求格式无效"})
		return false
	}
	if d.Decode(new(any)) != io.EOF {
		JSON(w, 400, protocol.Error{Code: "INVALID_JSON", Message: "请求包含多余内容"})
		return false
	}
	return true
}
func (s *Server) rate(ip string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if len(s.rates) > 4096 {
		for k, v := range s.rates {
			if now.Sub(v.at) > time.Minute {
				delete(s.rates, k)
			}
		}
		if len(s.rates) > 4096 {
			return false
		}
	}
	v := s.rates[ip]
	if now.Sub(v.at) > time.Minute {
		v = bucket{at: now}
	}
	v.count++
	s.rates[ip] = v
	return v.count <= 40
}
func localRequest(r *http.Request) bool {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	return ip != nil && (ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast())
}
func loopback(r *http.Request) bool {
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return net.ParseIP(host).IsLoopback()
}
func (s *Server) originAllowed(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	return err == nil && (o == "https://"+r.Host || s.Origins[o] || u.Scheme == "tauri" && u.Host == "localhost")
}
func (s *Server) Handler(assets http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/identity", func(w http.ResponseWriter, r *http.Request) {
		if nonce := r.URL.Query().Get("nonce"); nonce != "" {
			proof, err := s.Auth.Identity.PublicProof(nonce)
			if err != nil {
				failure(w, err)
				return
			}
			JSON(w, 200, proof)
			return
		}
		JSON(w, 200, map[string]any{"serverId": s.Auth.Identity.ServerID, "fingerprint": s.Auth.Identity.Fingerprint(), "apiVersion": protocol.APIVersion, "coreVersion": protocol.CoreVersion, "pairingRequired": true})
	})
	mux.HandleFunc("POST /api/v1/auth/challenge", func(w http.ResponseWriter, r *http.Request) {
		var p struct {
			DeviceID  string `json:"deviceId"`
			PublicKey string `json:"publicKey"`
			Purpose   string `json:"purpose"`
		}
		if !decode(w, r, &p) {
			return
		}
		if p.Purpose != "login" && p.Purpose != "pair" && p.Purpose != "bootstrap" {
			failure(w, errors.New("invalid challenge purpose"))
			return
		}
		c, err := s.Auth.Challenge(p.DeviceID, p.PublicKey, p.Purpose)
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, c)
	})
	mux.HandleFunc("POST /api/v1/auth/login", func(w http.ResponseWriter, r *http.Request) {
		var p struct {
			ChallengeID string `json:"challengeId"`
			Signature   string `json:"signature"`
		}
		if !decode(w, r, &p) {
			return
		}
		t, d, err := s.Auth.Login(p.ChallengeID, p.Signature)
		if err != nil {
			s.Store.Audit("anonymous", "auth.failure", "", "denied", r.Header.Get("X-Request-ID"))
			JSON(w, 401, protocol.Error{Code: "UNAUTHORIZED", Message: "认证失败或设备已撤销"})
			return
		}
		JSON(w, 200, map[string]any{"token": t, "device": d, "expiresIn": 900})
	})
	mux.HandleFunc("POST /api/v1/auth/bootstrap", func(w http.ResponseWriter, r *http.Request) {
		if !loopback(r) {
			JSON(w, 403, protocol.Error{Code: "FORBIDDEN", Message: "只能在 Core 本机认领"})
			return
		}
		var p struct {
			Code        string `json:"code"`
			Name        string `json:"name"`
			ChallengeID string `json:"challengeId"`
			Signature   string `json:"signature"`
		}
		if !decode(w, r, &p) {
			return
		}
		t, d, err := s.Auth.Bootstrap(p.Code, p.Name, p.ChallengeID, p.Signature)
		if err != nil {
			failure(w, err)
			return
		}
		s.Store.Audit(d.ID, "device.bootstrap", d.ID, "success", r.Header.Get("X-Request-ID"))
		JSON(w, 200, map[string]any{"token": t, "device": d, "expiresIn": 900})
	})
	mux.HandleFunc("POST /api/v1/pairing/request", func(w http.ResponseWriter, r *http.Request) {
		var p struct {
			Code        string `json:"code"`
			Name        string `json:"name"`
			ChallengeID string `json:"challengeId"`
			Signature   string `json:"signature"`
		}
		if !decode(w, r, &p) {
			return
		}
		pending, err := s.Auth.Pair(p.Code, p.Name, p.ChallengeID, p.Signature, localRequest(r))
		if err != nil {
			s.Store.Audit("anonymous", "pairing.request", "", "denied", r.Header.Get("X-Request-ID"))
			failure(w, err)
			return
		}
		s.Store.Audit(pending.DeviceID, "pairing.request", pending.ID, "pending", r.Header.Get("X-Request-ID"))
		JSON(w, 202, pending)
	})
	mux.HandleFunc("GET /api/v1/pairing/status/{id}", func(w http.ResponseWriter, r *http.Request) {
		p, err := s.Auth.Poll(r.PathValue("id"))
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, map[string]any{"status": p.Status, "token": p.Token, "deviceId": p.DeviceID})
	})
	protect := func(owner bool, h func(http.ResponseWriter, *http.Request, protocol.Device)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			d, err := s.Auth.Validate(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
			if err != nil {
				JSON(w, 401, protocol.Error{Code: "UNAUTHORIZED", Message: "会话已过期或设备已撤销"})
				return
			}
			if owner && d.Role != "owner" {
				JSON(w, 403, protocol.Error{Code: "FORBIDDEN", Message: "需要 Owner 权限"})
				return
			}
			h(w, r, d)
		}
	}
	mux.HandleFunc("GET /api/v1/me", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) { JSON(w, 200, d) }))
	s.accountRoutes(mux, protect)
	s.clashRoutes(mux, protect)
	s.neteaseRoutes(mux, protect)
	mux.HandleFunc("GET /api/v1/integrations/codex", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		JSON(w, 200, s.Codex.Snapshot())
	}))
	mux.HandleFunc("POST /api/v1/integrations/codex", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		var p struct {
			Enabled *bool `json:"enabled"`
		}
		if !decode(w, r, &p) {
			return
		}
		if p.Enabled == nil {
			JSON(w, 400, protocol.Error{Code: "INVALID_PAYLOAD", Message: "需要 enabled 字段"})
			return
		}
		s.codexUpdateMu.Lock()
		defer s.codexUpdateMu.Unlock()
		s.Store.Mu.Lock()
		_, err := s.Store.DB.Exec("INSERT INTO plugin_permissions VALUES(?,?,?) ON CONFLICT(plugin_id,capability) DO UPDATE SET granted=excluded.granted", codex.ID, codex.Permission, *p.Enabled)
		s.Store.Mu.Unlock()
		if err != nil {
			failure(w, err)
			return
		}
		s.Codex.SetEnabled(*p.Enabled)
		s.Store.Audit(d.ID, "codex.permission", codex.ID, map[bool]string{true: "enabled", false: "disabled"}[*p.Enabled], r.Header.Get("X-Request-ID"))
		JSON(w, 200, s.Codex.Snapshot())
	}))
	mux.HandleFunc("POST /api/v1/integrations/codex/refresh", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		s.Codex.Refresh()
		JSON(w, 200, s.Codex.Snapshot())
	}))
	mux.HandleFunc("GET /api/v1/snapshot", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		v, err := s.Store.Snapshot()
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, v)
	}))
	mux.HandleFunc("POST /api/v1/commands", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		var c protocol.Command
		if !decode(w, r, &c) {
			return
		}
		e, err := s.Store.Commit(d, c)
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, e)
	}))
	mux.HandleFunc("GET /api/v1/devices", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		rows, err := s.Store.DB.Query("SELECT id,name,role,created_at,last_seen_at,revoked_at FROM devices ORDER BY created_at")
		if err != nil {
			failure(w, err)
			return
		}
		defer rows.Close()
		devices := []protocol.Device{}
		for rows.Next() {
			var v protocol.Device
			if err = rows.Scan(&v.ID, &v.Name, &v.Role, &v.CreatedAt, &v.LastSeenAt, &v.RevokedAt); err != nil {
				failure(w, err)
				return
			}
			devices = append(devices, v)
		}
		JSON(w, 200, devices)
	}))
	mux.HandleFunc("POST /api/v1/devices/{id}/revoke", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		id := r.PathValue("id")
		if err := s.Auth.Revoke(id); err != nil {
			failure(w, err)
			return
		}
		s.Hub.Revoke(id)
		s.Store.Audit(d.ID, "device.revoke", id, "success", r.Header.Get("X-Request-ID"))
		JSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("POST /api/v1/pairing/window", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		if !loopback(r) {
			JSON(w, 403, protocol.Error{Code: "FORBIDDEN", Message: "请在 Core 本机打开配对窗口"})
			return
		}
		var p struct {
			Remote bool `json:"remote"`
		}
		if !decode(w, r, &p) {
			return
		}
		v := s.Auth.OpenWindow(p.Remote)
		s.Store.Audit(d.ID, "pairing.open", "", "success", r.Header.Get("X-Request-ID"))
		JSON(w, 200, struct {
			security.Window
			Endpoints []string `json:"endpoints"`
		}{v, pairingEndpoints(s.ListenAddress)})
	}))
	mux.HandleFunc("GET /api/v1/pairing/pending", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) { JSON(w, 200, s.Auth.Pending()) }))
	mux.HandleFunc("POST /api/v1/pairing/approve", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		var p struct {
			ID      string `json:"id"`
			Role    string `json:"role"`
			Approve bool   `json:"approve"`
		}
		if !decode(w, r, &p) {
			return
		}
		if err := s.Auth.Approve(p.ID, p.Role, p.Approve); err != nil {
			failure(w, err)
			return
		}
		s.Store.Audit(d.ID, "pairing.approve", p.ID, "success", r.Header.Get("X-Request-ID"))
		JSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("GET /api/v1/plugins", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		JSON(w, 200, []any{s.Plugin.Status()})
	}))
	mux.HandleFunc("GET /api/v1/plugins/system/update", protect(true, s.pluginUpdateStatus))
	mux.HandleFunc("POST /api/v1/plugins/system/update", protect(true, s.updatePlugin))
	mux.HandleFunc("POST /api/v1/plugins/system", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		s.pluginUpdateMu.Lock()
		defer s.pluginUpdateMu.Unlock()
		var p struct {
			Enabled bool `json:"enabled"`
			Metrics bool `json:"metrics"`
			Lock    bool `json:"lock"`
		}
		if !decode(w, r, &p) {
			return
		}
		s.Plugin.Stop()
		if err := s.Plugin.Grant("system.metrics.read", p.Metrics); err != nil {
			failure(w, err)
			return
		}
		if err := s.Plugin.Grant("system.session.lock", p.Lock); err != nil {
			failure(w, err)
			return
		}
		if p.Enabled {
			if err := s.Plugin.Start(s.Context); err != nil {
				failure(w, err)
				return
			}
		}
		s.Store.Audit(d.ID, "plugin.permissions", "dev.panestra.system", "success", r.Header.Get("X-Request-ID"))
		JSON(w, 200, s.Plugin.Status())
	}))
	mux.HandleFunc("POST /api/v1/actions/{id}", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		if d.Role != "owner" {
			JSON(w, 403, protocol.Error{Code: "FORBIDDEN", Message: "只有所有者可以锁定 Core 会话"})
			return
		}
		var p struct {
			OpID    string `json:"opId"`
			Confirm bool   `json:"confirm"`
		}
		if !decode(w, r, &p) {
			return
		}
		if len(p.OpID) < 8 || !p.Confirm || r.PathValue("id") != "lock" {
			failure(w, errors.New("action requires explicit confirmation"))
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		err := s.Plugin.Invoke(ctx, r.PathValue("id"))
		result := "success"
		if err != nil {
			result = "failure"
		}
		s.Store.Audit(d.ID, "action.lock", "dev.panestra.system", result, p.OpID)
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("GET /api/v1/audit", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		rows, err := s.Store.DB.Query("SELECT actor,action,target,result,request_id,created_at FROM audit_log ORDER BY id DESC LIMIT 100")
		if err != nil {
			failure(w, err)
			return
		}
		defer rows.Close()
		entries := []map[string]string{}
		for rows.Next() {
			var actor, action, target, result, req, ts string
			rows.Scan(&actor, &action, &target, &result, &req, &ts)
			entries = append(entries, map[string]string{"actor": actor, "action": action, "target": target, "result": result, "requestId": req, "time": ts})
		}
		JSON(w, 200, entries)
	}))
	mux.HandleFunc("GET /api/v1/health", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		JSON(w, 200, map[string]any{"sqliteVersion": s.Store.Version, "coreVersion": protocol.CoreVersion, "uptime": time.Since(s.Started).Seconds(), "goroutines": runtime.NumGoroutine(), "heapBytes": m.HeapAlloc, "websocket": s.Hub.Stats(), "plugin": s.Plugin.Status()})
	}))
	mux.HandleFunc("POST /api/v1/backups", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		dir := filepath.Join(s.DataDir, "backups")
		os.MkdirAll(dir, 0700)
		name := "panestra-" + time.Now().UTC().Format("20060102T150405.000000000") + ".db"
		if err := s.Store.Backup(r.Context(), filepath.Join(dir, name)); err != nil {
			failure(w, err)
			return
		}
		s.Store.Audit(d.ID, "backup.create", name, "success", r.Header.Get("X-Request-ID"))
		JSON(w, 200, map[string]string{"name": name})
	}))
	mux.HandleFunc("GET /api/v1/backups", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		files, _ := filepath.Glob(filepath.Join(s.DataDir, "backups", "panestra-*.db"))
		names := []string{}
		for _, f := range files {
			names = append(names, filepath.Base(f))
		}
		JSON(w, 200, names)
	}))
	mux.HandleFunc("GET /api/v1/backups/{name}", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		name := r.PathValue("name")
		if filepath.Base(name) != name || !strings.HasPrefix(name, "panestra-") || !strings.HasSuffix(name, ".db") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Disposition", "attachment; filename=\""+name+"\"")
		http.ServeFile(w, r, filepath.Join(s.DataDir, "backups", name))
	}))
	mux.HandleFunc("GET /ws/v1", s.websocket)
	mux.Handle("/", assets)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req := security.RandomToken()[:16]
		r.Header.Set("X-Request-ID", req)
		w.Header().Set("X-Request-ID", req)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https: wss:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'")
		if !s.originAllowed(r) {
			JSON(w, 403, protocol.Error{Code: "BAD_ORIGIN", Message: "不允许的来源"})
			return
		}
		if o := r.Header.Get("Origin"); o != "" {
			w.Header().Set("Access-Control-Allow-Origin", o)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		}
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		if strings.HasPrefix(r.URL.Path, "/api/v1/auth/") || strings.HasPrefix(r.URL.Path, "/api/v1/pairing/") {
			ip, _, _ := net.SplitHostPort(r.RemoteAddr)
			if !s.rate(ip) {
				JSON(w, 429, protocol.Error{Code: "RATE_LIMITED", Message: "尝试过于频繁，请稍后再试"})
				return
			}
		}
		r.Body = http.MaxBytesReader(w, r.Body, 64*1024)
		start := time.Now()
		mux.ServeHTTP(w, r)
		if r.URL.Path != "/ws/v1" {
			slog.Info("request", "requestId", req, "method", r.Method, "route", r.Pattern, "durationMs", time.Since(start).Milliseconds())
		}
	})
}
