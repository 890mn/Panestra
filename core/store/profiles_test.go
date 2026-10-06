package store

import (
	"encoding/json"
	"panestra.local/panestra/core/protocol"
	"testing"
)

func TestSizeProfilesValidateAndPersist(t *testing.T) {
	s := testStore(t)
	owner := protocol.Device{ID: "owner-device"}
	profile := map[string]any{"presentation": "gauge", "chartStyle": "area", "blocks": map[string]any{"value": map[string]any{"order": 0, "column": 6, "span": 6, "align": "end", "visible": true}}}
	profiles := map[string]any{"tablet:4x3": profile, "mobile:2x2": map[string]any{"presentation": "value", "chartStyle": "line", "blocks": map[string]any{}}}
	event, err := s.Commit(owner, cmd("save-profiles", "widget-cpu", "widget.update", 1, map[string]any{"sizeProfiles": profiles}))
	if err != nil {
		t.Fatal(err)
	}
	var data map[string]any
	json.Unmarshal(event.Entity.Data, &data)
	raw, _ := json.Marshal(data["sizeProfiles"])
	want, _ := json.Marshal(profiles)
	if string(raw) != string(want) {
		t.Fatalf("profiles changed: %s", raw)
	}
	if _, err = s.Commit(owner, cmd("stale-profiles", "widget-cpu", "widget.update", 1, map[string]any{"sizeProfiles": map[string]any{}})); err == nil {
		t.Fatal("stale revision overwrote profiles")
	}
	tests := []string{
		`{"tablet:9x3":{"presentation":"gauge","chartStyle":"line","blocks":{}}}`,
		`{"tablet:04x3":{"presentation":"gauge","chartStyle":"line","blocks":{}}}`,
		`{"tablet:4x3":{"presentation":"split","chartStyle":"line","blocks":{}}}`,
		`{"tablet:4x3":{"presentation":"auto","chartStyle":"line","blocks":{"value":{"order":0,"column":0,"span":12,"align":"start","visible":false}}}}`,
		`{"tablet:4x3":{"presentation":"auto","chartStyle":"line","blocks":{"value":{"order":0,"column":8,"span":6,"align":"start","visible":true}}}}`,
		`{"tablet:4x3":{"presentation":"auto","chartStyle":"line","blocks":{"script":{"order":0,"column":0,"span":12,"align":"start","visible":true}}}}`,
	}
	for _, raw := range tests {
		var invalid any
		json.Unmarshal([]byte(raw), &invalid)
		if validateProfiles("metric-card", invalid) == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
}
