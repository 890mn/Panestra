package discovery

import (
	"context"
	"github.com/grandcat/zeroconf"
	"time"
)

const Service = "_panestra._tcp"

type Candidate struct {
	Provider     string        `json:"provider"`
	Host         string        `json:"host"`
	Port         int           `json:"port"`
	Scheme       string        `json:"scheme"`
	ServerIDHint string        `json:"serverIdHint"`
	Priority     int           `json:"priority"`
	TTL          time.Duration `json:"ttl"`
}
type Endpoint struct {
	URI           string        `json:"uri"`
	ServerID      string        `json:"serverId"`
	PublicKeyHash string        `json:"publicKeyHash"`
	Priority      int           `json:"priority"`
	LastSuccess   time.Time     `json:"lastSuccess"`
	LastRTT       time.Duration `json:"lastRTT"`
}
type DiscoveryProvider interface {
	Discover(context.Context) (<-chan Candidate, error)
}
type KnownHostProvider struct{ Hosts []Candidate }

func (p KnownHostProvider) Discover(ctx context.Context) (<-chan Candidate, error) {
	out := make(chan Candidate, len(p.Hosts))
	for _, h := range p.Hosts {
		h.Provider = "known-host"
		out <- h
	}
	close(out)
	return out, nil
}

type ManualEndpointProvider struct{ KnownHostProvider }
type MDNSProvider struct{}

func (MDNSProvider) Discover(ctx context.Context) (<-chan Candidate, error) {
	resolver, err := zeroconf.NewResolver(nil)
	if err != nil {
		return nil, err
	}
	entries := make(chan *zeroconf.ServiceEntry, 16)
	out := make(chan Candidate, 16)
	if err = resolver.Browse(ctx, Service, "local.", entries); err != nil {
		return nil, err
	}
	go func() {
		defer close(out)
		for {
			select {
			case <-ctx.Done():
				return
			case e, ok := <-entries:
				if !ok {
					return
				}
				for _, ip := range e.AddrIPv4 {
					select {
					case out <- Candidate{Provider: "mdns", Host: ip.String(), Port: e.Port, Scheme: "https", Priority: 10, TTL: time.Minute}:
					case <-ctx.Done():
						return
					}
				}
			}
		}
	}()
	return out, nil
}
func Advertise(name, id string, port int) (*zeroconf.Server, error) {
	return zeroconf.Register(name, Service, "local.", port, []string{"id=" + id, "api=1", "tls=1", "pairing=required"}, nil)
}
