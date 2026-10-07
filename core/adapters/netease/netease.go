// Package netease controls only the identified NetEase Windows media session.
package netease

import (
	"context"
	"encoding/base64"
	"fmt"
	"math"
	"net/http"
	"strings"
)

const ID = "dev.panestra.netease"
const Topic = ID + "/media.status"

type Controls struct {
	Toggle   bool `json:"toggle"`
	Previous bool `json:"previous"`
	Next     bool `json:"next"`
	Seek     bool `json:"seek"`
}
type Reading struct {
	State           string   `json:"state"`
	Message         string   `json:"message"`
	Title           string   `json:"title"`
	Artist          string   `json:"artist"`
	Album           string   `json:"album"`
	ArtworkDataURL  string   `json:"artworkDataUrl,omitempty"`
	TrackID         string   `json:"trackId,omitempty"`
	TimelineSource  string   `json:"timelineSource,omitempty"`
	TimelineMessage string   `json:"timelineMessage,omitempty"`
	Playback        string   `json:"playback"`
	PositionSeconds *float64 `json:"positionSeconds"`
	DurationSeconds *float64 `json:"durationSeconds"`
	Controls        Controls `json:"controls"`
}
type Status struct {
	Enabled      bool   `json:"enabled"`
	AllowControl bool   `json:"allowControl"`
	TimelinePort int    `json:"timelinePort"`
	UpdatedAt    string `json:"updatedAt,omitempty"`
	Stale        bool   `json:"stale"`
	Refreshing   bool   `json:"refreshing"`
	Reading
}
type Config struct {
	Enabled      bool `json:"enabled"`
	AllowControl bool `json:"allowControl"`
	TimelinePort int  `json:"timelinePort"`
}
type Change struct {
	Enabled      *bool `json:"enabled"`
	AllowControl *bool `json:"allowControl"`
	TimelinePort *int  `json:"timelinePort"`
}
type Action struct {
	Action          string   `json:"action"`
	PositionSeconds *float64 `json:"positionSeconds,omitempty"`
	TrackID         string   `json:"trackId,omitempty"`
}
type Error struct{ State, Message string }

func (e *Error) Error() string         { return e.Message }
func fail(state, message string) error { return &Error{state, message} }

type Media interface {
	Call(context.Context, Action) (Reading, error)
	Close()
}

func validReading(reading Reading) error {
	if reading.State == "not_found" {
		return nil
	}
	if reading.State != "ready" {
		return fail("unavailable", "Windows 媒体接口暂不可用")
	}
	for _, value := range []string{reading.Title, reading.Artist, reading.Album, reading.TrackID} {
		if len(value) > 4096 || strings.ContainsRune(value, '\x00') {
			return fmt.Errorf("媒体信息无效")
		}
	}
	if reading.ArtworkDataURL != "" {
		if len(reading.ArtworkDataURL) > 132000 {
			return fmt.Errorf("媒体封面过大")
		}
		prefix, encoded, ok := strings.Cut(reading.ArtworkDataURL, ";base64,")
		if !ok || (prefix != "data:image/jpeg" && prefix != "data:image/png") {
			return fmt.Errorf("媒体封面格式无效")
		}
		image, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(image) == 0 || len(image) > 98304 || "data:"+http.DetectContentType(image) != prefix {
			return fmt.Errorf("媒体封面内容无效")
		}
	}
	switch reading.Playback {
	case "Playing", "Paused", "Stopped", "Closed", "Opened", "Changing":
	default:
		return fmt.Errorf("媒体播放状态无效")
	}
	for _, value := range []*float64{reading.PositionSeconds, reading.DurationSeconds} {
		if value != nil && (math.IsNaN(*value) || math.IsInf(*value, 0) || *value < 0 || *value > 7*24*3600) {
			return fmt.Errorf("播放时间无效")
		}
	}
	if reading.PositionSeconds != nil && reading.DurationSeconds != nil && *reading.PositionSeconds > *reading.DurationSeconds {
		return fmt.Errorf("播放进度超出时长")
	}
	return nil
}
func validAction(action Action) error {
	if len(action.TrackID) > 512 || strings.ContainsRune(action.TrackID, '\x00') {
		return fail("unavailable", "歌曲标识无效")
	}
	switch action.Action {
	case "toggle", "previous", "next":
		if action.PositionSeconds != nil {
			return fail("unavailable", "操作参数无效")
		}
	case "seek":
		if action.PositionSeconds == nil || math.IsNaN(*action.PositionSeconds) || math.IsInf(*action.PositionSeconds, 0) || *action.PositionSeconds < 0 || *action.PositionSeconds > 7*24*3600 {
			return fail("unavailable", "播放位置无效")
		}
	default:
		return fail("unavailable", "不支持的播放操作")
	}
	return nil
}

func validTimelinePort(port int) bool { return port == 0 || port >= 1024 && port <= 65535 }

type timelineConfigurer interface{ ConfigureTimeline(int) }
