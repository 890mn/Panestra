package store

import (
	"math"
	"panestra.local/panestra/core/protocol"
	"regexp"
	"strconv"
)

var profilePattern = regexp.MustCompile(`^(desktop|tablet|mobile):([0-9]+)x([0-9]+)$`)

// Values mark essential content which cannot be hidden.
var profileBlocks = map[string]map[string]bool{
	"task-status":     {"status": true, "current": false, "next": false, "queue": false, "updated": false},
	"metric-card":     {"value": true, "gauge": false, "trend": false, "stats": false},
	"network-chart":   {"rates": true, "trend": false, "stats": false},
	"system-overview": {"hostname": true, "memory": true, "os": false, "hardware": false},
	"codex-usage":     {"status": false, "windows": true, "credits": false, "updated": false},
	"account-usage":   {"status": false, "account": true, "details": false, "updated": false},
	"proxy-status":    {"mode": true, "traffic": true, "node": false, "status": false, "updated": false},
	"media-control":   {"track": true, "controls": false, "progress": false, "album": false, "status": false, "updated": false},
}

func validateProfiles(kind string, raw any) error {
	bad := func() error { return errCode("INVALID_PAYLOAD", "尺寸预设或内容布局无效") }
	profiles, ok := raw.(map[string]any)
	if !ok || len(profiles) > 231 {
		return bad()
	}
	for key, value := range profiles {
		match := profilePattern.FindStringSubmatch(key)
		if match == nil {
			return bad()
		}
		w, _ := strconv.Atoi(match[2])
		h, _ := strconv.Atoi(match[3])
		cols := map[string]int{"desktop": 12, "tablet": 8, "mobile": 4}[match[1]]
		if w < 2 || w > cols || h < 2 || h > 12 || match[2] != strconv.Itoa(w) || match[3] != strconv.Itoa(h) {
			return bad()
		}
		profile, ok := value.(map[string]any)
		if !ok || len(profile) != 3 {
			return bad()
		}
		mode, ok := profile["presentation"].(string)
		if !ok || !protocol.ValidPresentation(kind, mode) {
			return bad()
		}
		chart, ok := profile["chartStyle"].(string)
		if !ok || (chart != "line" && chart != "area") {
			return bad()
		}
		blocks, ok := profile["blocks"].(map[string]any)
		if !ok || len(blocks) > len(profileBlocks[kind]) {
			return bad()
		}
		for id, value := range blocks {
			required, known := profileBlocks[kind][id]
			if !known {
				return bad()
			}
			block, ok := value.(map[string]any)
			if !ok || len(block) != 5 {
				return bad()
			}
			number := func(key string, max int) int {
				v, ok := block[key].(float64)
				if !ok || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 || v > float64(max) || v != math.Trunc(v) {
					return -1
				}
				return int(v)
			}
			order, column, span := number("order", 31), number("column", 11), number("span", 12)
			align, ok := block["align"].(string)
			if !ok || (align != "start" && align != "center" && align != "end") {
				return bad()
			}
			visible, ok := block["visible"].(bool)
			if !ok || (required && !visible) || order < 0 || column < 0 || span < 1 || column+span > 12 {
				return bad()
			}
		}
	}
	return nil
}
