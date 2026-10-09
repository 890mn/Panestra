package security

import (
	"database/sql"
	"errors"
	"panestra.local/panestra/core/protocol"
	"strings"
	"unicode/utf8"
)

// UpdateDevice preserves the device key, pairing and sessions. Validation reads
// the current role from storage on every request, so changes apply immediately.
func (a *Auth) UpdateDevice(id, name, role string) (protocol.Device, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 40 || strings.ContainsAny(name, "\r\n\x00") {
		return protocol.Device{}, errors.New("设备名称应为 1–40 个字符，不包含换行")
	}
	if role != "owner" && role != "operator" && role != "viewer" {
		return protocol.Device{}, errors.New("无效的设备权限")
	}
	a.Store.Mu.Lock()
	defer a.Store.Mu.Unlock()
	tx, err := a.Store.DB.Begin()
	if err != nil {
		return protocol.Device{}, err
	}
	defer tx.Rollback()
	var previous string
	var revoked sql.NullString
	if err = tx.QueryRow("SELECT role,revoked_at FROM devices WHERE id=?", id).Scan(&previous, &revoked); err != nil {
		return protocol.Device{}, err
	}
	if revoked.Valid {
		return protocol.Device{}, errors.New("已撤销设备需重新配对后才能修改")
	}
	if previous == "owner" && role != "owner" {
		var count int
		if err = tx.QueryRow("SELECT count(*) FROM devices WHERE role='owner' AND revoked_at IS NULL").Scan(&count); err != nil {
			return protocol.Device{}, err
		}
		if count <= 1 {
			return protocol.Device{}, errors.New("至少保留一台管理设备")
		}
	}
	if _, err = tx.Exec("UPDATE devices SET name=?,role=? WHERE id=?", name, role, id); err != nil {
		return protocol.Device{}, err
	}
	if err = tx.Commit(); err != nil {
		return protocol.Device{}, err
	}
	d, err := a.Device(id)
	d.PublicKey = ""
	return d, err
}

func (a *Auth) CloseWindow() {
	a.Mu.Lock()
	defer a.Mu.Unlock()
	a.window = Window{}
	// A closed window also cancels requests which have not been approved.
	for _, p := range a.pending {
		if p.Status == "pending" {
			p.Status = "denied"
		}
	}
}
