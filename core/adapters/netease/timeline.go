package netease

import (
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
)

//go:embed timeline.js
var timelineScript string

type timelineMedia struct {
	standard Media
	port     atomic.Int32
}

func (m *timelineMedia) ConfigureTimeline(port int) { m.port.Store(int32(port)) }
func (m *timelineMedia) Close()                     { m.standard.Close() }
func (m *timelineMedia) Call(ctx context.Context, action Action) (Reading, error) {
	port := int(m.port.Load())
	if action.Action == "seek" {
		reading, err := m.standard.Call(ctx, Action{Action: "read"})
		if err != nil {
			return reading, err
		}
		reading.TrackID = standardTrackID(reading)
		if reading.Controls.Seek || port == 0 {
			if action.TrackID != "" && action.TrackID != reading.TrackID {
				return reading, fail("unavailable", "歌曲已切换，请重新调整进度")
			}
			after, err := m.standard.Call(ctx, action)
			if err == nil {
				after.TrackID = standardTrackID(after)
				after.TimelineSource = "smtc"
			}
			return after, err
		}
		result, err := callTimeline(ctx, port, reading.Title, action)
		if err != nil {
			return reading, fail("unavailable", "未能确认进度跳转，请检查网易云本机进度通道")
		}
		applyTimeline(&reading, result)
		return reading, nil
	}
	reading, err := m.standard.Call(ctx, action)
	if err != nil || reading.State != "ready" {
		return reading, err
	}
	reading.TrackID = standardTrackID(reading)
	if reading.DurationSeconds != nil {
		reading.TimelineSource = "smtc"
	}
	if reading.DurationSeconds != nil && reading.Controls.Seek {
		reading.TimelineSource = "smtc"
		return reading, nil
	}
	if port != 0 {
		probe, cancel := context.WithTimeout(ctx, 2500*time.Millisecond)
		result, timelineErr := callTimeline(probe, port, reading.Title, Action{Action: "read"})
		cancel()
		if timelineErr == nil {
			applyTimeline(&reading, result)
		} else {
			reading.TimelineMessage = "本机进度通道未连接或播放器版本不兼容"
		}
	}
	return reading, nil
}
func standardTrackID(reading Reading) string {
	return fmt.Sprintf("smtc:%x", sha256.Sum256([]byte(reading.Title+"\x00"+reading.Artist+"\x00"+reading.Album)))
}

type timelineResult struct {
	Title           string   `json:"title"`
	TrackID         string   `json:"trackId"`
	PositionSeconds *float64 `json:"positionSeconds"`
	DurationSeconds *float64 `json:"durationSeconds"`
	Seek            bool     `json:"seek"`
}

func applyTimeline(reading *Reading, result timelineResult) {
	reading.PositionSeconds, reading.DurationSeconds, reading.TrackID = result.PositionSeconds, result.DurationSeconds, result.TrackID
	reading.Controls.Seek, reading.TimelineSource = result.Seek, "local"
}
func localTimelineEndpoint(raw string, port int) bool {
	endpoint, err := url.Parse(raw)
	return err == nil && endpoint.Scheme == "ws" && endpoint.User == nil && endpoint.Fragment == "" && endpoint.RawQuery == "" && (endpoint.Hostname() == "127.0.0.1" || endpoint.Hostname() == "localhost") && endpoint.Port() == strconv.Itoa(port) && strings.HasPrefix(endpoint.Path, "/devtools/page/")
}
func callTimeline(ctx context.Context, port int, title string, action Action) (timelineResult, error) {
	var result timelineResult
	if port == 0 || !validTimelinePort(port) || (action.Action != "read" && action.Action != "seek") {
		return result, fmt.Errorf("invalid timeline request")
	}
	if action.Action == "seek" {
		if err := validAction(action); err != nil || action.TrackID == "" {
			return result, fmt.Errorf("invalid seek")
		}
	}
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: time.Second}).DialContext, DisableKeepAlives: true}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return fmt.Errorf("redirect refused") }}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf("http://127.0.0.1:%d/json", port), nil)
	if err != nil {
		return result, err
	}
	response, err := client.Do(request)
	if err != nil {
		return result, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return result, fmt.Errorf("discovery failed")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 1048577))
	if err != nil || len(raw) > 1048576 {
		return result, fmt.Errorf("invalid discovery response")
	}
	var targets []struct {
		Type     string `json:"type"`
		URL      string `json:"url"`
		Endpoint string `json:"webSocketDebuggerUrl"`
	}
	if json.Unmarshal(raw, &targets) != nil {
		return result, fmt.Errorf("invalid targets")
	}
	endpoint := ""
	for _, target := range targets {
		if target.Type == "page" && strings.HasPrefix(target.URL, "orpheus://") && localTimelineEndpoint(target.Endpoint, port) {
			if endpoint != "" {
				return result, fmt.Errorf("ambiguous player pages")
			}
			endpoint = target.Endpoint
		}
	}
	if endpoint == "" {
		return result, fmt.Errorf("no player page")
	}
	conn, _, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{HTTPClient: client})
	if err != nil {
		return result, err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(65536)
	parameters, _ := json.Marshal(struct {
		Action   string   `json:"action"`
		Position *float64 `json:"positionSeconds,omitempty"`
		TrackID  string   `json:"trackId,omitempty"`
		Title    string   `json:"title"`
	}{action.Action, action.PositionSeconds, action.TrackID, title})
	expression := timelineScript + "\npanestraTimeline(" + string(parameters) + ")"
	payload, _ := json.Marshal(map[string]any{"id": 1, "method": "Runtime.evaluate", "params": map[string]any{"expression": expression, "returnByValue": true, "awaitPromise": true}})
	if err = conn.Write(ctx, websocket.MessageText, payload); err != nil {
		return result, err
	}
	for {
		_, raw, err = conn.Read(ctx)
		if err != nil {
			return result, err
		}
		var reply struct {
			ID     int             `json:"id"`
			Error  json.RawMessage `json:"error"`
			Result struct {
				Exception json.RawMessage `json:"exceptionDetails"`
				Result    struct {
					Value json.RawMessage `json:"value"`
				} `json:"result"`
			} `json:"result"`
		}
		if json.Unmarshal(raw, &reply) != nil {
			return result, fmt.Errorf("invalid protocol response")
		}
		if reply.ID != 1 {
			continue
		}
		if len(reply.Error) > 0 || len(reply.Result.Exception) > 0 || json.Unmarshal(reply.Result.Result.Value, &result) != nil {
			return result, fmt.Errorf("timeline operation failed")
		}
		if result.Title != title || result.TrackID == "" || len(result.TrackID) > 512 || result.DurationSeconds == nil || *result.DurationSeconds <= 0 || result.PositionSeconds == nil {
			return result, fmt.Errorf("invalid timeline data")
		}
		reading := Reading{State: "ready", Title: result.Title, TrackID: result.TrackID, Playback: "Paused", PositionSeconds: result.PositionSeconds, DurationSeconds: result.DurationSeconds}
		if err = validReading(reading); err != nil {
			return result, err
		}
		return result, nil
	}
}
