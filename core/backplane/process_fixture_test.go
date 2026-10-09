package backplane

import (
	"archive/zip"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// Runtime checks exercise the independently built worker from its signed package.
// No plugin source tree or stale pre-split executable is needed by host tests.
func systemProcessFixture(t *testing.T) (string, []byte) {
	t.Helper()
	archive, err := zip.OpenReader("../../artifacts/build/plugin-seed/system.zip")
	if err != nil {
		t.Fatal("prepare independent plugin packages before runtime tests:", err)
	}
	defer archive.Close()
	var manifest, binary []byte
	for _, file := range archive.File {
		if file.Name != "manifest.json" && file.Name != "system-plugin.exe" {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		raw, err := io.ReadAll(io.LimitReader(reader, 64*1024*1024))
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		if file.Name == "manifest.json" {
			manifest = raw
		} else {
			binary = raw
		}
	}
	parsed, err := ParseManifest(manifest)
	if err != nil || parsed.ID != "dev.panestra.system" || len(binary) == 0 {
		t.Fatal("invalid independent System fixture", err)
	}
	target := filepath.Join(t.TempDir(), parsed.Engine.Entry)
	if err := os.WriteFile(target, binary, 0700); err != nil {
		t.Fatal(err)
	}
	return target, manifest
}
