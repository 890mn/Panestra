package store

import (
	"database/sql"
	"encoding/json"
	"errors"
)

func validatePluginWidget(tx *sql.Tx, data map[string]any) error {
	var raw string
	if tx.QueryRow("SELECT data FROM plugins WHERE id=?", data["pluginId"]).Scan(&raw) != nil {
		return errCode("INVALID_PLUGIN", "插件未注册")
	}
	var manifest struct {
		Widgets []struct {
			ID            string   `json:"id"`
			Subscriptions []string `json:"subscriptions"`
			Presentations []string `json:"presentations"`
		} `json:"widgets"`
	}
	if json.Unmarshal([]byte(raw), &manifest) != nil {
		return errCode("INVALID_PLUGIN", "插件清单无效")
	}
	for _, widget := range manifest.Widgets {
		if widget.ID != data["type"] {
			continue
		}
		sourceValid := false
		for _, source := range widget.Subscriptions {
			sourceValid = sourceValid || source == data["source"]
		}
		if !sourceValid {
			return errCode("INVALID_SOURCE", "数据源与组件类型不匹配")
		}
		if mode, ok := data["presentation"]; ok {
			valid := false
			for _, allowed := range widget.Presentations {
				valid = valid || mode == allowed
			}
			if !valid {
				return errCode("INVALID_PAYLOAD", "插件不支持此呈现方式")
			}
		}
		return nil
	}
	return errCode("INVALID_WIDGET", "插件未声明此组件")
}

// SeedPlugin applies the signed package's starter dashboard only to an empty page.
// Existing layouts, including tombstones, always win over defaults.
func (s *Store) SeedPlugin(raw []byte) error {
	var manifest struct {
		ID             string `json:"id"`
		InitialWidgets []struct {
			ID      string           `json:"id"`
			Data    map[string]any   `json:"data"`
			Layouts []map[string]any `json:"layouts"`
		} `json:"initialWidgets"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return err
	}
	if len(manifest.InitialWidgets) == 0 {
		return nil
	}
	if len(manifest.InitialWidgets) > 32 {
		return errors.New("too many starter widgets")
	}
	s.Mu.Lock()
	defer s.Mu.Unlock()
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var count int
	if err = tx.QueryRow("SELECT count(*) FROM widgets").Scan(&count); err != nil || count > 0 {
		return err
	}
	for _, item := range manifest.InitialWidgets {
		if item.ID == "" || item.Data["pluginId"] != manifest.ID || len(item.Layouts) > 3 {
			return errors.New("invalid starter widget")
		}
		if err = validatePluginWidget(tx, item.Data); err != nil {
			return err
		}
		var page int
		if tx.QueryRow("SELECT count(*) FROM pages WHERE id=? AND deleted=0", item.Data["pageId"]).Scan(&page) != nil || page != 1 {
			return errors.New("invalid starter page")
		}
		data, _ := json.Marshal(item.Data)
		if _, err = tx.Exec("INSERT INTO widgets VALUES(?,1,0,?)", item.ID, string(data)); err != nil {
			return err
		}
		for _, layout := range item.Layouts {
			bp, _ := layout["breakpoint"].(string)
			id := item.ID + ":" + bp
			if layout["widgetId"] != item.ID {
				return errors.New("invalid starter layout")
			}
			if err = validate(tx, "layout", id, layout); err != nil {
				return err
			}
			data, _ = json.Marshal(layout)
			if _, err = tx.Exec("INSERT INTO widget_layouts VALUES(?,1,0,?)", id, string(data)); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}
