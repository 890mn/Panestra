//go:build windows

package clash

import (
	"context"
	winio "github.com/Microsoft/go-winio"
	"golang.org/x/sys/windows"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Verge keeps a sidecar address in YAML while its service runs an owner-scoped pipe.
// Only consider that same owner's documented service address, never arbitrary pipes.
func detectedPipe(address string) string {
	name := strings.TrimPrefix(address, "pipe://")
	suffix := strings.TrimPrefix(name, "verge-mihomo-sidecar-release-")
	if suffix == name || len(suffix) != 64 {
		return address
	}
	for _, value := range suffix {
		if !(value >= '0' && value <= '9' || value >= 'a' && value <= 'f') {
			return address
		}
	}
	candidate := "verge-mihomo-production-" + suffix
	path, err := windows.UTF16PtrFromString(`\\.\pipe\` + candidate)
	if err != nil {
		return address
	}
	var data windows.Win32finddata
	handle, err := windows.FindFirstFile(path, &data)
	if err != nil {
		return address
	}
	windows.FindClose(handle)
	return "pipe://" + candidate
}

var pipeClients = struct {
	sync.Mutex
	clients map[string]*http.Client
}{clients: map[string]*http.Client{}}

func namedPipeClient(name string) (*http.Client, error) {
	pipeClients.Lock()
	defer pipeClients.Unlock()
	if existing := pipeClients.clients[name]; existing != nil {
		return existing, nil
	}
	if len(pipeClients.clients) >= 16 {
		for key, c := range pipeClients.clients {
			c.CloseIdleConnections()
			delete(pipeClients.clients, key)
		}
	}
	transport := &http.Transport{Proxy: nil, MaxIdleConns: 4, MaxIdleConnsPerHost: 4, IdleConnTimeout: 30 * time.Second, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return winio.DialPipeContext(ctx, `\\.\pipe\`+name)
	}}
	c := &http.Client{Timeout: 5 * time.Second, Transport: transport, CheckRedirect: client.CheckRedirect}
	pipeClients.clients[name] = c
	return c, nil
}
