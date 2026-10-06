package store

import (
	"encoding/json"
	"panestra.local/panestra/core/protocol"
	"testing"
)

func TestPresentationValidationAndPersistence(t *testing.T) {
	s := testStore(t)
	owner := protocol.Device{ID: "owner-device"}
	for _, payload := range []map[string]any{{"presentation": "split"}, {"presentation": false}, {"chartStyle": "script"}, {"source": "system.info"}} {
		if _, err := s.Commit(owner, cmd("bad-presentation", "widget-cpu", "widget.update", 1, payload)); err == nil {
			t.Fatal("invalid renderer config accepted", payload)
		}
	}
	e, err := s.Commit(owner, cmd("good-presentation", "widget-cpu", "widget.update", 1, map[string]any{"presentation": "gauge", "chartStyle": "area"}))
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]any
	json.Unmarshal(e.Entity.Data, &config)
	if config["presentation"] != "gauge" || config["chartStyle"] != "area" {
		t.Fatal("config lost")
	}
}
