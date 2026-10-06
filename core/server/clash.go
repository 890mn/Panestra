package server

import (
	"errors"
	"net/http"
	"panestra.local/panestra/core/adapters/clash"
	"panestra.local/panestra/core/protocol"
)

func (s *Server) clashRoutes(mux *http.ServeMux, protect func(bool, func(http.ResponseWriter, *http.Request, protocol.Device)) http.HandlerFunc) {
	base := "/api/v1/integrations/clash"
	mux.HandleFunc("GET "+base, protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) { JSON(w, 200, s.Clash.Snapshot()) }))
	mux.HandleFunc("POST "+base, protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		var change clash.Change
		if !decode(w, r, &change) {
			return
		}
		status, err := s.Clash.Configure(change)
		if err != nil {
			failure(w, err)
			return
		}
		s.Store.Audit(d.ID, "clash.configure", clash.ID, "saved", r.Header.Get("X-Request-ID"))
		JSON(w, 200, status)
	}))
	mux.HandleFunc("POST "+base+"/refresh", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		s.Clash.Refresh()
		JSON(w, 200, s.Clash.Snapshot())
	}))
	mux.HandleFunc("POST "+base+"/actions", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		if d.Role != "owner" && d.Role != "operator" {
			JSON(w, 403, protocol.Error{Code: "FORBIDDEN", Message: "此设备没有控制权限"})
			return
		}
		var action clash.Action
		if !decode(w, r, &action) {
			return
		}
		err := s.Clash.Control(r.Context(), action)
		result := "success"
		if err != nil {
			result = "failed"
		}
		s.Store.Audit(d.ID, "clash.control", clash.ID, result, r.Header.Get("X-Request-ID"))
		s.Clash.Refresh()
		if err != nil {
			var problem *clash.ReadError
			if errors.As(err, &problem) && problem.State == "forbidden" {
				JSON(w, 403, protocol.Error{Code: "FORBIDDEN", Message: problem.Message})
				return
			}
			failure(w, err)
			return
		}
		JSON(w, 200, s.Clash.Snapshot())
	}))
}
