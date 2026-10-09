package security

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"panestra.local/panestra/core/protocol"
	"path/filepath"
	"time"
)

type Identity struct {
	ServerID   string `json:"serverId"`
	PrivateKey []byte `json:"privateKey"`
	Cert       []byte `json:"cert"`
}

func RandomToken() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}
func Hash(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }
func LoadIdentity(dir string) (*Identity, error) {
	path := filepath.Join(dir, "identity.protected")
	raw, err := os.ReadFile(path)
	if err == nil {
		raw, err = Unprotect(raw)
		if err != nil {
			return nil, err
		}
		var id Identity
		if err = json.Unmarshal(raw, &id); err != nil {
			return nil, err
		}
		return &id, nil
	}
	if !os.IsNotExist(err) {
		return nil, err
	}
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	pkcs8, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		return nil, err
	}
	id := &Identity{ServerID: RandomToken()[:22], PrivateKey: pkcs8}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return nil, err
	}
	host, _ := os.Hostname()
	tmpl := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Panestra " + id.ServerID}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().AddDate(5, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, DNSNames: []string{"localhost", host, host + ".local"}, IPAddresses: []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}}
	addresses, _ := net.InterfaceAddrs()
	for _, a := range addresses {
		ip, _, e := net.ParseCIDR(a.String())
		if e == nil && !ip.IsLoopback() {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		}
	}
	id.Cert, err = x509.CreateCertificate(rand.Reader, tmpl, tmpl, &priv.PublicKey, priv)
	if err != nil {
		return nil, err
	}
	raw, err = json.Marshal(id)
	if err != nil {
		return nil, err
	}
	raw, err = Protect(raw)
	if err != nil {
		return nil, fmt.Errorf("protect Core identity using Windows DPAPI: %w", err)
	}
	if err = os.WriteFile(path, raw, 0600); err != nil {
		return nil, err
	}
	return id, nil
}
func (i *Identity) Fingerprint() string {
	private, err := x509.ParsePKCS8PrivateKey(i.PrivateKey)
	if err != nil {
		return ""
	}
	signer, ok := private.(crypto.Signer)
	if !ok {
		return ""
	}
	key, err := x509.MarshalPKIXPublicKey(signer.Public())
	if err != nil {
		return ""
	}
	h := sha256.Sum256(key)
	return hex.EncodeToString(h[:])
}
func (i *Identity) TLS() (tls.Certificate, error) {
	return tls.X509KeyPair(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: i.Cert}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: i.PrivateKey}))
}
func (i *Identity) PublicProof(nonce string) (map[string]any, error) {
	if len(nonce) < 16 || len(nonce) > 128 {
		return nil, fmt.Errorf("invalid identity nonce")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(i.PrivateKey)
	if err != nil {
		return nil, err
	}
	key, ok := parsed.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("unsupported Core identity key")
	}
	pub, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return nil, err
	}
	message := "panestra:server:v1:" + nonce + ":" + i.ServerID
	hash := sha256.Sum256([]byte(message))
	r, s, err := ecdsa.Sign(rand.Reader, key, hash[:])
	if err != nil {
		return nil, err
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return map[string]any{"serverId": i.ServerID, "fingerprint": i.Fingerprint(), "apiVersion": 1, "coreVersion": protocol.CoreVersion, "capabilities": []string{"device-management", "pairing-close"}, "publicKey": base64.StdEncoding.EncodeToString(pub), "proof": message, "signature": base64.StdEncoding.EncodeToString(sig), "pairingRequired": true}, nil
}
