package codex

import (
	"encoding/json"
	"math"
	"sort"
)

const ID = "dev.panestra.codex"
const Topic = ID + "/account.usage"
const Permission = "codex.account.read"

type Window struct {
	ID               string   `json:"id"`
	UsedPercent      *float64 `json:"usedPercent"`
	RemainingPercent *float64 `json:"remainingPercent"`
	DurationMinutes  *int64   `json:"durationMinutes"`
	ResetsAt         *int64   `json:"resetsAt"`
}
type Bucket struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Windows []Window `json:"windows"`
}
type ResetCredits struct {
	AvailableCount *int64 `json:"availableCount"`
	ExpiresAt      *int64 `json:"expiresAt"`
}
type Status struct {
	Enabled             bool          `json:"enabled"`
	State               string        `json:"state"`
	Message             string        `json:"message"`
	PlanType            string        `json:"planType,omitempty"`
	UpdatedAt           string        `json:"updatedAt,omitempty"`
	Stale               bool          `json:"stale"`
	Refreshing          bool          `json:"refreshing"`
	Buckets             []Bucket      `json:"buckets"`
	ResetCredits        *ResetCredits `json:"resetCredits"`
	PollIntervalSeconds int           `json:"pollIntervalSeconds"`
}
type Reading struct {
	PlanType     string
	Buckets      []Bucket
	ResetCredits *ResetCredits
}
type rawWindow struct {
	UsedPercent        *float64 `json:"usedPercent"`
	WindowDurationMins *int64   `json:"windowDurationMins"`
	ResetsAt           *int64   `json:"resetsAt"`
}
type rawBucket struct {
	LimitID   string     `json:"limitId"`
	LimitName string     `json:"limitName"`
	Primary   *rawWindow `json:"primary"`
	Secondary *rawWindow `json:"secondary"`
}

func positive(v *int64) *int64 {
	if v == nil || *v <= 0 {
		return nil
	}
	return v
}
func ParseLimits(data []byte) (Reading, error) {
	var result struct {
		RateLimits   *rawBucket           `json:"rateLimits"`
		ByID         map[string]rawBucket `json:"rateLimitsByLimitId"`
		ResetCredits *struct {
			AvailableCount *int64 `json:"availableCount"`
			Credits        []struct {
				Status    string `json:"status"`
				ExpiresAt *int64 `json:"expiresAt"`
			} `json:"credits"`
		} `json:"rateLimitResetCredits"`
	}
	if err := json.Unmarshal(data, &result); err != nil {
		return Reading{}, err
	}
	reading := Reading{Buckets: []Bucket{}}
	buckets := result.ByID
	if buckets == nil && result.RateLimits != nil {
		id := result.RateLimits.LimitID
		if id == "" {
			id = "codex"
		}
		buckets = map[string]rawBucket{id: *result.RateLimits}
	}
	keys := make([]string, 0, len(buckets))
	for k := range buckets {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i] == keys[j] {
			return false
		}
		if keys[i] == "codex" {
			return true
		}
		if keys[j] == "codex" {
			return false
		}
		return keys[i] < keys[j]
	})
	for _, id := range keys {
		if len(reading.Buckets) == 32 {
			break
		}
		raw := buckets[id]
		b := Bucket{ID: bounded(id, 100), Name: bounded(raw.LimitName, 100), Windows: []Window{}}
		for _, entry := range []struct {
			id    string
			value *rawWindow
		}{{"primary", raw.Primary}, {"secondary", raw.Secondary}} {
			if entry.value == nil {
				continue
			}
			v := entry.value
			w := Window{ID: entry.id, DurationMinutes: positive(v.WindowDurationMins), ResetsAt: positive(v.ResetsAt)}
			if v.UsedPercent != nil && !math.IsNaN(*v.UsedPercent) && !math.IsInf(*v.UsedPercent, 0) {
				used := math.Max(0, math.Min(100, *v.UsedPercent))
				remaining := 100 - used
				w.UsedPercent = &used
				w.RemainingPercent = &remaining
			}
			b.Windows = append(b.Windows, w)
		}
		reading.Buckets = append(reading.Buckets, b)
	}
	if v := result.ResetCredits; v != nil {
		reading.ResetCredits = &ResetCredits{}
		if v.AvailableCount != nil && *v.AvailableCount >= 0 {
			reading.ResetCredits.AvailableCount = v.AvailableCount
		}
		for _, c := range v.Credits {
			if c.Status == "available" && positive(c.ExpiresAt) != nil && (reading.ResetCredits.ExpiresAt == nil || *c.ExpiresAt < *reading.ResetCredits.ExpiresAt) {
				reading.ResetCredits.ExpiresAt = c.ExpiresAt
			}
		}
	}
	return reading, nil
}
func bounded(s string, n int) string {
	r := []rune(s)
	if len(r) > n {
		r = r[:n]
	}
	return string(r)
}
