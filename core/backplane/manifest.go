package backplane

import (
	"encoding/json"
	"fmt"
	"panestra.local/panestra/core/protocol"
	"path/filepath"
	"regexp"
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
	ID            string            `json:"id"`
	Renderer      string            `json:"renderer"`
	Subscriptions []string          `json:"subscriptions"`
	Layout        map[string]any    `json:"layout"`
	SizePresets   []SizePreset      `json:"sizePresets"`
	Presentations []string          `json:"presentations"`
	Defaults      json.RawMessage   `json:"defaults,omitempty"`
	Catalog       []json.RawMessage `json:"catalog,omitempty"`
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
		PluginAPI   string `json:"pluginApi"`
		Runtime     string `json:"runtime"`
		Entry       string `json:"entry"`
		MaxChildren int    `json:"maxChildren,omitempty"`
	} `json:"engine"`
	Permissions    []Permission       `json:"permissions"`
	Sources        []Source           `json:"sources"`
	Widgets        []WidgetDefinition `json:"widgets"`
	Actions        []Action           `json:"actions"`
	ConfigSchema   json.RawMessage    `json:"configSchema"`
	UI             json.RawMessage    `json:"ui,omitempty"`
	Routes         []Route            `json:"routes,omitempty"`
	LegacyData     string             `json:"legacyData,omitempty"`
	LegacyPaths    []string           `json:"legacyPaths,omitempty"`
	InitialWidgets json.RawMessage    `json:"initialWidgets,omitempty"`
}

type Route struct {
	Method     string `json:"method"`
	Path       string `json:"path"`
	Operation  string `json:"operation"`
	Role       string `json:"role"`
	GrantField string `json:"grantField,omitempty"`
	Grant      string `json:"grant,omitempty"`
}

var KnownCapabilities = map[string]bool{"system.metrics.read": true, "system.session.lock": true, "process.list": true}

func ParseManifest(data []byte) (Manifest, error) {
	var m Manifest
	if len(data) > 64*1024 {
		return m, fmt.Errorf("manifest too large")
	}
	if err := json.Unmarshal(data, &m); err != nil {
		return m, err
	}
	if (m.SchemaVersion != 1 && m.SchemaVersion != 2) || m.Engine.PluginAPI != ">=1.0.0 <2.0.0" {
		return m, fmt.Errorf("incompatible manifest schema or plugin API")
	}
	if m.ID == "" || m.Version == "" || m.Engine.Runtime != "native-process" {
		return m, fmt.Errorf("invalid plugin identity/runtime")
	}
	if !regexp.MustCompile(`^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*){2,}$`).MatchString(m.ID) || !regexp.MustCompile(`^\d+\.\d+\.\d+$`).MatchString(m.Version) {
		return m, fmt.Errorf("invalid manifest identity or version")
	}
	if len(m.Permissions) > 64 || len(m.Sources) > 200 || len(m.Widgets) > 32 || len(m.Actions) > 32 || len(m.Routes) > 32 {
		return m, fmt.Errorf("manifest declarations exceed limits")
	}
	if len(m.UI) > 0 {
		var ui struct {
			Settings []struct{ Key, Type string } `json:"settings"`
		}
		if json.Unmarshal(m.UI, &ui) != nil || len(ui.Settings) > 32 {
			return m, fmt.Errorf("invalid plugin settings")
		}
		keys := map[string]bool{}
		for _, field := range ui.Settings {
			if !regexp.MustCompile(`^[a-z][a-zA-Z0-9]{0,63}$`).MatchString(field.Key) || keys[field.Key] || (field.Type != "text" && field.Type != "secret" && field.Type != "integer" && field.Type != "boolean") {
				return m, fmt.Errorf("invalid settings field")
			}
			keys[field.Key] = true
		}
	}
	if filepath.Base(m.Engine.Entry) != m.Engine.Entry || strings.ContainsAny(m.Engine.Entry, "/\\:") {
		return m, fmt.Errorf("entry must be a package-local filename")
	}
	permissions := map[string]bool{}
	if m.Engine.MaxChildren < 0 || m.Engine.MaxChildren > 4 {
		return m, fmt.Errorf("invalid child process limit")
	}
	if m.LegacyData != "" && (filepath.Base(m.LegacyData) != m.LegacyData || strings.ContainsAny(m.LegacyData, "/\\:")) {
		return m, fmt.Errorf("invalid legacy data filename")
	}
	for _, name := range m.LegacyPaths {
		if name == "" || name == "." || name == ".." || filepath.Base(name) != name || strings.ContainsAny(name, "/\\:") {
			return m, fmt.Errorf("invalid legacy data path")
		}
	}
	for _, p := range m.Permissions {
		if p.ID == "" || permissions[p.ID] {
			return m, fmt.Errorf("invalid duplicate permission")
		}
		permissions[p.ID] = true
		if p.Required && !KnownCapabilities[p.ID] && m.SchemaVersion == 1 {
			return m, fmt.Errorf("unknown required capability: %s", p.ID)
		}
	}
	actions := map[string]bool{}
	routes := map[string]bool{}
	for _, route := range m.Routes {
		key := route.Method + " " + route.Path
		if routes[key] || (route.Method != "GET" && route.Method != "POST") || !strings.HasPrefix(route.Path, "/integrations/") || strings.ContainsAny(route.Path, "{}?#\\") || route.Operation == "" || (route.Role != "owner" && route.Role != "operator" && route.Role != "viewer") {
			return m, fmt.Errorf("invalid plugin route")
		}
		if route.GrantField != "" && (route.Role != "owner" || !permissions[route.Grant]) {
			return m, fmt.Errorf("invalid permission binding")
		}
		routes[key] = true
	}
	for _, action := range m.Actions {
		if action.ID == "" || actions[action.ID] || !permissions[action.Permission] {
			return m, fmt.Errorf("invalid action or undeclared capability")
		}
		actions[action.ID] = true
	}
	seen := map[string]bool{}
	for _, s := range m.Sources {
		if !regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,95}$`).MatchString(s.ID) || seen[s.ID] || s.Interval < 250 || s.Interval > 60000 {
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
			valid := protocol.ValidPresentation(w.ID, mode)
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
