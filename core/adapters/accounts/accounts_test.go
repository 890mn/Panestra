package accounts

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestReadContractAndErrors(t *testing.T) {
	for _, id := range IDs {
		t.Run(id, func(t *testing.T) {
			fixture := `{"is_available":false,"balance_infos":[{"currency":"CNY","total_balance":"0.00","granted_balance":"0.00","topped_up_balance":"0.00"}]}`
			if id == "glm" {
				fixture = `{"code":200,"success":true,"data":{"limits":[{"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":34,"currentValue":13628365,"usage":40000000,"nextResetTime":1768507567547},{"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":68}]}}`
			}
			status := 200
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != "GET" || r.Header.Get("Authorization") != "test-only-account-key" {
					t.Error("unexpected request")
				}
				w.WriteHeader(status)
				_, _ = w.Write([]byte(fixture))
			}))
			defer server.Close()
			reading, err := readHTTP(context.Background(), server.Client(), server.URL, "test-only-account-key", id)
			if err != nil {
				t.Fatal(err)
			}
			if id == "glm" {
				if len(reading.Windows) != 2 || reading.Windows[0].Name != "编程额度 · 5 小时" || reading.Windows[1].Name != "编程额度 · 1 周" || *reading.Windows[0].RemainingPercent != 66 || *reading.Windows[0].ResetsAt != 1768507567 || reading.Windows[1].ResetsAt != nil {
					t.Fatal(reading)
				}
			} else if *reading.Available || reading.Balances[0].Total != "0.00" {
				t.Fatal(reading)
			}
			for _, code := range []int{401, 403, 429, 500, 302} {
				status = code
				_, err = readHTTP(context.Background(), server.Client(), server.URL, "test-only-account-key", id)
				if err == nil {
					t.Fatal("failure misreported as success", code)
				}
			}
			status = 200
			fixture = `{"error":"test-only-account-key"}`
			_, err = readHTTP(context.Background(), server.Client(), server.URL, "test-only-account-key", id)
			if err == nil || strings.Contains(err.Error(), "test-only-account-key") {
				t.Fatal("secret leaked or invalid payload accepted")
			}
		})
	}
}
func TestMissingValuesAndDecimalPrecision(t *testing.T) {
	reading, err := ParseGLM([]byte(`{"success":true,"data":{"limits":[{"type":"TOKENS_LIMIT"}]}}`))
	if err != nil || reading.Windows[0].UsedPercent != nil || reading.Windows[0].RemainingPercent != nil || reading.Windows[0].ResetsAt != nil {
		t.Fatal("missing values guessed", reading, err)
	}
	reading, err = ParseDeepSeek([]byte(`{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"123456789.00000001","granted_balance":"0.00000001","topped_up_balance":"123456789.00"},{"currency":"USD","total_balance":"2.05","granted_balance":"0.00","topped_up_balance":"2.05"}]}`))
	if err != nil || len(reading.Balances) != 2 || reading.Balances[0].Total != "123456789.00000001" {
		t.Fatal("balance precision lost", reading, err)
	}
	for _, raw := range []string{`{}`, `{"success":false,"data":{"limits":[]}}`, `{"code":401,"data":{"limits":[{}]}}`} {
		if _, err := ParseGLM([]byte(raw)); err == nil {
			t.Fatal("invalid GLM payload accepted")
		}
	}
	negative, err := ParseDeepSeek([]byte(`{"is_available":false,"balance_infos":[{"currency":"CNY","total_balance":"-0.01","granted_balance":"0.00","topped_up_balance":"0.00"}]}`))
	if err != nil || negative.Balances[0].Total != "-0.01" {
		t.Fatal("negative balance lost", negative, err)
	}
	for _, bad := range []string{"NaN", "Infinity", "not-money", "1e5", "+1", " 1"} {
		raw := `{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"` + bad + `","granted_balance":"0","topped_up_balance":"0"}]}`
		if _, err := ParseDeepSeek([]byte(raw)); err == nil {
			t.Fatal("invalid balance accepted")
		}
	}
}
func waitFor(t *testing.T, s *Service, state string) Status {
	t.Helper()
	end := time.Now().Add(2 * time.Second)
	for time.Now().Before(end) {
		snapshot := s.Snapshot()
		if snapshot.State == state && !snapshot.Refreshing {
			return snapshot
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("timed out", s.Snapshot())
	return Status{}
}
func TestCredentialProtectionPersistenceAndRevocation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	dir := t.TempDir()
	s := NewService(ctx, "deepseek", dir, nil)
	var calls atomic.Int32
	s.fetch = func(context.Context, string, string) (Reading, error) {
		calls.Add(1)
		return ParseDeepSeek([]byte(`{"is_available":true,"balance_infos":[{"currency":"CNY","total_balance":"12.34","granted_balance":"0.00","topped_up_balance":"12.34"}]}`))
	}
	enabled, key := true, "test-only-persisted-account-key"
	if _, err := s.Configure(Change{Enabled: &enabled, APIKey: &key}); err != nil {
		t.Fatal(err)
	}
	snapshot := waitFor(t, s, "ready")
	raw, err := os.ReadFile(s.filename)
	if err != nil || strings.Contains(string(raw), key) {
		t.Fatal("credential not encrypted", err)
	}
	public, _ := json.Marshal(snapshot)
	if strings.Contains(string(public), key) {
		t.Fatal("credential reached public status")
	}
	for range 8 {
		s.Refresh()
	}
	if calls.Load() != 1 {
		t.Fatal("poll throttle failed")
	}
	// Preserve the last successful reading during transient errors, and clear it on credential rejection.
	s.mu.Lock()
	s.lastAttempt = time.Time{}
	s.fetch = func(context.Context, string, string) (Reading, error) {
		return Reading{}, fail("unavailable", "network failure")
	}
	s.mu.Unlock()
	s.Refresh()
	snapshot = waitFor(t, s, "unavailable")
	if !snapshot.Stale || len(snapshot.Balances) != 1 {
		t.Fatal(snapshot)
	}
	s.mu.Lock()
	s.lastAttempt = time.Time{}
	s.fetch = func(context.Context, string, string) (Reading, error) {
		return Reading{}, fail("needs_credential", "expired")
	}
	s.mu.Unlock()
	s.Refresh()
	snapshot = waitFor(t, s, "needs_credential")
	if snapshot.Stale || len(snapshot.Balances) != 0 {
		t.Fatal("old credential data retained", snapshot)
	}
	enabled = false
	if _, err := s.Configure(Change{Enabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	reloaded := NewService(ctx, "deepseek", dir, nil)
	if !reloaded.Snapshot().HasCredential || reloaded.Snapshot().Enabled {
		t.Fatal("configuration did not persist")
	}
	if _, err := s.Configure(Change{ClearCredential: true}); err != nil {
		t.Fatal(err)
	}
	cleared := NewService(ctx, "deepseek", dir, nil).Snapshot()
	if cleared.HasCredential || cleared.Enabled {
		t.Fatal("credential not removed")
	}
}
func TestDisabledAccountRejectsInflightResult(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := NewService(ctx, "glm", t.TempDir(), nil)
	started, finish := make(chan struct{}), make(chan struct{})
	s.fetch = func(context.Context, string, string) (Reading, error) {
		close(started)
		<-finish
		return Reading{Windows: []Window{{ID: "old"}}}, nil
	}
	enabled, key := true, "test-only-inflight-key"
	if _, err := s.Configure(Change{Enabled: &enabled, APIKey: &key}); err != nil {
		t.Fatal(err)
	}
	<-started
	enabled = false
	if _, err := s.Configure(Change{Enabled: &enabled}); err != nil {
		t.Fatal(err)
	}
	close(finish)
	time.Sleep(20 * time.Millisecond)
	snapshot := s.Snapshot()
	if snapshot.Enabled || snapshot.State != "disabled" || len(snapshot.Windows) != 0 {
		t.Fatal("late result restored disabled account", snapshot)
	}
}
