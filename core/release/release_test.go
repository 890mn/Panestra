package release

import (
	"archive/zip"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestSignedStageRollbackAndPathTraversal(t *testing.T) {
	pub, key, _ := ed25519.GenerateKey(rand.Reader)
	root := t.TempDir()
	artifact := filepath.Join(root, "release.zip")
	create := func(extra string) {
		f, _ := os.Create(artifact)
		z := zip.NewWriter(f)
		for _, p := range []string{"panestra-core.exe", "system-plugin.exe", "plugins/system/manifest.json", extra} {
			if p == "" {
				continue
			}
			w, _ := z.Create(p)
			w.Write([]byte("test"))
		}
		z.Close()
		f.Close()
	}
	meta := func(seq uint64) ([]byte, []byte) {
		b, _ := os.ReadFile(artifact)
		h := sha256.Sum256(b)
		raw, _ := json.Marshal(Metadata{SchemaVersion: 1, Product: "Panestra", Version: "0.1.0", ReleaseSequence: seq, APIVersion: 1, SHA256: hex.EncodeToString(h[:]), Size: int64(len(b))})
		return raw, ed25519.Sign(key, raw)
	}
	create("")
	raw, sig := meta(1)
	manager := Manager{Root: filepath.Join(root, "install"), PublisherKey: pub}
	if _, err := manager.Stage(artifact, raw, make([]byte, 64)); err == nil {
		t.Fatal("unsigned artifact accepted")
	}
	next, err := manager.Stage(artifact, raw, sig)
	if err != nil {
		t.Fatal(err)
	}
	if err = manager.Activate(next, func(string) error { return errors.New("health failure") }); err == nil {
		t.Fatal("bad health activated")
	}
	p, _ := manager.Current()
	if p.ReleaseSequence != 0 {
		t.Fatal("bad version replaced current")
	}
	if err = manager.Activate(next, func(string) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if _, err = Verify(raw, sig, pub, artifact, 1); err == nil {
		t.Fatal("rollback accepted")
	}
	create("../escape.txt")
	raw, sig = meta(2)
	if _, err = manager.Stage(artifact, raw, sig); err == nil {
		t.Fatal("ZIP traversal accepted")
	}
}
