package server

import (
	"context"
	"encoding/json"
	"github.com/coder/websocket"
	"net/http"
	"panestra.local/panestra/core/adapters/accounts"
	"panestra.local/panestra/core/adapters/alas"
	"panestra.local/panestra/core/adapters/clash"
	"panestra.local/panestra/core/adapters/codex"
	"panestra.local/panestra/core/adapters/netease"
	"panestra.local/panestra/core/backplane"
	"panestra.local/panestra/core/protocol"
	"sync"
	"time"
)

type peer struct {
	deviceID  string
	events    chan []byte
	telemetry chan []byte
	done      chan struct{}
	once      sync.Once
	topics    map[string]bool
	mu        sync.RWMutex
}

func (p *peer) close() { p.once.Do(func() { close(p.done) }) }

type Hub struct {
	mu      sync.Mutex
	peers   map[*peer]bool
	latest  map[string]backplane.Telemetry
	dropped uint64
}

func NewHub() *Hub { return &Hub{peers: map[*peer]bool{}, latest: map[string]backplane.Telemetry{}} }
func (h *Hub) Event(e protocol.Event) {
	b, _ := json.Marshal(e)
	h.mu.Lock()
	defer h.mu.Unlock()
	for p := range h.peers {
		select {
		case p.events <- b:
		default:
			p.close()
		}
	}
}
func (h *Hub) Telemetry(t backplane.Telemetry) {
	b, _ := json.Marshal(t)
	h.mu.Lock()
	defer h.mu.Unlock()
	h.latest[t.Topic] = t
	for p := range h.peers {
		p.mu.RLock()
		subscribed := p.topics[t.Topic]
		p.mu.RUnlock()
		if subscribed {
			select {
			case p.telemetry <- b:
			default:
				select {
				case <-p.telemetry:
				default:
				}
				select {
				case p.telemetry <- b:
				default:
				}
				h.dropped++
			}
		}
	}
}
func (h *Hub) Revoke(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for p := range h.peers {
		if p.deviceID == id {
			p.close()
		}
	}
}
func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for p := range h.peers {
		p.close()
	}
}
func (h *Hub) Stats() map[string]any {
	h.mu.Lock()
	defer h.mu.Unlock()
	depth := 0
	for p := range h.peers {
		depth += len(p.events) + len(p.telemetry)
	}
	return map[string]any{"connections": len(h.peers), "queueDepth": depth, "droppedTelemetry": h.dropped, "topics": len(h.latest)}
}
func (s *Server) websocket(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 * 1024)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	authCtx, authCancel := context.WithTimeout(ctx, 5*time.Second)
	_, b, err := conn.Read(authCtx)
	authCancel()
	if err != nil {
		return
	}
	var first struct {
		Type    string `json:"type"`
		Token   string `json:"token"`
		LastSeq int64  `json:"lastServerSeq"`
	}
	if json.Unmarshal(b, &first) != nil || first.Type != "auth" {
		conn.Close(websocket.StatusPolicyViolation, "authentication required")
		return
	}
	device, err := s.Auth.Validate(first.Token)
	if err != nil {
		conn.Close(websocket.StatusPolicyViolation, "invalid session")
		return
	}
	p := &peer{deviceID: device.ID, events: make(chan []byte, 256), telemetry: make(chan []byte, 64), done: make(chan struct{}), topics: map[string]bool{}}
	// Subscription and catch-up share the writer lock: no event can fall into a reconnect gap.
	s.Store.Mu.Lock()
	events, err := s.Store.EventsLocked(first.LastSeq)
	snapshot, snapErr := s.Store.SnapshotLocked()
	s.Hub.mu.Lock()
	s.Hub.peers[p] = true
	s.Hub.mu.Unlock()
	s.Store.Mu.Unlock()
	defer func() { s.Hub.mu.Lock(); delete(s.Hub.peers, p); s.Hub.mu.Unlock() }()
	if err != nil || snapErr != nil {
		return
	}
	write := func(v any) error {
		c, stop := context.WithTimeout(ctx, 5*time.Second)
		defer stop()
		data, _ := json.Marshal(v)
		return conn.Write(c, websocket.MessageText, data)
	}
	if first.LastSeq > 0 && first.LastSeq <= snapshot.ServerSeq && len(events) < 10000 {
		for _, e := range events {
			if err = write(e); err != nil {
				return
			}
		}
	}
	if err = write(snapshot); err != nil {
		return
	}
	go func() {
		defer p.close()
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var msg struct {
				Type   string   `json:"type"`
				Topics []string `json:"topics"`
			}
			if json.Unmarshal(data, &msg) != nil || msg.Type != "subscribe" || len(msg.Topics) > 200 {
				return
			}
			topics := map[string]bool{}
			for _, topic := range msg.Topics {
				if topic == codex.Topic || topic == clash.Topic || topic == netease.Topic || topic == alas.Topic {
					topics[topic] = true
				}
				for _, id := range accounts.IDs {
					if topic == accounts.Topic(id) {
						topics[topic] = true
					}
				}
				for _, source := range s.Plugin.Manifest.Sources {
					if topic == s.Plugin.Manifest.ID+"/"+source.ID {
						topics[topic] = true
					}
				}
			}
			p.mu.Lock()
			p.topics = topics
			p.mu.Unlock()
			s.Hub.mu.Lock()
			for topic := range topics {
				if t, ok := s.Hub.latest[topic]; ok {
					raw, _ := json.Marshal(t)
					select {
					case p.telemetry <- raw:
					default:
					}
				}
			}
			s.Hub.mu.Unlock()
		}
	}()
	check := time.NewTicker(2 * time.Second)
	defer check.Stop()
	ping := time.NewTicker(20 * time.Second)
	defer ping.Stop()
	for {
		var data []byte
		select {
		case <-ctx.Done():
			return
		case <-p.done:
			conn.Close(websocket.StatusPolicyViolation, "session ended; reconnect")
			return
		case <-check.C:
			if _, err = s.Auth.Validate(first.Token); err != nil {
				conn.Close(websocket.StatusPolicyViolation, "session expired or revoked")
				return
			}
			continue
		case <-ping.C:
			c, stop := context.WithTimeout(ctx, 5*time.Second)
			err = conn.Ping(c)
			stop()
			if err != nil {
				return
			}
			continue
		case data = <-p.events:
		case data = <-p.telemetry:
		}
		c, stop := context.WithTimeout(ctx, 5*time.Second)
		err = conn.Write(c, websocket.MessageText, data)
		stop()
		if err != nil {
			return
		}
	}
}
