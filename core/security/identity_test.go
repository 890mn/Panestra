package security

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"math/big"
	"testing"
)

func TestCoreProofBindsNonceIdentityAndPinnedKey(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	raw, _ := x509.MarshalPKCS8PrivateKey(key)
	id := &Identity{ServerID: "intended-core", PrivateKey: raw}
	proof, err := id.PublicProof("fresh-client-nonce-1234")
	if err != nil {
		t.Fatal(err)
	}
	if proof["fingerprint"] != id.Fingerprint() || proof["proof"] != "panestra:server:v1:fresh-client-nonce-1234:intended-core" {
		t.Fatal("proof not bound to intended Core")
	}
	signature, _ := base64.StdEncoding.DecodeString(proof["signature"].(string))
	public, _ := base64.StdEncoding.DecodeString(proof["publicKey"].(string))
	parsed, err := x509.ParsePKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256([]byte(proof["proof"].(string)))
	r, s := new(big.Int).SetBytes(signature[:32]), new(big.Int).SetBytes(signature[32:])
	if !ecdsa.Verify(parsed.(*ecdsa.PublicKey), hash[:], r, s) {
		t.Fatal("valid proof rejected")
	}
	changed := sha256.Sum256([]byte("panestra:server:v1:replayed-nonce:intended-core"))
	if ecdsa.Verify(parsed.(*ecdsa.PublicKey), changed[:], r, s) {
		t.Fatal("replayed proof accepted for different nonce")
	}
	if _, err = id.PublicProof("short"); err == nil {
		t.Fatal("unbounded nonce accepted")
	}
}
