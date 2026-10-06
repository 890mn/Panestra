package store

import (
	"database/sql"
	"encoding/json"
	"panestra.local/panestra/core/protocol"
	"strings"
	"time"
)

func errCode(code, message string) *protocol.Error {
	return &protocol.Error{Code: code, Message: message}
}
func CanEdit(role string) bool { return role == "operator" || role == "owner" }
func (s *Store) Commit(device protocol.Device, c protocol.Command) (protocol.Event, error) {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	var empty protocol.Event
	var role string
	var revoked sql.NullString
	if err := s.DB.QueryRow("SELECT role,revoked_at FROM devices WHERE id=?", device.ID).Scan(&role, &revoked); err != nil || revoked.Valid {
		return empty, errCode("UNAUTHORIZED", "设备已撤销")
	}
	if !CanEdit(role) {
		return empty, errCode("FORBIDDEN", "查看者不能编辑工作空间")
	}
	if c.DeviceID != device.ID {
		return empty, errCode("FORBIDDEN", "命令设备身份不匹配")
	}
	if len(c.OpID) < 8 || len(c.OpID) > 128 || len(c.EntityID) < 1 || len(c.EntityID) > 128 || c.BaseRev < 0 {
		return empty, errCode("INVALID_COMMAND", "命令字段无效")
	}
	var duplicate string
	if err := s.DB.QueryRow("SELECT event FROM events WHERE op_id=?", c.OpID).Scan(&duplicate); err == nil {
		var old protocol.Event
		_ = json.Unmarshal([]byte(duplicate), &old)
		if old.DeviceID != device.ID {
			return empty, errCode("FORBIDDEN", "opId 属于另一设备")
		}
		return old, nil
	} else if err != sql.ErrNoRows {
		return empty, err
	}
	if c.Command == "layout.arrange" {
		return s.arrangeLocked(device, c)
	}
	parts := strings.Split(c.Command, ".")
	if len(parts) != 2 {
		return empty, errCode("INVALID_COMMAND", "未知命令")
	}
	kind, operation := parts[0], parts[1]
	table, ok := tables[kind]
	if !ok || operation != "create" && operation != "update" && operation != "delete" && operation != "commit" {
		return empty, errCode("INVALID_COMMAND", "未知实体或操作")
	}
	if kind == "workspace" && operation != "update" {
		return empty, errCode("INVALID_COMMAND", "MVP 只有一个工作空间")
	}
	if kind == "layout" && operation != "commit" {
		return empty, errCode("INVALID_COMMAND", "布局仅接受 commit")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	current := protocol.Entity{Kind: kind, ID: c.EntityID}
	var raw string
	err = tx.QueryRow("SELECT rev,deleted,data FROM "+table+" WHERE id=?", c.EntityID).Scan(&current.Rev, &current.Deleted, &raw)
	if err != nil && err != sql.ErrNoRows {
		return empty, err
	}
	current.Data = json.RawMessage(raw)
	if current.Deleted {
		return empty, &protocol.Error{Code: "ENTITY_DELETED", Message: "实体已删除", CurrentRev: current.Rev, CurrentState: &current}
	}
	if current.Rev != c.BaseRev {
		return empty, &protocol.Error{Code: "REVISION_CONFLICT", Message: "另一 Surface 已修改此实体，请检查最新内容", CurrentRev: current.Rev, CurrentState: &current}
	}
	if operation == "create" && current.Rev != 0 || operation != "create" && current.Rev == 0 && kind != "layout" {
		return empty, errCode("NOT_FOUND", "实体不存在或已存在")
	}
	data := map[string]any{}
	if len(current.Data) > 0 {
		_ = json.Unmarshal(current.Data, &data)
	}
	if operation != "delete" {
		payload := map[string]any{}
		if err = json.Unmarshal(c.Payload, &payload); err != nil || payload == nil {
			return empty, errCode("INVALID_PAYLOAD", "需要 JSON 对象")
		}
		for k, v := range payload {
			data[k] = v
		}
		if err = validate(tx, kind, c.EntityID, data); err != nil {
			return empty, err
		}
	}
	if operation == "delete" {
		if kind == "page" {
			var n int
			tx.QueryRow("SELECT count(*) FROM pages WHERE deleted=0").Scan(&n)
			if n <= 1 {
				return empty, errCode("LAST_PAGE", "请至少保留一个页面")
			}
		}
		current.Deleted = true
	}
	current.Rev++
	current.Data, _ = json.Marshal(data)
	if _, err = tx.Exec("INSERT INTO "+table+"(id,rev,deleted,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET rev=excluded.rev,deleted=excluded.deleted,data=excluded.data", current.ID, current.Rev, current.Deleted, string(current.Data)); err != nil {
		return empty, err
	}
	if operation == "delete" {
		if kind == "page" {
			_, err = tx.Exec("UPDATE widget_layouts SET deleted=1,rev=rev+1 WHERE json_extract(data,'$.widgetId') IN (SELECT id FROM widgets WHERE json_extract(data,'$.pageId')=?)", current.ID)
			if err != nil {
				return empty, err
			}
			_, err = tx.Exec("UPDATE widgets SET deleted=1,rev=rev+1 WHERE json_extract(data,'$.pageId')=?", current.ID)
		}
		if kind == "widget" {
			_, err = tx.Exec("UPDATE widget_layouts SET deleted=1,rev=rev+1 WHERE json_extract(data,'$.widgetId')=?", current.ID)
		}
		if err != nil {
			return empty, err
		}
	}
	e := protocol.Event{Type: "event", CausedBy: c.OpID, DeviceID: device.ID, Entity: current}
	result, err := tx.Exec("INSERT INTO events(op_id,device_id,event,created_at) VALUES(?,?,?,?)", c.OpID, device.ID, "{}", time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return empty, err
	}
	e.ServerSeq, _ = result.LastInsertId()
	eventJSON, _ := json.Marshal(e)
	if _, err = tx.Exec("UPDATE events SET event=? WHERE server_seq=?", string(eventJSON), e.ServerSeq); err != nil {
		return empty, err
	}
	if _, err = tx.Exec("INSERT INTO audit_log(actor,action,target,result,request_id,created_at) VALUES(?,?,?,?,?,?)", device.ID, c.Command, c.EntityID, "success", c.OpID, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return empty, err
	}
	if err = tx.Commit(); err != nil {
		return empty, err
	}
	if s.OnEvent != nil {
		s.OnEvent(e)
	}
	return e, nil
}
func validate(tx *sql.Tx, kind, id string, d map[string]any) error {
	allowed := map[string][]string{"workspace": {"title"}, "page": {"title", "workspaceId", "icon"}, "widget": {"pageId", "pluginId", "type", "title", "source", "unit", "color", "presentation", "chartStyle", "sizeProfiles"}, "layout": {"widgetId", "breakpoint", "x", "y", "w", "h", "detached"}}
	for k := range d {
		found := false
		for _, a := range allowed[kind] {
			if a == k {
				found = true
			}
		}
		if !found {
			return errCode("INVALID_PAYLOAD", "未知配置字段: "+k)
		}
	}
	text := func(k string) string { v, _ := d[k].(string); return v }
	parent := func(table, p string) error {
		var n int
		if err := tx.QueryRow("SELECT count(*) FROM "+table+" WHERE id=? AND deleted=0", p).Scan(&n); err != nil {
			return err
		}
		if n != 1 {
			return errCode("INVALID_PARENT", "父实体不存在")
		}
		return nil
	}
	if kind != "layout" {
		if len(strings.TrimSpace(text("title"))) < 1 || len(text("title")) > 160 {
			return errCode("INVALID_PAYLOAD", "名称须为 1–160 个字节")
		}
	}
	switch kind {
	case "page":
		return parent("workspaces", text("workspaceId"))
	case "widget":
		if profiles, exists := d["sizeProfiles"]; exists {
			if err := validateProfiles(text("type"), profiles); err != nil {
				return err
			}
		}
		modes := map[string][]string{"metric-card": {"auto", "value", "trend", "gauge"}, "network-chart": {"auto", "rates", "trend", "split"}, "system-overview": {"auto", "summary", "details"}, "codex-usage": {"auto", "remaining", "windows"}, "account-usage": {"auto", "summary", "details"}, "proxy-status": {"auto", "summary", "details"}, "media-control": {"auto", "player", "track"}, "task-status": {"auto", "summary", "tasks"}}
		if value, exists := d["presentation"]; exists {
			mode, isText := value.(string)
			valid := false
			for _, allowed := range modes[text("type")] {
				valid = valid || mode == allowed
			}
			if !isText || !valid {
				return errCode("INVALID_PAYLOAD", "不支持的呈现方式")
			}
		}
		if value, exists := d["chartStyle"]; exists {
			style, ok := value.(string)
			if !ok || (style != "line" && style != "area") {
				return errCode("INVALID_PAYLOAD", "不支持的趋势效果")
			}
		}
		if text("pluginId") == "dev.panestra.codex" {
			if text("type") != "codex-usage" || text("source") != "account.usage" {
				return errCode("INVALID_SOURCE", "Codex 仅支持订阅额度组件")
			}
			return parent("pages", text("pageId"))
		}
		if text("pluginId") != "dev.panestra.system" {
			if text("pluginId") == "dev.panestra.alas" {
				if text("type") != "task-status" || text("source") != "task.status" {
					return errCode("INVALID_SOURCE", "ALAS 仅支持任务状态组件")
				}
				return parent("pages", text("pageId"))
			}
			if text("pluginId") == "dev.panestra.netease" {
				if text("type") != "media-control" || text("source") != "media.status" {
					return errCode("INVALID_SOURCE", "网易云音乐仅支持媒体组件")
				}
				return parent("pages", text("pageId"))
			}
			if text("pluginId") == "dev.panestra.clash" {
				if text("type") != "proxy-status" || text("source") != "proxy.status" {
					return errCode("INVALID_SOURCE", "Clash 仅支持代理状态组件")
				}
				return parent("pages", text("pageId"))
			}
			if text("pluginId") == "dev.panestra.glm" || text("pluginId") == "dev.panestra.deepseek" {
				if text("type") != "account-usage" || text("source") != "account.usage" {
					return errCode("INVALID_SOURCE", "账户适配仅支持额度与余额组件")
				}
				return parent("pages", text("pageId"))
			}
			return errCode("INVALID_PLUGIN", "插件未注册")
		}
		if text("type") != "metric-card" && text("type") != "network-chart" && text("type") != "system-overview" {
			return errCode("INVALID_WIDGET", "仅支持声明式组件")
		}
		valid := false
		for _, source := range []string{"cpu.usage", "memory.usage", "disk.usage", "network.rx", "network.tx", "system.info"} {
			if text("source") == source {
				valid = true
			}
		}
		if text("type") == "system-overview" {
			valid = text("source") == "system.info"
		} else if text("type") == "network-chart" {
			valid = text("source") == "network.rx" || text("source") == "network.tx"
		} else {
			valid = valid && text("source") != "system.info"
		}
		if !valid {
			return errCode("INVALID_SOURCE", "数据源与组件类型不匹配")
		}
		return parent("pages", text("pageId"))
	case "layout":
		cols := map[string]int{"desktop": 12, "tablet": 8, "mobile": 4}[text("breakpoint")]
		if cols == 0 || id != text("widgetId")+":"+text("breakpoint") {
			return errCode("INVALID_LAYOUT", "布局标识无效")
		}
		num := func(k string) int {
			v, ok := d[k].(float64)
			if !ok || v != float64(int(v)) {
				return -1
			}
			return int(v)
		}
		x, y, w, h := num("x"), num("y"), num("w"), num("h")
		if x < 0 || y < 0 || y > 10000 || w < 2 || h < 2 || h > 12 || x+w > cols {
			return errCode("INVALID_LAYOUT", "位置或尺寸超出网格边界")
		}
		d["detached"] = true
		return parent("widgets", text("widgetId"))
	}
	return nil
}
