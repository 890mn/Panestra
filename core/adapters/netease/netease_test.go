package netease

import (
	"context"
	"encoding/base64"
	"math"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

type fakeMedia struct {
	call  func(context.Context, Action) (Reading, error)
	calls atomic.Int32
}

func (m *fakeMedia) Call(ctx context.Context, a Action) (Reading, error) {
	m.calls.Add(1)
	return m.call(ctx, a)
}
func (*fakeMedia) Close()            {}
func pointer(value float64) *float64 { return &value }
func testReading() Reading {
	return Reading{State: "ready", Title: "测试歌曲", Artist: "测试歌手", Playback: "Playing", PositionSeconds: pointer(20), DurationSeconds: pointer(100), Controls: Controls{Toggle: true, Previous: true, Next: true, Seek: true}}
}

func TestMediaStatusAndActionValidation(t *testing.T) {
	for _, a := range []Action{{Action: "unsupported"}, {Action: "read"}, {Action: "seek"}, {Action: "seek", PositionSeconds: pointer(-1)}, {Action: "seek", PositionSeconds: pointer(math.Inf(1))}, {Action: "toggle", PositionSeconds: pointer(1)}} {
		if validAction(a) == nil {
			t.Fatal("invalid action accepted", a)
		}
	}
	for _, a := range []Action{{Action: "toggle"}, {Action: "previous"}, {Action: "next"}, {Action: "seek", PositionSeconds: pointer(50)}} {
		if err := validAction(a); err != nil {
			t.Fatal(err)
		}
	}
	reading := testReading()
	if err := validReading(reading); err != nil {
		t.Fatal(err)
	}
	reading.PositionSeconds = pointer(101)
	if validReading(reading) == nil {
		t.Fatal("out of range position accepted")
	}
	reading.PositionSeconds = nil
	reading.DurationSeconds = nil
	if err := validReading(reading); err != nil {
		t.Fatal("unknown duration rejected", err)
	}
	reading.Playback = "invented"
	if validReading(reading) == nil {
		t.Fatal("invalid playback accepted")
	}
}

func TestArtworkIsBoundedRasterData(t *testing.T) {
	reading := testReading()
	reading.ArtworkDataURL = "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte{137, 80, 78, 71, 13, 10, 26, 10})
	if err := validReading(reading); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"https://example.com/cover.jpg", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,broken", "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte("not an image"))} {
		reading.ArtworkDataURL = invalid
		if validReading(reading) == nil {
			t.Fatal("invalid artwork accepted")
		}
	}
}

func TestReadControlPermissionAndLostPlayer(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	media := &fakeMedia{call: func(context.Context, Action) (Reading, error) { return testReading(), nil }}
	s := newService(ctx, t.TempDir(), nil, media)
	if err := s.Control(ctx, Action{Action: "toggle"}); err == nil || media.calls.Load() != 0 {
		t.Fatal("disabled control reached media")
	}
	enabled, allow := true, false
	if _, err := s.Configure(Change{Enabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for s.Snapshot().State != "ready" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if s.Snapshot().State != "ready" {
		t.Fatal("poll failed")
	}
	if err := s.Control(ctx, Action{Action: "toggle"}); err == nil {
		t.Fatal("read-only configuration controlled playback")
	}
	allow = true
	if _, err := s.Configure(Change{AllowControl: &allow}); err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(time.Second)
	for s.Snapshot().State != "ready" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if err := s.Control(ctx, Action{Action: "seek", PositionSeconds: pointer(40)}); err != nil {
		t.Fatal(err)
	}
	s.operation.Lock()
	media.call = func(context.Context, Action) (Reading, error) {
		return Reading{State: "not_found"}, fail("not_found", "未找到播放器")
	}
	s.operation.Unlock()
	if err := s.Control(ctx, Action{Action: "toggle"}); err == nil {
		t.Fatal("missing player accepted operation")
	}
	lost := s.Snapshot()
	if lost.State != "not_found" || lost.Title != "" || lost.PositionSeconds != nil || lost.Stale || lost.Controls.Toggle {
		t.Fatal("lost player retained old metadata", lost)
	}
	enabled = false
	if _, err := s.Configure(Change{Enabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	calls := media.calls.Load()
	if err := s.Control(ctx, Action{Action: "next"}); err == nil || media.calls.Load() != calls {
		t.Fatal("revoked control reached media")
	}
	loaded := newService(ctx, filepath.Dir(s.filename), nil, media).Snapshot()
	if loaded.Enabled || loaded.AllowControl {
		t.Fatal("revocation not persisted")
	}
}

func TestDisabledPollCannotRestoreOldTrack(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started, finish := make(chan struct{}), make(chan struct{})
	media := &fakeMedia{call: func(context.Context, Action) (Reading, error) { close(started); <-finish; return testReading(), nil }}
	s := newService(ctx, t.TempDir(), nil, media)
	enabled := true
	if _, err := s.Configure(Change{Enabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	<-started
	enabled = false
	if _, err := s.Configure(Change{Enabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	close(finish)
	deadline := time.Now().Add(time.Second)
	for !s.operation.TryLock() {
		if time.Now().After(deadline) {
			t.Fatal("poll did not finish")
		}
		time.Sleep(time.Millisecond)
	}
	s.operation.Unlock()
	if status := s.Snapshot(); status.Enabled || status.Title != "" || status.State != "disabled" {
		t.Fatal("late poll restored disabled track", status)
	}
}

func TestRevocationCancelsInFlightControl(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started, stopped := make(chan struct{}), make(chan error, 1)
	media := &fakeMedia{call: func(ctx context.Context, a Action) (Reading, error) {
		if a.Action == "read" {
			return testReading(), nil
		}
		close(started)
		<-ctx.Done()
		return Reading{}, ctx.Err()
	}}
	s := newService(ctx, t.TempDir(), nil, media)
	enabled, control := true, true
	if _, err := s.Configure(Change{Enabled: &enabled, AllowControl: &control}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for s.Snapshot().State != "ready" && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	for !s.operation.TryLock() {
		if time.Now().After(deadline) {
			t.Fatal("initial read did not finish")
		}
		time.Sleep(time.Millisecond)
	}
	s.operation.Unlock()
	go func() { stopped <- s.Control(ctx, Action{Action: "next"}) }()
	<-started
	enabled = false
	if _, err := s.Configure(Change{Enabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-stopped:
		if err == nil {
			t.Fatal("revoked operation reported success")
		}
	case <-time.After(time.Second):
		t.Fatal("revocation did not cancel in-flight control")
	}
	if status := s.Snapshot(); status.Enabled || status.Title != "" || status.State != "disabled" {
		t.Fatal("cancelled action restored track", status)
	}
}
