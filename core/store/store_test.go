package store

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"panestra.local/panestra/core/protocol"
	"path/filepath"
	"sync"
	"testing"
)

func testStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "panestra.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.DB.Close() })
	raw, err := os.ReadFile("../testdata/system-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.DB.Exec("INSERT INTO plugins VALUES(?,?,?,?,?)", "dev.panestra.system", "0.1.0", "stopped", "fixture", string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if err = s.SeedPlugin(raw); err != nil {
		t.Fatal(err)
	}
	_, err = s.DB.Exec("INSERT INTO devices VALUES('owner-device','Owner','unused','owner','now','now',NULL),('viewer-device','Viewer','unused','viewer','now','now',NULL)")
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func cmd(op, id, kind string, rev int64, payload any) protocol.Command {
	raw, _ := json.Marshal(payload)
	return protocol.Command{OpID: op, DeviceID: "owner-device", EntityID: id, BaseRev: rev, Command: kind, Payload: raw}
}
func TestConcurrentRevisionAndDedupe(t *testing.T) {
	s := testStore(t)
	owner := protocol.Device{ID: "owner-device"}
	var wg sync.WaitGroup
	success := 0
	conflicts := 0
	var mu sync.Mutex
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			e, err := s.Commit(owner, cmd("operation-"+string(rune('A'+i)), "widget-cpu", "widget.update", 1, map[string]any{"title": "并发名称"}))
			mu.Lock()
			defer mu.Unlock()
			if err == nil {
				success++
				if e.ServerSeq != 1 || e.Entity.Rev != 2 {
					t.Errorf("unexpected sequence/rev: %+v", e)
				}
			} else {
				var pe *protocol.Error
				if errors.As(err, &pe) && pe.Code == "REVISION_CONFLICT" && pe.CurrentState != nil {
					conflicts++
				} else {
					t.Errorf("unexpected error: %v", err)
				}
			}
		}(i)
	}
	wg.Wait()
	if success != 1 || conflicts != 19 {
		t.Fatalf("success %d conflicts %d", success, conflicts)
	}
	s.Mu.Lock()
	events, _ := s.EventsLocked(0)
	s.Mu.Unlock()
	c := cmd(events[0].CausedBy, "widget-cpu", "widget.update", 1, map[string]any{"title": "重复请求"})
	duplicate, err := s.Commit(owner, c)
	if err != nil || duplicate.ServerSeq != 1 {
		t.Fatalf("dedupe: %+v %v", duplicate, err)
	}
}
func TestAuthorizationAndTombstones(t *testing.T) {
	s := testStore(t)
	viewer := cmd("operation-viewer", "widget-cpu", "widget.update", 1, map[string]any{"title": "unauthorized"})
	viewer.DeviceID = "viewer-device"
	if _, err := s.Commit(protocol.Device{ID: "viewer-device"}, viewer); err == nil {
		t.Fatal("viewer wrote")
	}
	owner := protocol.Device{ID: "owner-device"}
	if _, err := s.Commit(owner, cmd("operation-last-page", "page-overview", "page.delete", 1, nil)); err == nil {
		t.Fatal("deleted last page")
	}
	if _, err := s.Commit(owner, cmd("operation-delete", "widget-cpu", "widget.delete", 1, nil)); err != nil {
		t.Fatal(err)
	}
	_, err := s.Commit(owner, cmd("operation-resurrect", "widget-cpu", "widget.update", 2, map[string]any{"title": "resurrect"}))
	var pe *protocol.Error
	if !errors.As(err, &pe) || pe.Code != "ENTITY_DELETED" {
		t.Fatal(err)
	}
	snapshot, _ := s.Snapshot()
	deleted := 0
	for _, e := range snapshot.Entities {
		if (e.ID == "widget-cpu" || e.Kind == "layout" && stringField(e.Data, "widgetId") == "widget-cpu") && e.Deleted {
			deleted++
		}
	}
	if deleted != 4 {
		t.Fatalf("expected widget+3 layout tombstones: %d", deleted)
	}
}
func stringField(data json.RawMessage, key string) string {
	m := map[string]any{}
	json.Unmarshal(data, &m)
	s, _ := m[key].(string)
	return s
}
func TestIndependentBreakpointsAndInvalidGeometry(t *testing.T) {
	s := testStore(t)
	owner := protocol.Device{ID: "owner-device"}
	for i, bp := range []string{"desktop", "tablet", "mobile"} {
		_, err := s.Commit(owner, cmd("operation-layout-"+bp, "widget-cpu:"+bp, "layout.commit", 1, map[string]any{"widgetId": "widget-cpu", "breakpoint": bp, "x": 0, "y": i + 1, "w": 4, "h": 3}))
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err := s.Commit(owner, cmd("operation-invalid", "widget-cpu:mobile", "layout.commit", 2, map[string]any{"widgetId": "widget-cpu", "breakpoint": "mobile", "x": 3, "y": 0, "w": 4, "h": 3}))
	if err == nil {
		t.Fatal("accepted overflowing mobile geometry")
	}
}
func TestOnlineBackupRestore(t *testing.T) {
	s := testStore(t)
	path := filepath.Join(t.TempDir(), "backup.db")
	if err := s.Backup(context.Background(), path); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Commit(protocol.Device{ID: "owner-device"}, cmd("operation-before-restore", "widget-cpu", "widget.update", 1, map[string]any{"title": "changed"})); err != nil {
		t.Fatal(err)
	}
	if err := s.Restore(context.Background(), path); err != nil {
		t.Fatal(err)
	}
	snapshot, err := s.Snapshot()
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.ServerSeq != 0 {
		t.Fatal("restore did not restore state")
	}
	for _, e := range snapshot.Entities {
		if e.ID == "widget-cpu" && e.Rev != 1 {
			t.Fatal("wrong restored revision")
		}
	}
	if err := s.Backup(context.Background(), path); err == nil {
		t.Fatal("overwrote backup")
	}
}
func BenchmarkLayoutCommit(b *testing.B) {
	s, err := Open(filepath.Join(b.TempDir(), "performance.db"))
	if err != nil {
		b.Fatal(err)
	}
	defer s.DB.Close()
	s.DB.Exec("INSERT INTO devices VALUES('owner-device','Owner','unused','owner','now','now',NULL)")
	owner := protocol.Device{ID: "owner-device"}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		c := cmd("benchmark-"+string(rune(i+1000)), "widget-cpu:desktop", "layout.commit", int64(i+1), map[string]any{"widgetId": "widget-cpu", "breakpoint": "desktop", "x": i % 8, "y": 0, "w": 4, "h": 3})
		if _, err = s.Commit(owner, c); err != nil {
			b.Fatal(err)
		}
	}
}
