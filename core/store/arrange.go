package store

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"panestra.local/panestra/core/protocol"
	"time"
)

// Caller holds Store.Mu and has checked role, device identity and opId deduplication.
func (s *Store) arrangeLocked(device protocol.Device, c protocol.Command) (protocol.Event, error) {
	var empty protocol.Event
	var payload struct {
		Breakpoint string `json:"breakpoint"`
		Items      []struct {
			BaseRev int64          `json:"baseRev"`
			Layout  map[string]any `json:"layout"`
		} `json:"items"`
	}
	decoder := json.NewDecoder(bytes.NewReader(c.Payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil || decoder.Decode(new(any)) != io.EOF || len(payload.Items) < 1 || len(payload.Items) > 100 {
		return empty, errCode("INVALID_PAYLOAD", "布局组需要 1–100 个组件")
	}
	if payload.Breakpoint != "desktop" && payload.Breakpoint != "tablet" && payload.Breakpoint != "mobile" {
		return empty, errCode("INVALID_LAYOUT", "布局断点无效")
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	var pageDeleted bool
	if err = tx.QueryRow("SELECT deleted FROM pages WHERE id=?", c.EntityID).Scan(&pageDeleted); err != nil || pageDeleted {
		return empty, errCode("INVALID_PARENT", "页面已删除或不存在")
	}
	entities := make([]protocol.Entity, 0, len(payload.Items))
	changed := map[string]bool{}
	for _, item := range payload.Items {
		widgetID, _ := item.Layout["widgetId"].(string)
		bp, _ := item.Layout["breakpoint"].(string)
		id := widgetID + ":" + bp
		if widgetID == "" || len(widgetID) > 128 || bp != payload.Breakpoint || item.BaseRev < 0 || changed[id] {
			return empty, errCode("INVALID_LAYOUT", "布局组包含重复组件或不同断点")
		}
		changed[id] = true
		var widgetPage string
		var widgetDeleted bool
		if err = tx.QueryRow("SELECT json_extract(data,'$.pageId'),deleted FROM widgets WHERE id=?", widgetID).Scan(&widgetPage, &widgetDeleted); err != nil || widgetDeleted || widgetPage != c.EntityID {
			return empty, errCode("INVALID_PARENT", "组件不属于当前页面")
		}
		current := protocol.Entity{ID: id, Kind: "layout"}
		var raw string
		err = tx.QueryRow("SELECT rev,deleted,data FROM widget_layouts WHERE id=?", id).Scan(&current.Rev, &current.Deleted, &raw)
		if err != nil && err != sql.ErrNoRows {
			return empty, err
		}
		current.Data = json.RawMessage(raw)
		if current.Deleted {
			return empty, &protocol.Error{Code: "ENTITY_DELETED", Message: "布局已删除", CurrentState: &current, CurrentRev: current.Rev}
		}
		if current.Rev != item.BaseRev {
			return empty, &protocol.Error{Code: "REVISION_CONFLICT", Message: "另一块屏幕已修改布局，本次整组操作未保存", CurrentState: &current, CurrentRev: current.Rev}
		}
		if err = validate(tx, "layout", id, item.Layout); err != nil {
			return empty, err
		}
		current.Rev++
		current.Data, _ = json.Marshal(item.Layout)
		if _, err = tx.Exec("INSERT INTO widget_layouts(id,rev,deleted,data) VALUES(?,?,0,?) ON CONFLICT(id) DO UPDATE SET rev=excluded.rev,data=excluded.data", id, current.Rev, string(current.Data)); err != nil {
			return empty, err
		}
		entities = append(entities, current)
	}
	// Reject a concurrent card entering any changed slot, without rejecting unrelated
	// overlaps left by an older application. The transaction rolls back as one unit.
	rows, err := tx.Query(`SELECT l.id,l.data FROM widget_layouts l JOIN widgets w ON w.id=json_extract(l.data,'$.widgetId') WHERE l.deleted=0 AND w.deleted=0 AND json_extract(w.data,'$.pageId')=? AND json_extract(l.data,'$.breakpoint')=?`, c.EntityID, payload.Breakpoint)
	if err != nil {
		return empty, err
	}
	type rectangle struct{ X, Y, W, H int }
	all := map[string]rectangle{}
	for rows.Next() {
		var id, raw string
		if err = rows.Scan(&id, &raw); err != nil {
			rows.Close()
			return empty, err
		}
		var rect rectangle
		if err = json.Unmarshal([]byte(raw), &rect); err != nil {
			rows.Close()
			return empty, err
		}
		all[id] = rect
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return empty, err
	}
	for id, a := range all {
		if !changed[id] {
			continue
		}
		for other, b := range all {
			if id != other && a.X < b.X+b.W && a.X+a.W > b.X && a.Y < b.Y+b.H && a.Y+a.H > b.Y {
				return empty, errCode("LAYOUT_COLLISION", "目标位置已被另一组件占用，请检查最新布局")
			}
		}
	}
	event := protocol.Event{Type: "event", CausedBy: c.OpID, DeviceID: device.ID, Entity: entities[0], Entities: entities}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	result, err := tx.Exec("INSERT INTO events(op_id,device_id,event,created_at) VALUES(?,?,?,?)", c.OpID, device.ID, "{}", now)
	if err != nil {
		return empty, err
	}
	event.ServerSeq, _ = result.LastInsertId()
	raw, _ := json.Marshal(event)
	if _, err = tx.Exec("UPDATE events SET event=? WHERE server_seq=?", string(raw), event.ServerSeq); err != nil {
		return empty, err
	}
	if _, err = tx.Exec("INSERT INTO audit_log(actor,action,target,result,request_id,created_at) VALUES(?,?,?,?,?,?)", device.ID, c.Command, c.EntityID, "success", c.OpID, now); err != nil {
		return empty, err
	}
	if err = tx.Commit(); err != nil {
		return empty, err
	}
	if s.OnEvent != nil {
		s.OnEvent(event)
	}
	return event, nil
}
