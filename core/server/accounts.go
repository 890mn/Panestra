package server

import (
	"net/http"
	"panestra.local/panestra/core/adapters/accounts"
	"panestra.local/panestra/core/protocol"
)

func (s *Server) accountRoutes(mux *http.ServeMux, protect func(bool, func(http.ResponseWriter, *http.Request, protocol.Device)) http.HandlerFunc) {
	for _, id := range accounts.IDs {
		service := s.Accounts[id]
		base := "/api/v1/integrations/" + id
		mux.HandleFunc("GET "+base, protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) { JSON(w, 200, service.Snapshot()) }))
		mux.HandleFunc("POST "+base, protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
			var change accounts.Change
			if !decode(w, r, &change) {
				return
			}
			status, err := service.Configure(change)
			if err != nil {
				failure(w, err)
				return
			}
			s.Store.Audit(d.ID, "account.configure", accounts.PluginID(id), "saved", r.Header.Get("X-Request-ID"))
			JSON(w, 200, status)
		}))
		mux.HandleFunc("POST "+base+"/refresh", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
			service.Refresh()
			JSON(w, 200, service.Snapshot())
		}))
	}
}
