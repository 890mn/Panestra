package security

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"panestra.local/panestra/core/protocol"
	"panestra.local/panestra/core/store"
	"path/filepath"
	"testing"
)

func keypair(t *testing.T) (*ecdsa.PrivateKey, string) {
	t.Helper()
	key, e := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if e != nil {
		t.Fatal(e)
	}
	der, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	return key, base64.StdEncoding.EncodeToString(der)
}
func signature(key *ecdsa.PrivateKey, message string) string {
	h := sha256.Sum256([]byte(message))
	sig, _ := ecdsa.SignASN1(rand.Reader, key, h[:])
	return base64.StdEncoding.EncodeToString(sig)
}
func testAuth(t *testing.T) *Auth {
	t.Helper()
	dir := t.TempDir()
	s, e := store.Open(filepath.Join(dir, "state.db"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.DB.Close() })
	id := &Identity{ServerID: "test-server"}
	return NewAuth(s, id)
}
func TestChallengeReplayAndRevocation(t *testing.T) {
	a := testAuth(t)
	key, pub := keypair(t)
	c, e := a.Challenge("owner-device", pub, "bootstrap")
	if e != nil {
		t.Fatal(e)
	}
	token, d, e := a.Bootstrap(a.BootstrapCode(), "Owner", c.ID, signature(key, c.Message))
	if e != nil {
		t.Fatal(e)
	}
	if _, e = a.Validate(token); e != nil {
		t.Fatal(e)
	}
	c, e = a.Challenge(d.ID, "", "login")
	if e != nil {
		t.Fatal(e)
	}
	if _, _, e = a.Login(c.ID, signature(key, c.Message)); e != nil {
		t.Fatal(e)
	}
	if _, _, e = a.Login(c.ID, signature(key, c.Message)); e == nil {
		t.Fatal("challenge replay accepted")
	}
	if e = a.Revoke(d.ID); e == nil {
		t.Fatal("revoked last owner")
	}
	a.Store.DB.Exec("INSERT INTO devices VALUES('phone-device','Phone',?,'operator','now','now',NULL)", pub)
	phoneToken, _ := a.session("phone-device")
	if e = a.Revoke("phone-device"); e != nil {
		t.Fatal(e)
	}
	if _, e = a.Validate(phoneToken); e == nil {
		t.Fatal("revoked device session accepted")
	}
	if _, e = a.Challenge("phone-device", "", "login"); e == nil {
		t.Fatal("revoked device challenge accepted")
	}
}
func TestPairingClosedRemoteAndExplicitApproval(t *testing.T) {
	a := testAuth(t)
	key, pub := keypair(t)
	c, _ := a.Challenge("phone-device", pub, "pair")
	if _, e := a.Pair("any", "Phone", c.ID, signature(key, c.Message), true); e == nil {
		t.Fatal("pairing open by default")
	}
	a.Identity.PrivateKey, _ = x509.MarshalPKCS8PrivateKey(key)
	w := a.OpenWindow(false)
	c, _ = a.Challenge("phone-device", pub, "pair")
	if _, e := a.Pair(w.Code, "Phone", c.ID, signature(key, c.Message), false); e == nil {
		t.Fatal("remote pairing enabled by default")
	}
	p, e := a.Pair(w.Code, "Phone", c.ID, signature(key, c.Message), true)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = a.Device("phone-device"); e == nil {
		t.Fatal("paired before explicit approval")
	}
	if e = a.Approve(p.ID, "operator", true); e != nil {
		t.Fatal(e)
	}
	status, e := a.Poll(p.ID)
	if e != nil || status.Status != "approved" || status.Token == "" {
		t.Fatalf("approval failed: %+v %v", status, e)
	}
	if _, e = a.Validate(status.Token); e != nil {
		t.Fatal(e)
	}
	if _, e = a.Poll(p.ID); e == nil {
		t.Fatal("pairing token delivered twice")
	}
}
func TestVerifyRejectsChangedChallengeAndWrongKey(t *testing.T) {
	key, pub := keypair(t)
	sig := signature(key, "message")
	if !Verify(pub, "message", sig) {
		t.Fatal("valid signature denied")
	}
	if Verify(pub, "changed", sig) {
		t.Fatal("changed challenge accepted")
	}
	_, other := keypair(t)
	if Verify(other, "message", sig) {
		t.Fatal("wrong key accepted")
	}
	if Verify(pub, "message", "not base64") {
		t.Fatal("malformed signature accepted")
	}
}

func TestRevokedDeviceRequiresFreshWindowSameKeyAndExplicitReapproval(t *testing.T) {
	a := testAuth(t)
	key, pub := keypair(t)
	a.Identity.PrivateKey, _ = x509.MarshalPKCS8PrivateKey(key)
	if _, err := a.addDevice("owner-device", "Owner", pub, "owner"); err != nil {
		t.Fatal(err)
	}
	if _, err := a.addDevice("phone-device", "Phone", pub, "operator"); err != nil {
		t.Fatal(err)
	}
	oldToken, err := a.session("phone-device")
	if err != nil {
		t.Fatal(err)
	}
	if err = a.Revoke("phone-device"); err != nil {
		t.Fatal(err)
	}
	_, err = a.Challenge("phone-device", "", "login")
	var authError *protocol.Error
	if !errors.As(err, &authError) || authError.Code != "DEVICE_REVOKED" {
		t.Fatalf("missing revoked-device error: %v", err)
	}
	_, err = a.Challenge("missing-device", "", "login")
	if !errors.As(err, &authError) || authError.Code != "DEVICE_NOT_PAIRED" {
		t.Fatalf("missing unpaired-device error: %v", err)
	}
	c, _ := a.Challenge("phone-device", pub, "pair")
	if _, err = a.Pair("closed", "Phone", c.ID, signature(key, c.Message), true); err == nil {
		t.Fatal("revoked device bypassed closed pairing window")
	}
	w := a.OpenWindow(false)
	otherKey, otherPub := keypair(t)
	c, _ = a.Challenge("phone-device", otherPub, "pair")
	if _, err = a.Pair(w.Code, "Impostor", c.ID, signature(otherKey, c.Message), true); err == nil {
		t.Fatal("different key reused a revoked device ID")
	}
	c, _ = a.Challenge("phone-device", pub, "pair")
	p, err := a.Pair(w.Code, "Phone again", c.ID, signature(key, c.Message), true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.Challenge("phone-device", "", "login"); err == nil {
		t.Fatal("pending request restored authorization before approval")
	}
	if _, err = a.Validate(oldToken); err == nil {
		t.Fatal("old token accepted before reapproval")
	}
	if err = a.Approve(p.ID, "viewer", true); err != nil {
		t.Fatal(err)
	}
	status, err := a.Poll(p.ID)
	if err != nil || status.Token == "" {
		t.Fatalf("reapproval did not issue a new session: %v", err)
	}
	d, err := a.Validate(status.Token)
	if err != nil || d.Role != "viewer" || d.RevokedAt != nil || d.PublicKey != pub {
		t.Fatalf("reapproval ignored chosen role/identity: %+v %v", d, err)
	}
	if _, err = a.Validate(oldToken); err == nil {
		t.Fatal("old bearer revived after reapproval")
	}
	w = a.OpenWindow(false)
	c, _ = a.Challenge("phone-device", pub, "pair")
	if _, err = a.Pair(w.Code, "Overwrite", c.ID, signature(key, c.Message), true); err == nil {
		t.Fatal("active device was overwritten")
	}
}
