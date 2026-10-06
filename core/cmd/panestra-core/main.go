package main

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"panestra.local/panestra/core/backplane"
	"panestra.local/panestra/core/discovery"
	"panestra.local/panestra/core/release"
	"panestra.local/panestra/core/security"
	"panestra.local/panestra/core/server"
	"panestra.local/panestra/core/store"
	"panestra.local/panestra/core/web"
	"path/filepath"
	"strings"
	"time"
)

func main() {
	if err := run(); err != nil {
		slog.Error("Core stopped", "error", err)
		os.Exit(1)
	}
}
func run() error {
	data := flag.String("data", ".data", "private data directory")
	listen := flag.String("listen", "0.0.0.0:9443", "TLS listener")
	worker := flag.String("worker", "artifacts/system-plugin.exe", "trusted bundled System Plugin")
	manifest := flag.String("manifest", "plugins/system/manifest.json", "bundled manifest")
	origins := flag.String("origins", "", "explicit development origins, comma separated")
	backup := flag.String("backup", "", "write consistent backup then exit")
	restore := flag.String("restore", "", "restore validated backup offline; preserves host identity")
	headless := flag.Bool("headless", false, "serve embedded Universal Client without native shell")
	preflight := flag.Bool("preflight", false, "verify executable and SQLite compatibility without starting listener")
	parentStdio := flag.Bool("parent-stdio", false, "gracefully stop when native parent closes stdin")
	flag.Parse()
	_ = headless
	if *preflight {
		dir, err := os.MkdirTemp("", "panestra-preflight-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(dir)
		check, err := store.Open(filepath.Join(dir, "preflight.db"))
		if err != nil {
			return err
		}
		return check.DB.Close()
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	abs, err := filepath.Abs(*data)
	if err != nil {
		return err
	}
	os.MkdirAll(abs, 0700)
	s, err := store.Open(filepath.Join(abs, "panestra.db"))
	if err != nil {
		return err
	}
	defer s.DB.Close()
	if *backup != "" {
		return s.Backup(context.Background(), *backup)
	}
	if *restore != "" {
		pre := filepath.Join(abs, "backups", "pre-restore-"+time.Now().UTC().Format("20060102T150405")+".db")
		if err = s.Backup(context.Background(), pre); err != nil {
			return err
		}
		return s.Restore(context.Background(), *restore)
	}
	id, err := security.LoadIdentity(abs)
	if err != nil {
		return err
	}
	auth := security.NewAuth(s, id)
	if code := auth.BootstrapCode(); code != "" {
		fmt.Printf("本机首次认领码（10 分钟有效）: %s\n", code)
	}
	var applied release.Pointer
	if queryErr := s.DB.QueryRow("SELECT applied_seq,version_dir,version FROM plugin_release_state WHERE plugin_id='dev.panestra.system'").Scan(&applied.ReleaseSequence, &applied.Directory, &applied.Version); queryErr == nil {
		pub, readErr := os.ReadFile(filepath.Join(abs, "publisher.pub"))
		if readErr != nil {
			return fmt.Errorf("load installed plugin publisher: %w", readErr)
		}
		key, keyErr := hex.DecodeString(strings.TrimSpace(string(pub)))
		if keyErr != nil {
			return keyErr
		}
		manager := release.Manager{Root: filepath.Join(abs, "releases"), PublisherKey: ed25519.PublicKey(key)}
		if err = manager.ValidateDirectory(applied, []string{"system-plugin.exe", "plugins/system/manifest.json"}); err != nil {
			return fmt.Errorf("validate installed plugin: %w", err)
		}
		*worker = filepath.Join(applied.Directory, "system-plugin.exe")
		*manifest = filepath.Join(applied.Directory, "plugins/system/manifest.json")
	}
	manifestBytes, err := os.ReadFile(*manifest)
	if err != nil {
		return err
	}
	binary, err := filepath.Abs(*worker)
	if err != nil {
		return err
	}
	plugin, err := backplane.NewRuntime(s, binary, manifestBytes)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	if *parentStdio {
		go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	}
	defer plugin.Stop()
	srv := server.New(s, auth, plugin, abs, ctx)
	srv.ListenAddress = *listen
	for _, o := range strings.Split(*origins, ",") {
		if o != "" {
			srv.Origins[o] = true
		}
	}
	certificate, err := id.TLS()
	if err != nil {
		return err
	}
	httpServer := &http.Server{Addr: *listen, Handler: srv.Handler(web.Handler()), TLSConfig: &tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{certificate}}, ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	_, portString, err := net.SplitHostPort(*listen)
	if err != nil {
		return err
	}
	var port int
	fmt.Sscan(portString, &port)
	host, _ := os.Hostname()
	advertisement, err := discovery.Advertise(host, id.ServerID, port)
	if err != nil {
		slog.Warn("mDNS unavailable", "error", err)
	} else {
		defer advertisement.Shutdown()
	}
	if plugin.Granted("system.metrics.read") {
		if err = plugin.Start(ctx); err != nil {
			return err
		}
	}
	go func() {
		daily := time.NewTicker(24 * time.Hour)
		checkpoint := time.NewTicker(time.Minute)
		defer daily.Stop()
		defer checkpoint.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-checkpoint.C:
				s.Checkpoint(ctx)
			case <-daily.C:
				dir := filepath.Join(abs, "backups")
				path := filepath.Join(dir, "panestra-"+time.Now().UTC().Format("20060102T150405")+".db")
				if err := s.Backup(ctx, path); err != nil {
					slog.Error("scheduled backup failed", "error", err)
				} else {
					files, _ := filepath.Glob(filepath.Join(dir, "panestra-*.db"))
					if len(files) > 7 {
						for _, f := range files[:len(files)-7] {
							os.Remove(f)
						}
					}
				}
			}
		}
	}()
	errs := make(chan error, 1)
	go func() {
		slog.Info("Panestra Core ready", "endpoint", "https://localhost:"+portString, "serverId", id.ServerID, "fingerprint", id.Fingerprint(), "sqlite", s.Version)
		errs <- httpServer.ListenAndServeTLS("", "")
	}()
	select {
	case err = <-errs:
		if err != http.ErrServerClosed {
			return err
		}
	case <-ctx.Done():
	}
	srv.Hub.Close()
	shutdown, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	err = httpServer.Shutdown(shutdown)
	return err
}
