// panestra-sign is an offline publisher tool; Core never receives the publisher private key.
package main

import (
	"archive/zip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"flag"
	"fmt"
	"io"
	"os"
	"panestra.local/panestra/core/release"
	"panestra.local/panestra/core/security"
	"path/filepath"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func writeNew(path string, value []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = file.Write(value)
	closeErr := file.Close()
	if err != nil {
		return err
	}
	return closeErr
}
func run() error {
	keyPath := flag.String("key", "", "DPAPI-protected publisher key file")
	generate := flag.Bool("generate-key", false, "generate a new user-bound development publisher identity")
	artifact := flag.String("artifact", "", "ZIP package to sign offline")
	version := flag.String("version", "0.1.0", "release version")
	sequence := flag.Uint64("sequence", 0, "strictly increasing release sequence")
	output := flag.String("output", "", "output prefix for exact .json, base64 .sig and .pub files")
	flag.Parse()
	if *keyPath == "" {
		return fmt.Errorf("--key is required")
	}
	var key ed25519.PrivateKey
	if *generate {
		pub, private, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		protected, err := security.Protect(private)
		if err != nil {
			return err
		}
		if err = writeNew(*keyPath, protected); err != nil {
			return err
		}
		if err = writeNew(*keyPath+".pub", []byte(hex.EncodeToString(pub))); err != nil {
			return err
		}
		key = private
	} else {
		protected, err := os.ReadFile(*keyPath)
		if err != nil {
			return err
		}
		raw, err := security.Unprotect(protected)
		if err != nil {
			return err
		}
		if len(raw) != ed25519.PrivateKeySize {
			return fmt.Errorf("invalid publisher key")
		}
		key = ed25519.PrivateKey(raw)
	}
	defer func() {
		for i := range key {
			key[i] = 0
		}
	}()
	if *artifact == "" {
		if *generate {
			fmt.Println("Development publisher key generated; private key protected by Windows DPAPI.")
			return nil
		}
		return fmt.Errorf("--artifact required")
	}
	if *output == "" || *sequence == 0 {
		return fmt.Errorf("--output and positive --sequence required")
	}
	file, err := os.Open(*artifact)
	if err != nil {
		return err
	}
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(file, release.MaxPackageSize+1))
	file.Close()
	if err != nil {
		return err
	}
	if n > release.MaxPackageSize {
		return fmt.Errorf("package too large")
	}
	archive, err := zip.OpenReader(*artifact)
	if err != nil {
		return err
	}
	defer archive.Close()
	digests := map[string]string{}
	var expanded uint64
	for _, entry := range archive.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		expanded += entry.UncompressedSize64
		if expanded > release.MaxPackageSize {
			return fmt.Errorf("expanded package too large")
		}
		in, err := entry.Open()
		if err != nil {
			return err
		}
		leaf := sha256.New()
		_, err = io.Copy(leaf, io.LimitReader(in, int64(entry.UncompressedSize64)+1))
		in.Close()
		if err != nil {
			return err
		}
		digests[entry.Name] = hex.EncodeToString(leaf.Sum(nil))
	}
	for _, name := range []string{"panestra-core.exe"} {
		if digests[name] == "" {
			return fmt.Errorf("required package file missing: %s", name)
		}
	}
	meta := release.Metadata{SchemaVersion: 1, Product: "Panestra", Version: *version, ReleaseSequence: *sequence, APIVersion: 1, SHA256: hex.EncodeToString(hash.Sum(nil)), Size: n, Files: digests}
	raw, sig, err := release.SignMetadata(meta, key)
	if err != nil {
		return err
	}
	public := key.Public().(ed25519.PublicKey)
	if _, err = release.Verify(raw, ed25519.Sign(key, raw), public, *artifact, 0); err != nil {
		return err
	}
	for _, suffix := range []string{".json", ".sig", ".pub"} {
		if _, err = os.Stat(*output + suffix); !os.IsNotExist(err) {
			return fmt.Errorf("output already exists: %s", *output+suffix)
		}
	}
	if err = writeNew(*output+".json", raw); err != nil {
		return err
	}
	if err = writeNew(*output+".sig", []byte(sig)); err != nil {
		return err
	}
	if err = writeNew(*output+".pub", []byte(hex.EncodeToString(public))); err != nil {
		return err
	}
	fmt.Println("Signed package metadata and per-file digests written. Keep the protected private key on the publisher machine.")
	return nil
}
