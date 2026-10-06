package server

import (
	"net/http"
	"panestra.local/panestra/core/adapters/alas"
	"panestra.local/panestra/core/protocol"
)

func (s *Server) alasRoutes(mux *http.ServeMux, protect func(bool, func(http.ResponseWriter, *http.Request, protocol.Device)) http.HandlerFunc) {
	base := "/api/v1/integrations/alas"
	mux.HandleFunc("GET "+base, protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) { JSON(w, 200, s.Alas.Snapshot()) }))
	mux.HandleFunc("GET "+base+"/setup", protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) { JSON(w, 200, s.Alas.Setup()) }))
	for _, suffix := range []string{"", "/prepare"} {
		mux.HandleFunc("POST "+base+suffix, protect(true, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
			var change alas.Change
			if !decode(w, r, &change) {
				return
			}
			status, err := s.Alas.Configure(change, suffix == "/prepare")
			if err != nil {
				failure(w, err)
				return
			}
			s.Store.Audit(d.ID, "alas.configure", alas.ID, "saved", r.Header.Get("X-Request-ID"))
			JSON(w, 200, status)
		}))
	}
	mux.HandleFunc("POST "+base+"/refresh", protect(false, func(w http.ResponseWriter, r *http.Request, d protocol.Device) {
		s.Alas.Refresh()
		JSON(w, 200, s.Alas.Snapshot())
	}))
}
