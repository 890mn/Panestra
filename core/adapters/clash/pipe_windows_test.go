//go:build windows

package clash

import (
	"context"
	"crypto/sha256"
	"fmt"
	winio "github.com/Microsoft/go-winio"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestWindowsNamedPipeController(t *testing.T) {
	suffix := fmt.Sprintf("%x", sha256.Sum256([]byte(fmt.Sprint(time.Now().UnixNano()))))
	name := "verge-mihomo-production-" + suffix
	listener, err := winio.ListenPipe(`\\.\pipe\`+name, nil)
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer fixture-secret" {
			w.WriteHeader(401)
			return
		}
		switch r.URL.Path {
		case "/configs":
			fmt.Fprint(w, `{"mode":"rule"}`)
		case "/proxies":
			fmt.Fprint(w, `{"proxies":{"main":{"type":"Selector","now":"DIRECT","all":["DIRECT"]}}}`)
		case "/version":
			fmt.Fprint(w, `{"version":"fixture"}`)
		case "/traffic":
			fmt.Fprintln(w, `{"up":1,"down":2}`)
		default:
			w.WriteHeader(404)
		}
	})}
	go server.Serve(listener)
	defer server.Close()
	if got := detectedPipe("pipe://verge-mihomo-sidecar-release-" + suffix); got != "pipe://"+name {
		t.Fatal("service pipe not resolved", got)
	}
	foreign := "pipe://verge-mihomo-sidecar-release-" + strings.Repeat("0", 64)
	if got := detectedPipe(foreign); got != foreign {
		t.Fatal("another owner's service selected", got)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	reading, err := Read(ctx, Config{Controller: "pipe://" + name, Secret: "fixture-secret"})
	if err != nil || reading.Mode != "rule" || len(reading.Groups) != 1 || reading.Download == nil || *reading.Download != 2 {
		t.Fatal("named pipe read failed", reading, err)
	}
}
