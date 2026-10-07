package netease

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestTimelineEndpointsStayOnConfiguredLoopback(t *testing.T) {
	for _, raw := range []string{"ws://127.0.0.1:19228/devtools/page/one", "ws://localhost:19228/devtools/page/one"} {
		if !localTimelineEndpoint(raw, 19228) {
			t.Fatal("local endpoint rejected", raw)
		}
	}
	for _, raw := range []string{"ws://192.168.1.2:19228/devtools/page/one", "ws://127.0.0.1:9223/devtools/page/one", "wss://127.0.0.1:19228/devtools/page/one", "ws://user:pass@127.0.0.1:19228/devtools/page/one", "ws://127.0.0.1:19228/devtools/page/one?url=other", "ws://127.0.0.1:19228/socket"} {
		if localTimelineEndpoint(raw, 19228) {
			t.Fatal("unexpected endpoint accepted", raw)
		}
	}
}
func TestLocalTimelineProtocolAndInvalidReadings(t *testing.T) {
	for _, invalid := range []string{"", "wrong title", "invalid position", "ambiguous pages", "remote endpoint", "exception"} {
		t.Run(invalid, func(t *testing.T) {
			var port int
			mux := http.NewServeMux()
			mux.HandleFunc("GET /json", func(w http.ResponseWriter, r *http.Request) {
				endpoint := fmt.Sprintf("ws://127.0.0.1:%d/devtools/page/player", port)
				if invalid == "remote endpoint" {
					endpoint = "ws://192.168.1.2:19228/devtools/page/player"
				}
				targets := []map[string]string{{"type": "page", "url": "orpheus://orpheus/pub/app.html", "webSocketDebuggerUrl": endpoint}}
				if invalid == "ambiguous pages" {
					targets = append(targets, targets[0])
				}
				json.NewEncoder(w).Encode(targets)
			})
			mux.HandleFunc("/devtools/page/player", func(w http.ResponseWriter, r *http.Request) {
				conn, err := websocket.Accept(w, r, nil)
				if err != nil {
					return
				}
				defer conn.CloseNow()
				_, raw, err := conn.Read(r.Context())
				if err != nil {
					return
				}
				var request struct {
					Method string `json:"method"`
					Params struct {
						Expression string `json:"expression"`
					} `json:"params"`
				}
				if json.Unmarshal(raw, &request) != nil || request.Method != "Runtime.evaluate" || !strings.Contains(request.Params.Expression, "panestraTimeline(") {
					t.Error("unexpected player operation")
					return
				}
				value := timelineResult{Title: "测试歌曲", TrackID: "track|play", PositionSeconds: pointer(20), DurationSeconds: pointer(100), Seek: true}
				if invalid == "wrong title" {
					value.Title = "下一首"
				}
				if invalid == "invalid position" {
					value.PositionSeconds = pointer(101)
				}
				result := map[string]any{"result": map[string]any{"value": value}}
				if invalid == "exception" {
					result["exceptionDetails"] = map[string]any{"text": "failed"}
				}
				reply, _ := json.Marshal(map[string]any{"id": 1, "result": result})
				conn.Write(r.Context(), websocket.MessageText, reply)
			})
			server := httptest.NewServer(mux)
			defer server.Close()
			parsed, _ := url.Parse(server.URL)
			port, _ = strconv.Atoi(parsed.Port())
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			result, err := callTimeline(ctx, port, "测试歌曲", Action{Action: "read"})
			if invalid == "" && (err != nil || result.TrackID != "track|play" || !result.Seek) {
				t.Fatal("timeline read failed", err)
			}
			if invalid != "" && err == nil {
				t.Fatal("invalid timeline accepted")
			}
		})
	}
}
func TestTimelineFailureKeepsStandardPlaybackControls(t *testing.T) {
	standard := &fakeMedia{call: func(context.Context, Action) (Reading, error) {
		reading := testReading()
		reading.DurationSeconds = nil
		reading.PositionSeconds = nil
		reading.Controls.Seek = false
		return reading, nil
	}}
	media := &timelineMedia{standard: standard}
	media.ConfigureTimeline(1024)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	reading, err := media.Call(ctx, Action{Action: "read"})
	if err != nil || !reading.Controls.Toggle || reading.Controls.Seek || reading.TimelineMessage == "" {
		t.Fatal("standard playback lost after local channel failure", reading, err)
	}
}
func TestTimelineSettingsPersistAndRejectInvalidPort(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	media := &fakeMedia{call: func(context.Context, Action) (Reading, error) { return testReading(), nil }}
	service := newService(ctx, t.TempDir(), nil, media)
	port := 19228
	if _, err := service.Configure(Change{TimelinePort: &port}); err != nil {
		t.Fatal(err)
	}
	if loaded := newService(ctx, strings.TrimSuffix(service.filename, "netease.protected"), nil, media).Snapshot(); loaded.TimelinePort != port {
		t.Fatal("timeline setting lost")
	}
	port = 80
	if _, err := service.Configure(Change{TimelinePort: &port}); err == nil {
		t.Fatal("invalid port accepted")
	}
}
