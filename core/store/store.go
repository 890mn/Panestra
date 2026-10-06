package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	_ "modernc.org/sqlite"
	"os"
	"panestra.local/panestra/core/protocol"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Store struct {
	DB      *sql.DB
	Mu      sync.Mutex
	OnEvent func(protocol.Event)
	Version string
}

var tables = map[string]string{"workspace": "workspaces", "page": "pages", "widget": "widgets", "layout": "widget_layouts"}

func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	s := &Store{DB: db}
	fail := func(e error) (*Store, error) { db.Close(); return nil, e }
	if err = db.QueryRow("SELECT sqlite_version()").Scan(&s.Version); err != nil {
		return fail(err)
	}
	parts := strings.Split(s.Version, ".")
	if len(parts) < 3 {
		return fail(fmt.Errorf("invalid SQLite version"))
	}
	major, _ := strconv.Atoi(parts[0])
	minor, _ := strconv.Atoi(parts[1])
	patch, _ := strconv.Atoi(parts[2])
	if major < 3 || major == 3 && (minor < 51 || minor == 51 && patch < 3) {
		return fail(fmt.Errorf("SQLite >=3.51.3 required; got %s", s.Version))
	}
	for _, q := range []string{"PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON", "PRAGMA busy_timeout=5000", "PRAGMA synchronous=FULL"} {
		if _, err = db.Exec(q); err != nil {
			return fail(err)
		}
	}
	if err = s.migrate(); err != nil {
		return fail(err)
	}
	return s, nil
}
func (s *Store) migrate() error {
	var current int
	if err := s.DB.QueryRow("PRAGMA user_version").Scan(&current); err != nil {
		return err
	}
	if current > 2 {
		return fmt.Errorf("database schema %d is newer than this Core supports", current)
	}
	const schema = `
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,public_key TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','operator','viewer')),created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,revoked_at TEXT);
CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,device_id TEXT NOT NULL REFERENCES devices(id),expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,rev INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pages(id TEXT PRIMARY KEY,rev INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS widgets(id TEXT PRIMARY KEY,rev INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS widget_layouts(id TEXT PRIMARY KEY,rev INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(server_seq INTEGER PRIMARY KEY AUTOINCREMENT,op_id TEXT UNIQUE NOT NULL,device_id TEXT NOT NULL,event TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,result TEXT NOT NULL,request_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plugins(id TEXT PRIMARY KEY,version TEXT NOT NULL,status TEXT NOT NULL,manifest_digest TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_release_state(plugin_id TEXT PRIMARY KEY,applied_seq INTEGER NOT NULL,version_dir TEXT NOT NULL,version TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_permissions(plugin_id TEXT NOT NULL,capability TEXT NOT NULL,granted INTEGER NOT NULL,PRIMARY KEY(plugin_id,capability));
CREATE TABLE IF NOT EXISTS saved_endpoints(server_id TEXT NOT NULL,uri TEXT NOT NULL,public_key_hash TEXT NOT NULL,priority INTEGER NOT NULL,last_success TEXT,last_rtt INTEGER,PRIMARY KEY(server_id,uri));
CREATE INDEX IF NOT EXISTS events_device ON events(device_id);
CREATE INDEX IF NOT EXISTS audit_created ON audit_log(created_at);
INSERT OR IGNORE INTO schema_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%SZ','now'));
INSERT OR IGNORE INTO schema_migrations VALUES(2,strftime('%Y-%m-%dT%H:%M:%SZ','now'));
PRAGMA user_version=2;`
	migration, err := s.DB.Begin()
	if err != nil {
		return err
	}
	_, err = migration.Exec(schema)
	if err != nil {
		migration.Rollback()
		return err
	}
	if err = migration.Commit(); err != nil {
		return err
	}
	var n int
	if err = s.DB.QueryRow("SELECT count(*) FROM workspaces").Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	seed := []struct{ kind, id, data string }{
		{"workspace", "workspace-main", `{"title":"我的工作空间"}`},
		{"page", "page-overview", `{"title":"总览","workspaceId":"workspace-main","icon":"layout"}`},
		{"widget", "widget-cpu", `{"pageId":"page-overview","pluginId":"dev.panestra.system","type":"metric-card","title":"处理器","source":"cpu.usage","unit":"%","color":"sage"}`},
		{"widget", "widget-memory", `{"pageId":"page-overview","pluginId":"dev.panestra.system","type":"metric-card","title":"内存","source":"memory.usage","unit":"%","color":"blue"}`},
		{"widget", "widget-disk", `{"pageId":"page-overview","pluginId":"dev.panestra.system","type":"metric-card","title":"系统磁盘","source":"disk.usage","unit":"%","color":"sand"}`},
		{"widget", "widget-network", `{"pageId":"page-overview","pluginId":"dev.panestra.system","type":"network-chart","title":"网络流量","source":"network.rx","unit":"KB/s","color":"sage"}`},
		{"widget", "widget-system", `{"pageId":"page-overview","pluginId":"dev.panestra.system","type":"system-overview","title":"此刻的 Core","source":"system.info","color":"sage"}`},
	}
	for _, e := range seed {
		if _, err = tx.Exec("INSERT INTO "+tables[e.kind]+" VALUES(?,1,0,?)", e.id, e.data); err != nil {
			return err
		}
	}
	for i, id := range []string{"widget-cpu", "widget-memory", "widget-disk", "widget-network", "widget-system"} {
		for _, bp := range []string{"desktop", "tablet", "mobile"} {
			x, y, w, h := 0, i*3, 4, 3
			if bp == "desktop" {
				if i < 3 {
					x = i * 4
					y = 0
				} else {
					x = (i - 3) * 6
					y = 3
					w = 6
					h = 4
				}
			}
			if bp == "tablet" {
				if i < 2 {
					x = i * 4
					y = 0
				} else {
					y = (i - 1) * 3
					w = 8
				}
			}
			raw, _ := json.Marshal(map[string]any{"widgetId": id, "breakpoint": bp, "x": x, "y": y, "w": w, "h": h, "detached": false})
			if _, err = tx.Exec("INSERT INTO widget_layouts VALUES(?,1,0,?)", id+":"+bp, string(raw)); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}
func (s *Store) SnapshotLocked() (protocol.Snapshot, error) {
	result := protocol.Snapshot{Type: "snapshot", Entities: []protocol.Entity{}}
	if err := s.DB.QueryRow("SELECT coalesce(max(server_seq),0) FROM events").Scan(&result.ServerSeq); err != nil {
		return result, err
	}
	for _, kind := range []string{"workspace", "page", "widget", "layout"} {
		rows, err := s.DB.Query("SELECT id,rev,deleted,data FROM " + tables[kind] + " ORDER BY id")
		if err != nil {
			return result, err
		}
		for rows.Next() {
			e := protocol.Entity{Kind: kind}
			var raw string
			if err = rows.Scan(&e.ID, &e.Rev, &e.Deleted, &raw); err != nil {
				rows.Close()
				return result, err
			}
			e.Data = json.RawMessage(raw)
			result.Entities = append(result.Entities, e)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return result, err
		}
	}
	return result, nil
}
func (s *Store) Snapshot() (protocol.Snapshot, error) {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	return s.SnapshotLocked()
}
func (s *Store) EventsLocked(after int64) ([]protocol.Event, error) {
	rows, err := s.DB.Query("SELECT event FROM events WHERE server_seq>? ORDER BY server_seq LIMIT 10000", after)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []protocol.Event{}
	for rows.Next() {
		var raw string
		var e protocol.Event
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(raw), &e); err != nil {
			return nil, err
		}
		result = append(result, e)
	}
	return result, rows.Err()
}
func (s *Store) Audit(actor, action, target, result, req string) {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	_, _ = s.DB.Exec("INSERT INTO audit_log(actor,action,target,result,request_id,created_at) VALUES(?,?,?,?,?,?)", actor, action, target, result, req, time.Now().UTC().Format(time.RFC3339Nano))
}
func (s *Store) Checkpoint(ctx context.Context) error {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	_, err := s.DB.ExecContext(ctx, "PRAGMA wal_checkpoint(PASSIVE)")
	return err
}
