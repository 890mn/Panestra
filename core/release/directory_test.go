package release

import (
	"archive/zip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestStagedFilesRemainBoundToPublisherSignature(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	root := t.TempDir()
	artifact := filepath.Join(root, "update.zip")
	f, _ := os.Create(artifact)
	z := zip.NewWriter(f)
	digests := map[string]string{}
	for _, name := range []string{"panestra-core.exe", "system-plugin.exe", "plugins/system/manifest.json"} {
		value := []byte("trusted " + name)
		w, _ := z.Create(name)
		w.Write(value)
		hash := sha256.Sum256(value)
		digests[name] = hex.EncodeToString(hash[:])
	}
	z.Close()
	f.Close()
	archive, _ := os.ReadFile(artifact)
	hash := sha256.Sum256(archive)
	raw, sigText, err := SignMetadata(Metadata{SchemaVersion: 1, Product: "Panestra", Version: "0.1.0", ReleaseSequence: 1, APIVersion: 1, SHA256: hex.EncodeToString(hash[:]), Size: int64(len(archive)), Files: digests}, key)
	if err != nil {
		t.Fatal(err)
	}
	_ = sigText
	manager := Manager{Root: filepath.Join(root, "releases"), PublisherKey: pub}
	pointer, err := manager.Stage(artifact, raw, ed25519.Sign(key, raw))
	if err != nil {
		t.Fatal(err)
	}
	required := []string{"system-plugin.exe", "plugins/system/manifest.json"}
	if err = manager.ValidateDirectory(pointer, required); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(pointer.Directory, "system-plugin.exe"), []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = manager.ValidateDirectory(pointer, required); err == nil {
		t.Fatal("tampered staged worker accepted")
	}
	pointer.Directory = root
	if err = manager.ValidateDirectory(pointer, required); err == nil {
		t.Fatal("external activation directory accepted")
	}
}
