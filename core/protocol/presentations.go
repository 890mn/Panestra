package protocol

// Presentations are renderer capabilities shared by commands, profiles and manifests.
var Presentations = map[string][]string{
	"metric-card":     {"auto", "value", "trend", "gauge", "dial", "segments", "bars"},
	"network-chart":   {"auto", "rates", "trend", "split", "bars", "meters"},
	"system-overview": {"auto", "summary", "details", "tiles"},
	"codex-usage":     {"auto", "remaining", "windows", "rings", "tiles", "segments"},
	"account-usage":   {"auto", "summary", "details", "visual", "tiles", "segments"},
	"proxy-status":    {"auto", "summary", "details", "trend", "route", "meters"},
	"media-control":   {"auto", "player", "track", "cover", "vinyl", "focus"},
	"task-status":     {"auto", "summary", "tasks", "timeline", "board"},
}

func ValidPresentation(kind, mode string) bool {
	for _, allowed := range Presentations[kind] {
		if mode == allowed {
			return true
		}
	}
	return false
}
