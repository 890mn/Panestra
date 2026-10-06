package server

import (
	"context"
	"encoding/json"
	"fmt"
	"panestra.local/panestra/core/backplane"
	"panestra.local/panestra/core/protocol"
	"sort"
	"sync"
	"testing"
	"time"
)

func percentiles(values []float64) map[string]float64 {
	sort.Float64s(values)
	result := map[string]float64{}
	for name, p := range map[string]float64{"p50": .5, "p95": .95, "p99": .99} {
		result[name] = values[int(float64(len(values)-1)*p)]
	}
	return result
}

// Synthetic registered topics exercise the actual TLS/WS transport, store and fan-out.
func TestProfileTenClientsThreeHundredWidgetsTwoHundredTopics(t *testing.T) {
	s, httpServer, token := setup(t)
	device, _ := s.Auth.Validate(token)
	for i := 0; i < 295; i++ {
		id := fmt.Sprintf("profile-widget-%03d", i)
		_, err := s.Store.Commit(device, protocol.Command{OpID: "create-" + id, DeviceID: device.ID, EntityID: id, Command: "widget.create", Payload: json.RawMessage(`{"pageId":"page-overview","pluginId":"dev.panestra.system","type":"metric-card","title":"Profile","source":"cpu.usage","unit":"%","color":"sage"}`)})
		if err != nil {
			t.Fatal(err)
		}
	}
	snap, _ := s.Store.Snapshot()
	count := 0
	for _, e := range snap.Entities {
		if e.Kind == "widget" && !e.Deleted {
			count++
		}
	}
	if count != 300 {
		t.Fatalf("widget count %d", count)
	}
	topics := make([]string, 200)
	for i := range topics {
		id := fmt.Sprintf("profile.%03d", i)
		s.Plugin.Manifest.Sources = append(s.Plugin.Manifest.Sources, backplane.Source{ID: id, Interval: 1000})
		topics[i] = s.Plugin.Manifest.ID + "/" + id
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var wg sync.WaitGroup
	failures := make(chan error, 10)
	latency := make(chan float64, 1000)
	starts := sync.Map{}
	for i := 0; i < 10; i++ {
		ws := socket(t, httpServer, token, 0)
		readMessage(t, ws)
		raw, _ := json.Marshal(map[string]any{"type": "subscribe", "topics": topics})
		if err := ws.Write(ctx, 1, raw); err != nil {
			t.Fatal(err)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			seen := map[string]bool{}
			events := 0
			for events < 100 || len(seen) < 200 {
				_, raw, err := ws.Read(ctx)
				if err != nil {
					failures <- err
					return
				}
				var m struct {
					Type     string `json:"type"`
					Topic    string `json:"topic"`
					CausedBy string `json:"causedBy"`
				}
				if err = json.Unmarshal(raw, &m); err != nil {
					failures <- err
					return
				}
				if m.Type == "telemetry" {
					seen[m.Topic] = true
				}
				if m.Type == "event" {
					if start, ok := starts.Load(m.CausedBy); ok {
						latency <- float64(time.Since(start.(time.Time)).Microseconds()) / 1000
						events++
					}
				}
			}
		}()
	}
	// Wait until all subscriptions are registered before the one-sample-per-topic burst.
	deadline := time.Now().Add(3 * time.Second)
	for {
		n := 0
		s.Hub.mu.Lock()
		for p := range s.Hub.peers {
			p.mu.RLock()
			if len(p.topics) == 200 {
				n++
			}
			p.mu.RUnlock()
		}
		s.Hub.mu.Unlock()
		if n == 10 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("subscription timeout")
		}
		time.Sleep(5 * time.Millisecond)
	}
	for i, topic := range topics {
		s.Hub.Telemetry(backplane.Telemetry{Type: "telemetry", Topic: topic, Seq: uint64(i + 1), Value: i})
		time.Sleep(2 * time.Millisecond)
	}
	apiLatencies := make([]float64, 0, 100)
	for i := 0; i < 100; i++ {
		op := fmt.Sprintf("profile-edit-%03d", i)
		start := time.Now()
		starts.Store(op, start)
		status, body := api(t, httpServer, token, "POST", "/api/v1/commands", protocol.Command{OpID: op, DeviceID: device.ID, EntityID: "widget-cpu", BaseRev: int64(i + 1), Command: "widget.update", Payload: json.RawMessage(fmt.Sprintf(`{"title":"CPU %d"}`, i))})
		if status != 200 {
			t.Fatal(status, string(body))
		}
		apiLatencies = append(apiLatencies, float64(time.Since(start).Microseconds())/1000)
	}
	wg.Wait()
	close(failures)
	for err := range failures {
		t.Fatal(err)
	}
	close(latency)
	propagation := make([]float64, 0, 1000)
	for v := range latency {
		propagation = append(propagation, v)
	}
	if len(propagation) != 1000 {
		t.Fatal("event fan-out incomplete", len(propagation))
	}
	if err := s.Store.Checkpoint(ctx); err != nil {
		t.Fatal(err)
	}
	// Ten simultaneous reconnects at the current sequence must all yield a consistent snapshot.
	snap, _ = s.Store.Snapshot()
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ws := socket(t, httpServer, token, snap.ServerSeq)
			msg := readMessage(t, ws)
			if string(msg["type"]) != `"snapshot"` {
				t.Error("reconnect missing snapshot")
			}
		}()
	}
	wg.Wait()
	result, _ := json.Marshal(map[string]any{"clients": 10, "widgets": 300, "topics": 200, "apiMs": percentiles(apiLatencies), "eventMs": percentiles(propagation), "hub": s.Hub.Stats(), "sqlite": s.Store.Version})
	t.Log("PROFILE " + string(result))
}
