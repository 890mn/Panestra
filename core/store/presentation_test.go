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

func TestNewVisualProfilePreservesContentLayout(t *testing.T) {
	for _, mode := range []string{"dial", "segments", "bars"} {
		t.Run(mode, func(t *testing.T) {
			s := testStore(t)
			owner := protocol.Device{ID: "owner-device"}
			profile := map[string]any{"presentation": mode, "chartStyle": "line", "blocks": map[string]any{"value": map[string]any{"order": 0, "column": 3, "span": 9, "align": "end", "visible": true}}}
			profiles := map[string]any{"tablet:4x4": profile, "mobile:2x2": map[string]any{"presentation": "value", "chartStyle": "line", "blocks": map[string]any{}}}
			event, err := s.Commit(owner, cmd("visual-profile", "widget-cpu", "widget.update", 1, map[string]any{"sizeProfiles": profiles}))
			if err != nil {
				t.Fatal(err)
			}
			var data map[string]any
			if err := json.Unmarshal(event.Entity.Data, &data); err != nil {
				t.Fatal(err)
			}
			got, _ := json.Marshal(data["sizeProfiles"])
			want, _ := json.Marshal(profiles)
			if string(got) != string(want) {
				t.Fatal("visual preset changed content geometry or other screen profiles")
			}
		})
	}
}
