package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// Re-exec the test binary as a deterministic JSONL peer, never touching Codex credentials.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "app-server" {
		scanner := bufio.NewScanner(os.Stdin)
		encoder := json.NewEncoder(os.Stdout)
		step := 0
		for scanner.Scan() {
			var msg struct {
				ID     any             `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
			}
			_ = json.Unmarshal(scanner.Bytes(), &msg)
			expected := []string{"initialize", "initialized", "account/read", "account/rateLimits/read"}
			if step >= len(expected) || msg.Method != expected[step] {
				os.Exit(10)
			}
			step++
			if msg.ID == nil {
				continue
			}
			var result any = map[string]any{}
			if msg.Method == "account/read" {
				if string(msg.Params) != "{\"refreshToken\":false}" {
					os.Exit(11)
				}
				result = map[string]any{"account": map[string]any{"type": "chatgpt", "planType": "plus", "email": "private@example.test"}}
				if os.Getenv("PANESTRA_TEST_CODEX_APIKEY") == "1" {
					result = map[string]any{"account": map[string]string{"type": "apiKey"}}
				}
			}
			if msg.Method == "account/rateLimits/read" {
				if os.Getenv("PANESTRA_TEST_CODEX_HANG") == "1" {
					time.Sleep(10 * time.Second)
				}
				if os.Getenv("PANESTRA_TEST_CODEX_ERROR") == "1" {
					_ = encoder.Encode(map[string]any{"id": msg.ID, "error": map[string]any{"code": 401, "message": "Unauthorized credential SECRET"}})
					continue
				}
				_ = json.Unmarshal([]byte(`{"rateLimitsByLimitId":{"codex":{"primary":{"usedPercent":30,"windowDurationMins":300,"resetsAt":1900000000}}}}`), &result)
			}
			_ = encoder.Encode(map[string]any{"method": "test/notification", "params": map[string]any{}})
			_ = encoder.Encode(map[string]any{"id": msg.ID, "result": result})
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func TestNormalization(t *testing.T) {
	r, err := ParseLimits([]byte(`{"rateLimits":{"primary":{"usedPercent":99}},"rateLimitsByLimitId":{"z":{"primary":{"usedPercent":-1,"windowDurationMins":10080,"resetsAt":0}},"codex":{"primary":{"usedPercent":120,"windowDurationMins":300,"resetsAt":1900000000},"secondary":{"usedPercent":null}}},"rateLimitResetCredits":{"availableCount":2,"credits":[{"id":"secret","status":"available","expiresAt":1900000000},{"status":"used","expiresAt":100}]}}`))
	if err != nil || len(r.Buckets) != 2 || r.Buckets[0].ID != "codex" {
		t.Fatalf("buckets: %+v %v", r, err)
	}
	w := r.Buckets[0].Windows[0]
	if *w.UsedPercent != 100 || *w.RemainingPercent != 0 || *w.DurationMinutes != 300 {
		t.Fatal(w)
	}
	if r.Buckets[0].Windows[1].UsedPercent != nil || r.Buckets[1].Windows[0].ResetsAt != nil || *r.Buckets[1].Windows[0].UsedPercent != 0 {
		t.Fatal("unknown values must stay unknown")
	}
	if *r.ResetCredits.AvailableCount != 2 || *r.ResetCredits.ExpiresAt != 1900000000 {
		t.Fatal(r.ResetCredits)
	}
	encoded, _ := json.Marshal(r)
	if strings.Contains(string(encoded), "secret") {
		t.Fatal("credit identifiers leaked")
	}
	r, err = ParseLimits([]byte(`{"rateLimits":{"primary":{"usedPercent":5,"windowDurationMins":10080}}}`))
	if err != nil || *r.Buckets[0].Windows[0].DurationMinutes != 10080 {
		t.Fatal("single weekly window must not be guessed as 5h")
	}
	r, _ = ParseLimits([]byte(`{"rateLimits":{"primary":{"usedPercent":5}},"rateLimitsByLimitId":{}}`))
	if len(r.Buckets) != 0 {
		t.Fatal("explicit multi bucket must win")
	}
	r, _ = ParseLimits([]byte(`{"rateLimitResetCredits":{"availableCount":null}}`))
	if r.ResetCredits.AvailableCount != nil {
		t.Fatal("null count is unknown")
	}
}
func TestOfficialReadOnlyHandshake(t *testing.T) {
	exe, _ := os.Executable()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r, err := readExecutable(ctx, exe)
	if err != nil || r.PlanType != "plus" || len(r.Buckets) != 1 {
		t.Fatalf("%+v %v", r, err)
	}
	t.Setenv("PANESTRA_TEST_CODEX_ERROR", "1")
	_, err = readExecutable(ctx, exe)
	if stateFor(err) != "needs_login" || strings.Contains(err.Error(), "SECRET") {
		t.Fatalf("credential error not sanitized: %v", err)
	}
}
func TestUnsupportedAuthAndTimeout(t *testing.T) {
	exe, _ := os.Executable()
	t.Setenv("PANESTRA_TEST_CODEX_APIKEY", "1")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, err := readExecutable(ctx, exe)
	cancel()
	if stateFor(err) != "unsupported_auth" {
		t.Fatal(err)
	}
	t.Setenv("PANESTRA_TEST_CODEX_APIKEY", "0")
	t.Setenv("PANESTRA_TEST_CODEX_HANG", "1")
	ctx, cancel = context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err = readExecutable(ctx, exe)
	if err == nil || time.Since(start) > 2*time.Second {
		t.Fatal("reader failed to stop timed out peer")
	}
}
func waitStatus(t *testing.T, s *Service, condition func(Status) bool) Status {
	t.Helper()
	end := time.Now().Add(time.Second)
	for time.Now().Before(end) {
		v := s.Snapshot()
		if condition(v) {
			return v
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timeout: %+v", s.Snapshot())
	return Status{}
}
func TestServiceRevocationAndThrottle(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	started := make(chan struct{}, 2)
	finish := make(chan struct{})
	s := NewService(ctx, nil)
	s.fetch = func(context.Context) (Reading, error) {
		started <- struct{}{}
		<-finish
		return Reading{PlanType: "plus", Buckets: []Bucket{{ID: "codex"}}}, nil
	}
	s.SetEnabled(true)
	<-started
	s.SetEnabled(false)
	close(finish)
	time.Sleep(20 * time.Millisecond)
	if v := s.Snapshot(); v.Enabled || v.UpdatedAt != "" || len(v.Buckets) != 0 || v.Refreshing {
		t.Fatalf("late reply restored revoked data: %+v", v)
	}
	s.SetEnabled(true)
	<-started
	waitStatus(t, s, func(v Status) bool { return v.State == "ready" })
	s.Refresh()
	s.SetEnabled(true)
	select {
	case <-started:
		t.Fatal("refresh throttle bypassed")
	case <-time.After(20 * time.Millisecond):
	}
	s.fetch = func(context.Context) (Reading, error) { return Reading{}, &ReadError{"unavailable"} }
	s.mu.Lock()
	s.lastAttempt = time.Time{}
	s.mu.Unlock()
	s.Refresh()
	v := waitStatus(t, s, func(v Status) bool { return v.State == "unavailable" })
	if !v.Stale || v.UpdatedAt == "" {
		t.Fatal("transient errors must mark cached data stale")
	}
	s.fetch = func(context.Context) (Reading, error) { return Reading{}, &ReadError{"needs_login"} }
	s.mu.Lock()
	s.lastAttempt = time.Time{}
	s.mu.Unlock()
	s.Refresh()
	v = waitStatus(t, s, func(v Status) bool { return v.State == "needs_login" })
	if v.Stale || len(v.Buckets) != 0 || v.UpdatedAt != "" {
		t.Fatal("login errors must clear previous account data")
	}
}
