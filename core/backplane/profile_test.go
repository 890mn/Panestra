package backplane

import (
	"context"
	"encoding/json"
	"github.com/shirou/gopsutil/v4/process"
	"panestra.local/panestra/core/store"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestProfileTwentyOneIsolatedWorkers(t *testing.T) {
	binary, raw := systemProcessFixture(t)
	s, err := store.Open(filepath.Join(t.TempDir(), "profile.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.DB.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	workers := make([]*Runtime, 0, 21)
	counts := make([]atomic.Int64, 21)
	for i := 0; i < 21; i++ {
		r, err := NewRuntime(s, binary, raw)
		if err != nil {
			t.Fatal(err)
		}
		if err = r.Grant("system.metrics.read", true); err != nil {
			t.Fatal(err)
		}
		index := i
		r.Publish = func(Telemetry) { counts[index].Add(1) }
		if err = r.Start(ctx); err != nil {
			t.Fatal(err)
		}
		workers = append(workers, r)
		defer r.Stop()
	}
	deadline := time.Now().Add(15 * time.Second)
	for {
		ready := 0
		for i, r := range workers {
			if counts[i].Load() > 0 && r.Status()["status"] == "running" {
				ready++
			}
		}
		if ready == 21 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("worker startup timeout", ready)
		}
		time.Sleep(50 * time.Millisecond)
	}
	var rss uint64
	for _, r := range workers {
		p, err := process.NewProcess(int32(r.Status()["pid"].(int)))
		if err != nil {
			t.Fatal(err)
		}
		mem, err := p.MemoryInfo()
		if err != nil {
			t.Fatal(err)
		}
		rss += mem.RSS
	}
	workers[0].CrashForTest()
	deadline = time.Now().Add(10 * time.Second)
	for workers[0].Status()["restarts"].(int) == 0 || workers[0].Status()["status"] != "running" {
		if time.Now().After(deadline) {
			t.Fatal("crashed worker failed recovery")
		}
		time.Sleep(50 * time.Millisecond)
	}
	for _, r := range workers[1:] {
		if r.Status()["restarts"].(int) != 0 || r.Status()["status"] != "running" {
			t.Fatal("one worker crash disturbed another")
		}
	}
	result, _ := json.Marshal(map[string]any{"workerProcesses": 21, "aggregateRssBytes": rss, "crashRestarts": workers[0].Status()["restarts"], "unaffectedWorkers": 20, "fixture": "21 concurrent instances of the bundled real System Plugin; not 21 distinct third-party plugins"})
	t.Log("PROFILE " + string(result))
}
