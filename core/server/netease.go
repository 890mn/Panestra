package server

import (
	"errors"
	"net/http"
	"panestra.local/panestra/core/adapters/netease"
	"panestra.local/panestra/core/protocol"
)

func (s *Server) neteaseRoutes(mux *http.ServeMux, protect func(bool, func(http.ResponseWriter, *http.Request, protocol.Device)) http.HandlerFunc) {
	base := "/api/v1/integrations/netease"
	mux.HandleFunc("GET "+base, protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) { JSON(w, 200, s.Netease.Snapshot()) }))
	mux.HandleFunc("POST "+base, protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		var change netease.Change
		if !decode(w, r, &change) {
			return
		}
		status, err := s.Netease.Configure(change)
		if err != nil {
			failure(w, err)
			return
		}
		s.Store.Audit(d.ID, "netease.configure", netease.ID, "saved", r.Header.Get("X-Request-ID"))
		JSON(w, 200, status)
	}))
	mux.HandleFunc("POST "+base+"/refresh", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		s.Netease.Refresh()
		JSON(w, 200, s.Netease.Snapshot())
	}))
	mux.HandleFunc("POST "+base+"/actions", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		if d.Role != "owner" && d.Role != "operator" {
			JSON(w, 403, protocol.Error{Code: "FORBIDDEN", Message: "此设备没有控制权限"})
			return
		}
		var action netease.Action
		if !decode(w, r, &action) {
			return
		}
		err := s.Netease.Control(r.Context(), action)
		result := "success"
		if err != nil {
			result = "failed"
		}
		s.Store.Audit(d.ID, "netease.control", netease.ID, result, r.Header.Get("X-Request-ID"))
		s.Netease.Refresh()
		if err != nil {
			var problem *netease.Error
			if errors.As(err, &problem) && problem.State == "forbidden" {
				JSON(w, 403, protocol.Error{Code: "FORBIDDEN", Message: problem.Message})
				return
			}
			failure(w, err)
			return
		}
		JSON(w, 200, s.Netease.Snapshot())
	}))
}
