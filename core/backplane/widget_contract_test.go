package backplane

import (
	"encoding/json"
	"os"
	"testing"
)

func TestWidgetSizeAndPresentationContract(t *testing.T) {
	data, err := os.ReadFile("../../plugins/system/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	baseline, err := ParseManifest(data)
	if err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*Manifest){
		"missing miniature":    func(m *Manifest) { m.Widgets[0].SizePresets = m.Widgets[0].SizePresets[1:] },
		"duplicate preset":     func(m *Manifest) { m.Widgets[0].SizePresets[1] = m.Widgets[0].SizePresets[0] },
		"out of bounds":        func(m *Manifest) { m.Widgets[0].SizePresets[0].W = 13 },
		"missing choices":      func(m *Manifest) { m.Widgets[0].Presentations = []string{"auto"} },
		"unknown presentation": func(m *Manifest) { m.Widgets[0].Presentations = append(m.Widgets[0].Presentations, "host-js") },
	} {
		t.Run(name, func(t *testing.T) {
			var m Manifest
			json.Unmarshal(data, &m)
			mutate(&m)
			bad, _ := json.Marshal(m)
			if _, err := ParseManifest(bad); err == nil {
				t.Fatal("invalid widget contract accepted")
			}
		})
	}
	if len(baseline.Widgets) != 3 {
		t.Fatal("missing built-in renderers")
	}
}
