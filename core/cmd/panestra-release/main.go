package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"panestra.local/panestra/core/backplane"
	"panestra.local/panestra/core/release"
	"path/filepath"
	"time"
)

func main() {
	artifact := flag.String("artifact", "", "signed ZIP artifact")
	metadataPath := flag.String("metadata", "", "detached release metadata JSON")
	signaturePath := flag.String("signature", "", "base64 Ed25519 signature over exact metadata bytes")
	key := flag.String("publisher-key", "", "pinned Ed25519 publisher public key (hex)")
	root := flag.String("root", "", "local version staging root")
	activate := flag.Bool("activate", false, "activate verified release after preflight")
	flag.Parse()
	fail := func(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
	public, err := hex.DecodeString(*key)
	if err != nil || len(public) != ed25519.PublicKeySize {
		fail(fmt.Errorf("a trusted publisher public key is required"))
	}
	metadata, err := os.ReadFile(*metadataPath)
	if err != nil {
		fail(err)
	}
	sigText, err := os.ReadFile(*signaturePath)
	if err != nil {
		fail(err)
	}
	sig, err := base64.StdEncoding.DecodeString(string(sigText))
	if err != nil {
		fail(err)
	}
	manager := release.Manager{Root: *root, PublisherKey: ed25519.PublicKey(public)}
	next, err := manager.Stage(*artifact, metadata, sig)
	if err != nil {
		fail(err)
	}
	if *activate {
		err = manager.Activate(next, func(dir string) error {
			manifest, err := os.ReadFile(filepath.Join(dir, "plugins/system/manifest.json"))
			if err != nil {
				return err
			}
			if _, err = backplane.ParseManifest(manifest); err != nil {
				return err
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			return exec.CommandContext(ctx, filepath.Join(dir, "panestra-core.exe"), "--preflight").Run()
		})
		if err != nil {
			fail(err)
		}
	}
	raw, _ := json.Marshal(next)
	fmt.Println(string(raw))
}
