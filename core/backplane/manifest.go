package backplane

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
)

type Permission struct {
	ID       string `json:"id"`
	Required bool   `json:"required"`
}
type Source struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Unit     string `json:"unit"`
	Interval int    `json:"defaultIntervalMs"`
}
type WidgetDefinition struct {
	ID            string         `json:"id"`
	Renderer      string         `json:"renderer"`
	Subscriptions []string       `json:"subscriptions"`
	Layout        map[string]any `json:"layout"`
	SizePresets   []SizePreset   `json:"sizePresets"`
	Presentations []string       `json:"presentations"`
}
type SizePreset struct {
	ID string `json:"id"`
	W  int    `json:"w"`
	H  int    `json:"h"`
}
type Action struct {
	ID         string `json:"id"`
	Permission string `json:"permission"`
	Risk       string `json:"risk"`
}
type Manifest struct {
	SchemaVersion int    `json:"schemaVersion"`
	ID            string `json:"id"`
	Name          string `json:"name"`
	Version       string `json:"version"`
	Engine        struct {
		PluginAPI string `json:"pluginApi"`
		Runtime   string `json:"runtime"`
		Entry     string `json:"entry"`
	} `json:"engine"`
	Permissions  []Permission       `json:"permissions"`
	Sources      []Source           `json:"sources"`
	Widgets      []WidgetDefinition `json:"widgets"`
	Actions      []Action           `json:"actions"`
	ConfigSchema json.RawMessage    `json:"configSchema"`
}

var KnownCapabilities = map[string]bool{"system.metrics.read": true, "system.session.lock": true, "process.list": true}

func ParseManifest(data []byte) (Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return m, err
	}
	if m.SchemaVersion != 1 || m.Engine.PluginAPI != ">=1.0.0 <2.0.0" {
		return m, fmt.Errorf("incompatible manifest schema or plugin API")
	}
	if m.ID == "" || m.Version == "" || m.Engine.Runtime != "native-process" {
		return m, fmt.Errorf("invalid plugin identity/runtime")
	}
	if filepath.Base(m.Engine.Entry) != m.Engine.Entry || strings.ContainsAny(m.Engine.Entry, "/\\:") {
		return m, fmt.Errorf("entry must be a package-local filename")
	}
	permissions := map[string]bool{}
	for _, p := range m.Permissions {
		if p.ID == "" || permissions[p.ID] {
			return m, fmt.Errorf("invalid duplicate permission")
		}
		permissions[p.ID] = true
		if p.Required && !KnownCapabilities[p.ID] {
			return m, fmt.Errorf("unknown required capability: %s", p.ID)
		}
	}
	actions := map[string]bool{}
	for _, action := range m.Actions {
		if action.ID == "" || actions[action.ID] || !permissions[action.Permission] {
			return m, fmt.Errorf("invalid action or undeclared capability")
		}
		actions[action.ID] = true
	}
	seen := map[string]bool{}
	for _, s := range m.Sources {
		if s.ID == "" || seen[s.ID] || s.Interval < 250 || s.Interval > 60000 {
			return m, fmt.Errorf("invalid source")
		}
		seen[s.ID] = true
	}
	widgetIDs := map[string]bool{}
	for _, w := range m.Widgets {
		if w.ID == "" || widgetIDs[w.ID] {
			return m, fmt.Errorf("invalid duplicate widget")
		}
		widgetIDs[w.ID] = true
		if w.Renderer != "declarative" {
			return m, fmt.Errorf("host plugin JS is forbidden")
		}
		presets, dimensions := map[string]bool{}, map[[2]int]bool{}
		for _, p := range w.SizePresets {
			key := [2]int{p.W, p.H}
			if p.ID == "" || presets[p.ID] || dimensions[key] || p.W < 2 || p.W > 12 || p.H < 2 || p.H > 12 {
				return m, fmt.Errorf("invalid widget size preset: %s", w.ID)
			}
			presets[p.ID], dimensions[key] = true, true
		}
		for _, required := range [][2]int{{2, 2}, {4, 2}, {4, 3}, {4, 4}} {
			if !dimensions[required] {
				return m, fmt.Errorf("widget %s must adapt to 2x2, 4x2, 4x3 and 4x4", w.ID)
			}
		}
		modes := map[string]bool{}
		for _, mode := range w.Presentations {
			known := map[string][]string{"metric-card": {"auto", "value", "trend", "gauge"}, "network-chart": {"auto", "rates", "trend", "split"}, "system-overview": {"auto", "summary", "details"}, "codex-usage": {"auto", "remaining", "windows"}, "account-usage": {"auto", "summary", "details"}}
			valid := false
			for _, allowed := range known[w.ID] {
				valid = valid || mode == allowed
			}
			if !valid || modes[mode] {
				return m, fmt.Errorf("invalid widget presentation: %s", w.ID)
			}
			modes[mode] = true
		}
		if !modes["auto"] || len(modes) < 2 {
			return m, fmt.Errorf("widget %s must provide automatic and selectable presentations", w.ID)
		}
		for _, s := range w.Subscriptions {
			if !seen[s] {
				return m, fmt.Errorf("unknown source subscription")
			}
		}
	}
	return m, nil
}
func WithinPath(root, target string) bool {
	r, err := filepath.Abs(root)
	if err != nil {
		return false
	}
	t, err := filepath.Abs(target)
	if err != nil {
		return false
	}
	r, err = filepath.EvalSymlinks(r)
	if err != nil {
		return false
	}
	t, err = filepath.EvalSymlinks(t)
	if err != nil {
		return false
	}
	rel, err := filepath.Rel(r, t)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
