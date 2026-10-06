package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"modernc.org/sqlite"
	"net/url"
	"os"
	"path/filepath"
)

func (s *Store) Backup(ctx context.Context, path string) error {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		return errors.New("backup target already exists")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	conn, err := s.DB.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	err = conn.Raw(func(driverConn any) error {
		b, err := driverConn.(interface {
			NewBackup(string) (*sqlite.Backup, error)
		}).NewBackup(path)
		if err != nil {
			return err
		}
		_, stepErr := b.Step(-1)
		finishErr := b.Finish()
		if stepErr != nil {
			return stepErr
		}
		return finishErr
	})
	if err != nil {
		os.Remove(path)
		return err
	}
	return ValidateBackup(path)
}
func ValidateBackup(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	uriPath := filepath.ToSlash(abs)
	if filepath.VolumeName(abs) != "" {
		uriPath = "/" + uriPath
	}
	db, err := sql.Open("sqlite", (&url.URL{Scheme: "file", Path: uriPath, RawQuery: "mode=ro"}).String())
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	var result string
	if err = db.QueryRow("PRAGMA integrity_check").Scan(&result); err != nil || result != "ok" {
		return fmt.Errorf("backup integrity check: %s (%v)", result, err)
	}
	var version int
	if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || (version != 1 && version != 2) {
		return errors.New("unsupported restored schema")
	}
	for _, name := range []string{"devices", "sessions", "workspaces", "pages", "widgets", "widget_layouts", "plugins", "plugin_permissions", "events", "audit_log", "saved_endpoints"} {
		var n int
		if err = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?", name).Scan(&n); err != nil || n != 1 {
			return errors.New("backup missing table: " + name)
		}
	}
	if version == 2 {
		var n int
		if err = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='plugin_release_state'").Scan(&n); err != nil || n != 1 {
			return errors.New("backup missing plugin release state")
		}
	}
	return nil
}
func (s *Store) Restore(ctx context.Context, path string) error {
	if err := ValidateBackup(path); err != nil {
		return err
	}
	s.Mu.Lock()
	defer s.Mu.Unlock()
	conn, err := s.DB.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	err = conn.Raw(func(driverConn any) error {
		b, err := driverConn.(interface {
			NewRestore(string) (*sqlite.Backup, error)
		}).NewRestore(path)
		if err != nil {
			return err
		}
		_, stepErr := b.Step(-1)
		finishErr := b.Finish()
		if stepErr != nil {
			return stepErr
		}
		return finishErr
	})
	if err != nil {
		return err
	}
	if err = conn.Close(); err != nil {
		return err
	}
	if err = s.migrate(); err != nil {
		return err
	}
	_, err = s.DB.ExecContext(ctx, "DELETE FROM sessions")
	return err
}
