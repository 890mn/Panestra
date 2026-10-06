package backplane

import (
	"bytes"
	"context"
	"errors"
	"os"
	"panestra.local/panestra/core/store"
	"path/filepath"
	"testing"
	"time"
)

func TestLiveVerifiedSwitchAndFailureRetainsOldWorker(t *testing.T) {
	binary, _ := filepath.Abs("../../artifacts/system-plugin.exe")
	if _, err := os.Stat(binary); err != nil {
		t.Skip("build bundled worker first")
	}
	s, err := store.Open(filepath.Join(t.TempDir(), "state.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	raw, _ := os.ReadFile("../../plugins/system/manifest.json")
	r, err := NewRuntime(s, binary, raw)
	if err != nil {
		t.Fatal(err)
	}
	r.Grant("system.metrics.read", true)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r.Start(ctx)
	defer r.Stop()
	deadline := time.Now().Add(8 * time.Second)
	for r.Status()["status"] != "running" {
		if time.Now().After(deadline) {
			t.Fatal("worker not running")
		}
		time.Sleep(25 * time.Millisecond)
	}
	oldPID := r.Status()["pid"]
	if err = r.SwitchVerified(ctx, binary, raw, nil, func() error { return errors.New("bad signature") }); err == nil || r.Status()["pid"] != oldPID {
		t.Fatal("signature failure changed worker")
	}
	if err = r.SwitchVerified(ctx, filepath.Join(t.TempDir(), "missing.exe"), raw, nil, func() error { return nil }); err == nil || r.Status()["pid"] != oldPID {
		t.Fatal("failed candidate replaced worker")
	}
	changed := bytes.Replace(raw, []byte(`"system.metrics.read"`), []byte(`"process.list"`), 1)
	if err = r.SwitchVerified(ctx, binary, changed, nil, func() error { return nil }); err == nil {
		t.Fatal("new required capability did not require consent")
	}
	if err = r.SwitchVerified(ctx, binary, raw, nil, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	if r.Status()["pid"] == oldPID || r.Status()["status"] != "running" {
		t.Fatal("verified healthy worker not promoted")
	}
	if err = r.Grant("system.session.lock", true); err != nil || !r.Granted("system.session.lock") {
		t.Fatal("stable handle failed grant after update")
	}
}
