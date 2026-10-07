package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"panestra.local/panestra/core/backplane"
	"panestra.local/panestra/core/plugins"
	"panestra.local/panestra/core/protocol"
	"strings"
	"time"
)

func (s *Server) AttachPlugins(manager *plugins.Manager) {
	s.Plugins = manager
	s.Plugin = manager.Get("dev.panestra.system")
	manager.SetPublish(s.Hub.Telemetry)
}
func roleAllows(role, minimum string) bool {
	levels := map[string]int{"viewer": 1, "operator": 2, "owner": 3}
	return levels[role] >= levels[minimum] && levels[minimum] > 0
}

func (s *Server) pluginRoutes(mux *http.ServeMux, protect func(bool, func(http.ResponseWriter, *http.Request, protocol.Device)) http.HandlerFunc) {
	mux.HandleFunc("POST /api/v1/plugins/tasks", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		var request struct {
			Action string `json:"action"`
			ID     string `json:"id"`
		}
		if !decode(w, r, &request) {
			return
		}
		if request.Action != "catalog" && d.Role != "owner" {
			JSON(w, 403, protocol.Error{Code: "FORBIDDEN", Message: "仅主设备可下载插件"})
			return
		}
		task, err := s.Plugins.BeginTask(request.Action, request.ID, d.ID)
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 202, task)
	}))
	mux.HandleFunc("GET /api/v1/plugins/tasks/{token}", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		task, err := s.Plugins.Task(r.PathValue("token"), d.ID)
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, task)
	}))
	mux.HandleFunc("POST /api/v1/plugins/uploads", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		var request struct {
			ID        string `json:"id"`
			Size      int64  `json:"size"`
			Metadata  string `json:"metadata"`
			Signature string `json:"signature"`
		}
		if !decode(w, r, &request) {
			return
		}
		signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(request.Signature))
		if err != nil {
			failure(w, err)
			return
		}
		token, err := s.Plugins.BeginUpload(request.ID, d.ID, request.Size, []byte(request.Metadata), signature)
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, map[string]string{"token": token})
	}))
	mux.HandleFunc("POST /api/v1/plugins/uploads/{token}/chunk", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		var request struct {
			Offset int64  `json:"offset"`
			Data   string `json:"data"`
		}
		if !decode(w, r, &request) {
			return
		}
		raw, err := base64.StdEncoding.DecodeString(request.Data)
		if err != nil {
			failure(w, err)
			return
		}
		offset, err := s.Plugins.UploadChunk(r.PathValue("token"), d.ID, request.Offset, raw)
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, map[string]int64{"offset": offset})
	}))
	mux.HandleFunc("POST /api/v1/plugins/uploads/{token}/finish", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		preview, err := s.Plugins.FinishUpload(r.PathValue("token"), d.ID)
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, preview)
	}))
	mux.HandleFunc("GET /api/v1/plugins/catalog", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		if s.Plugins == nil {
			JSON(w, 200, map[string]any{"plugins": []any{}})
			return
		}
		JSON(w, 200, s.Plugins.Catalog(r.Context(), r.URL.Query().Get("refresh") == "1"))
	}))
	mux.HandleFunc("POST /api/v1/plugins/download", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		var request struct {
			ID string `json:"id"`
		}
		if !decode(w, r, &request) {
			return
		}
		preview, err := s.Plugins.Download(r.Context(), request.ID, d.ID)
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, preview)
	}))
	mux.HandleFunc("POST /api/v1/plugins/import", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		var request struct {
			ID        string `json:"id"`
			Package   string `json:"package"`
			Metadata  string `json:"metadata"`
			Signature string `json:"signature"`
		}
		if !decode(w, r, &request) {
			return
		}
		artifact, err := base64.StdEncoding.DecodeString(request.Package)
		if err != nil {
			failure(w, err)
			return
		}
		signature, err := base64.StdEncoding.DecodeString(strings.TrimSpace(request.Signature))
		if err != nil {
			failure(w, err)
			return
		}
		preview, err := s.Plugins.Preview(request.ID, d.ID, artifact, []byte(request.Metadata), signature)
		if err != nil {
			failure(w, err)
			return
		}
		JSON(w, 200, preview)
	}))
	mux.HandleFunc("POST /api/v1/plugins/install", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		var request struct {
			Token   string   `json:"token"`
			Consent []string `json:"consent"`
		}
		if !decode(w, r, &request) {
			return
		}
		worker, err := s.Plugins.Apply(request.Token, d.ID, request.Consent)
		if err != nil {
			failure(w, err)
			return
		}
		s.Hub.Close()
		JSON(w, 200, worker.Status())
	}))
	mux.HandleFunc("POST /api/v1/plugins/{id}/state", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		var request struct {
			Enabled bool            `json:"enabled"`
			Grants  map[string]bool `json:"grants"`
		}
		if !decode(w, r, &request) {
			return
		}
		worker := s.Plugins.Get(r.PathValue("id"))
		if worker == nil {
			JSON(w, 404, protocol.Error{Code: "PLUGIN_NOT_INSTALLED", Message: "插件尚未安装"})
			return
		}
		for cap := range request.Grants {
			declared := false
			for _, permission := range worker.Manifest.Permissions {
				declared = declared || cap == permission.ID
			}
			if !declared {
				failure(w, errors.New("permission not declared"))
				return
			}
		}
		if len(request.Grants) > 0 {
			worker.Stop()
			for cap, value := range request.Grants {
				if err := worker.Grant(cap, value); err != nil {
					failure(w, err)
					return
				}
			}
		}
		if err := s.Plugins.SetEnabled(worker.Manifest.ID, request.Enabled); err != nil {
			failure(w, err)
			return
		}
		if !request.Enabled {
			s.Hub.ClearPlugin(worker.Manifest.ID)
		}
		s.Store.Audit(d.ID, "plugin.state", worker.Manifest.ID, "success", r.Header.Get("X-Request-ID"))
		s.Hub.Close()
		JSON(w, 200, worker.Status())
	}))
	mux.HandleFunc("POST /api/v1/plugins/{id}/uninstall", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		if err := s.Plugins.Uninstall(r.PathValue("id")); err != nil {
			failure(w, err)
			return
		}
		s.Hub.ClearPlugin(r.PathValue("id"))
		s.Hub.Close()
		JSON(w, 200, map[string]bool{"ok": true})
	}))
	mux.HandleFunc("/api/v1/integrations/", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		if s.Plugins == nil {
			JSON(w, 404, protocol.Error{Code: "PLUGIN_NOT_INSTALLED", Message: "插件尚未安装"})
			return
		}
		worker, route := s.Plugins.Route(r.Method, strings.TrimPrefix(r.URL.Path, "/api/v1"))
		if worker == nil {
			JSON(w, 404, protocol.Error{Code: "PLUGIN_NOT_INSTALLED", Message: "插件未安装或不支持此操作"})
			return
		}
		if !roleAllows(d.Role, route.Role) {
			JSON(w, 403, protocol.Error{Code: "FORBIDDEN", Message: "此设备没有操作权限"})
			return
		}
		var body json.RawMessage
		if r.Method == "POST" {
			raw, err := io.ReadAll(io.LimitReader(r.Body, 64*1024+1))
			if err != nil || len(raw) > 64*1024 || !json.Valid(raw) {
				JSON(w, 400, protocol.Error{Code: "INVALID_JSON", Message: "请求格式无效"})
				return
			}
			body = raw
		} else {
			body = json.RawMessage(`{}`)
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		response, err := worker.Request(ctx, backplane.Request{Operation: route.Operation, Role: d.Role, Body: body})
		if err != nil {
			JSON(w, 503, protocol.Error{Code: "PLUGIN_OFFLINE", Message: "插件暂不可用，请检查插件状态"})
			return
		}
		if response.Status == 200 && route.GrantField != "" {
			var fields map[string]any
			if json.Unmarshal(body, &fields) == nil {
				if value, ok := fields[route.GrantField].(bool); ok {
					if err := worker.Grant(route.Grant, value); err != nil {
						failure(w, err)
						return
					}
				}
			}
		}
		if r.Method == "POST" && route.Operation != "refresh" {
			result := "success"
			if response.Status >= 400 {
				result = "failed"
			}
			s.Store.Audit(d.ID, "plugin."+route.Operation, worker.Manifest.ID, result, r.Header.Get("X-Request-ID"))
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(response.Status)
		_, _ = w.Write(response.Body)
	}))
}
