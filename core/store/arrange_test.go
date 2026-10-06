package store

import (
	"encoding/json"
	"errors"
	"panestra.local/panestra/core/protocol"
	"testing"
)

func TestArrangeAtomicSwapUndoConflictAndDedupe(t *testing.T) {
	s := testStore(t)
	owner := protocol.Device{ID: "owner-device"}
	snapshot, _ := s.Snapshot()
	var cpu, memory map[string]any
	for _, entity := range snapshot.Entities {
		if entity.ID == "widget-cpu:tablet" {
			json.Unmarshal(entity.Data, &cpu)
		}
		if entity.ID == "widget-memory:tablet" {
			json.Unmarshal(entity.Data, &memory)
		}
	}
	cpu["x"], memory["x"] = memory["x"], cpu["x"]
	payload := map[string]any{"breakpoint": "tablet", "items": []any{map[string]any{"baseRev": 1, "layout": cpu}, map[string]any{"baseRev": 1, "layout": memory}}}
	request := cmd("operation-swap-layout", "page-overview", "layout.arrange", 0, payload)
	event, err := s.Commit(owner, request)
	if err != nil || len(event.Entities) != 2 || event.ServerSeq != 1 {
		t.Fatalf("%+v %v", event, err)
	}
	duplicate, err := s.Commit(owner, request)
	if err != nil || duplicate.ServerSeq != event.ServerSeq || len(duplicate.Entities) != 2 {
		t.Fatal("duplicate swap was repeated")
	}
	cpu["x"], memory["x"] = memory["x"], cpu["x"]
	conflict := cmd("operation-conflict-swap", "page-overview", "layout.arrange", 0, map[string]any{"breakpoint": "tablet", "items": []any{map[string]any{"baseRev": 2, "layout": cpu}, map[string]any{"baseRev": 1, "layout": memory}}})
	_, err = s.Commit(owner, conflict)
	var pe *protocol.Error
	if !errors.As(err, &pe) || pe.Code != "REVISION_CONFLICT" {
		t.Fatal(err)
	}
	after, _ := s.Snapshot()
	for _, entity := range after.Entities {
		if entity.ID == "widget-cpu:tablet" && (entity.Rev != 2 || stringField(entity.Data, "breakpoint") != "tablet") {
			t.Fatal("partial swap committed")
		}
	}
	undo := cmd("operation-undo-swap", "page-overview", "layout.arrange", 0, map[string]any{"breakpoint": "tablet", "items": []any{map[string]any{"baseRev": 2, "layout": cpu}, map[string]any{"baseRev": 2, "layout": memory}}})
	event, err = s.Commit(owner, undo)
	if err != nil || len(event.Entities) != 2 || event.ServerSeq != 2 {
		t.Fatal(err)
	}
	cpu["x"] = 4
	_, err = s.Commit(owner, cmd("operation-collision", "page-overview", "layout.arrange", 0, map[string]any{"breakpoint": "tablet", "items": []any{map[string]any{"baseRev": 3, "layout": cpu}}}))
	if !errors.As(err, &pe) || pe.Code != "LAYOUT_COLLISION" {
		t.Fatal("overlap accepted", err)
	}
	_, err = s.Commit(owner, cmd("operation-wrong-page", "missing-page", "layout.arrange", 0, payload))
	if err == nil {
		t.Fatal("cross page accepted")
	}
	viewer := request
	viewer.OpID = "operation-viewer-swap"
	viewer.DeviceID = "viewer-device"
	_, err = s.Commit(protocol.Device{ID: "viewer-device"}, viewer)
	if !errors.As(err, &pe) || pe.Code != "FORBIDDEN" {
		t.Fatal("viewer swap accepted")
	}
}
