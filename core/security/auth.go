package security

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"errors"
	"math/big"
	"panestra.local/panestra/core/protocol"
	"panestra.local/panestra/core/store"
	"sync"
	"time"
)

type Challenge struct {
	ID        string    `json:"id"`
	Message   string    `json:"message"`
	DeviceID  string    `json:"-"`
	PublicKey string    `json:"-"`
	Expires   time.Time `json:"-"`
	Purpose   string    `json:"-"`
}
type Pending struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	PublicKey string    `json:"publicKey"`
	KeyHash   string    `json:"keyHash"`
	Status    string    `json:"status"`
	Created   time.Time `json:"createdAt"`
	DeviceID  string    `json:"deviceId"`
	Token     string    `json:"-"`
}
type Window struct {
	Code        string    `json:"code"`
	Expires     time.Time `json:"expiresAt"`
	Remote      bool      `json:"remote"`
	Fingerprint string    `json:"fingerprint"`
}
type Auth struct {
	Store           *store.Store
	Identity        *Identity
	Mu              sync.Mutex
	challenges      map[string]Challenge
	pending         map[string]*Pending
	window          Window
	bootstrap       string
	bootstrapExpiry time.Time
}

func NewAuth(s *store.Store, id *Identity) *Auth {
	a := &Auth{Store: s, Identity: id, challenges: map[string]Challenge{}, pending: map[string]*Pending{}}
	var n int
	s.DB.QueryRow("SELECT count(*) FROM devices WHERE role='owner' AND revoked_at IS NULL").Scan(&n)
	if n == 0 {
		a.bootstrap = RandomToken()
		a.bootstrapExpiry = time.Now().Add(10 * time.Minute)
	}
	return a
}
func (a *Auth) BootstrapCode() string { a.Mu.Lock(); defer a.Mu.Unlock(); return a.bootstrap }
func ValidKey(raw string) bool {
	b, e := base64.StdEncoding.DecodeString(raw)
	if e != nil {
		return false
	}
	k, e := x509.ParsePKIXPublicKey(b)
	if e != nil {
		return false
	}
	pub, ok := k.(*ecdsa.PublicKey)
	return ok && pub.Curve == elliptic.P256()
}
func Verify(key, message, signature string) bool {
	b, e := base64.StdEncoding.DecodeString(key)
	if e != nil {
		return false
	}
	k, e := x509.ParsePKIXPublicKey(b)
	if e != nil {
		return false
	}
	pub, ok := k.(*ecdsa.PublicKey)
	if !ok || pub.Curve != elliptic.P256() {
		return false
	}
	sig, e := base64.StdEncoding.DecodeString(signature)
	if e != nil {
		return false
	}
	h := sha256.Sum256([]byte(message))
	if len(sig) == 64 {
		return ecdsa.Verify(pub, h[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:]))
	}
	return ecdsa.VerifyASN1(pub, h[:], sig)
}
func (a *Auth) Challenge(deviceID, key, purpose string) (Challenge, error) {
	a.Mu.Lock()
	defer a.Mu.Unlock()
	now := time.Now()
	for id, c := range a.challenges {
		if now.After(c.Expires) {
			delete(a.challenges, id)
		}
	}
	if len(a.challenges) > 1024 {
		return Challenge{}, errors.New("too many challenges")
	}
	if purpose == "login" {
		d, err := a.Device(deviceID)
		if errors.Is(err, sql.ErrNoRows) {
			return Challenge{}, &protocol.Error{Code: "DEVICE_NOT_PAIRED", Message: "此设备尚未配对，请在电脑打开配对窗口并批准连接。"}
		}
		if err != nil {
			return Challenge{}, err
		}
		if d.RevokedAt != nil {
			return Challenge{}, &protocol.Error{Code: "DEVICE_REVOKED", Message: "此设备的授权已被撤销，请在电脑打开配对窗口并重新批准连接。"}
		}
		key = d.PublicKey
	} else if !ValidKey(key) {
		return Challenge{}, errors.New("P-256 SPKI public key required")
	}
	c := Challenge{ID: RandomToken(), Message: "panestra:v1:" + a.Identity.ServerID + ":" + purpose + ":" + deviceID + ":" + RandomToken(), DeviceID: deviceID, PublicKey: key, Expires: now.Add(time.Minute), Purpose: purpose}
	a.challenges[c.ID] = c
	return c, nil
}
func (a *Auth) consumeLocked(id, signature, purpose string) (Challenge, error) {
	c, ok := a.challenges[id]
	delete(a.challenges, id)
	if !ok || c.Purpose != purpose || time.Now().After(c.Expires) || !Verify(c.PublicKey, c.Message, signature) {
		return Challenge{}, errors.New("invalid or expired challenge")
	}
	return c, nil
}
func (a *Auth) Bootstrap(code, name, challengeID, sig string) (string, protocol.Device, error) {
	a.Mu.Lock()
	defer a.Mu.Unlock()
	if a.bootstrap == "" || time.Now().After(a.bootstrapExpiry) || subtle.ConstantTimeCompare([]byte(code), []byte(a.bootstrap)) != 1 {
		return "", protocol.Device{}, errors.New("invalid bootstrap code")
	}
	c, err := a.consumeLocked(challengeID, sig, "bootstrap")
	if err != nil {
		return "", protocol.Device{}, err
	}
	d, err := a.addDevice(c.DeviceID, name, c.PublicKey, "owner")
	if err != nil {
		return "", d, err
	}
	a.bootstrap = ""
	t, err := a.session(d.ID)
	return t, d, err
}
func (a *Auth) OpenWindow(remote bool) Window {
	a.Mu.Lock()
	defer a.Mu.Unlock()
	a.window = Window{Code: RandomToken()[:12], Expires: time.Now().Add(2 * time.Minute), Remote: remote, Fingerprint: a.Identity.Fingerprint()}
	return a.window
}
func (a *Auth) Pair(code, name, challengeID, sig string, local bool) (Pending, error) {
	a.Mu.Lock()
	defer a.Mu.Unlock()
	if a.window.Code == "" || time.Now().After(a.window.Expires) || !local && !a.window.Remote || subtle.ConstantTimeCompare([]byte(code), []byte(a.window.Code)) != 1 {
		return Pending{}, errors.New("pairing closed, expired or remote pairing disabled")
	}
	c, err := a.consumeLocked(challengeID, sig, "pair")
	if err != nil {
		return Pending{}, err
	}
	d, lookupErr := a.Device(c.DeviceID)
	if lookupErr != nil && !errors.Is(lookupErr, sql.ErrNoRows) {
		return Pending{}, lookupErr
	}
	if lookupErr == nil && (d.RevokedAt == nil || d.PublicKey != c.PublicKey) {
		return Pending{}, errors.New("设备已注册，请使用原设备密钥重新连接；撤销后须由电脑重新批准配对")
	}
	for id, p := range a.pending {
		if time.Since(p.Created) > 5*time.Minute {
			delete(a.pending, id)
		}
	}
	if len(a.pending) >= 16 {
		return Pending{}, errors.New("pairing queue full")
	}
	p := &Pending{ID: RandomToken(), Name: name, PublicKey: c.PublicKey, KeyHash: Hash(c.PublicKey), Status: "pending", Created: time.Now(), DeviceID: c.DeviceID}
	a.pending[p.ID] = p
	return *p, nil
}
func (a *Auth) Pending() []Pending {
	a.Mu.Lock()
	defer a.Mu.Unlock()
	r := []Pending{}
	for _, p := range a.pending {
		if p.Status == "pending" && time.Since(p.Created) < 5*time.Minute {
			r = append(r, *p)
		}
	}
	return r
}
func (a *Auth) Approve(id, role string, approve bool) error {
	a.Mu.Lock()
	defer a.Mu.Unlock()
	p, ok := a.pending[id]
	if !ok || p.Status != "pending" || time.Since(p.Created) > 5*time.Minute {
		return errors.New("pairing request unavailable")
	}
	if !approve {
		p.Status = "denied"
		return nil
	}
	if role != "operator" && role != "viewer" && role != "owner" {
		return errors.New("invalid role")
	}
	d, err := a.addDevice(p.DeviceID, p.Name, p.PublicKey, role)
	if err != nil {
		return err
	}
	p.Token, err = a.session(d.ID)
	if err != nil {
		return err
	}
	p.Status = "approved"
	a.window = Window{}
	return nil
}
func (a *Auth) Poll(id string) (Pending, error) {
	a.Mu.Lock()
	defer a.Mu.Unlock()
	p, ok := a.pending[id]
	if !ok || time.Since(p.Created) > 5*time.Minute {
		return Pending{}, errors.New("request expired")
	}
	r := *p
	if p.Status != "pending" {
		delete(a.pending, id)
	}
	return r, nil
}
func (a *Auth) Login(id, sig string) (string, protocol.Device, error) {
	a.Mu.Lock()
	defer a.Mu.Unlock()
	c, err := a.consumeLocked(id, sig, "login")
	if err != nil {
		return "", protocol.Device{}, err
	}
	d, err := a.Device(c.DeviceID)
	if err != nil {
		return "", d, err
	}
	if d.RevokedAt != nil {
		return "", d, &protocol.Error{Code: "DEVICE_REVOKED", Message: "此设备的授权已被撤销，请在电脑打开配对窗口并重新批准连接。"}
	}
	t, err := a.session(d.ID)
	return t, d, err
}
func (a *Auth) addDevice(id, name, key, role string) (protocol.Device, error) {
	if len(id) < 8 || len(id) > 128 || len(name) < 1 || len(name) > 128 {
		return protocol.Device{}, errors.New("invalid device details")
	}
	a.Store.Mu.Lock()
	defer a.Store.Mu.Unlock()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	tx, err := a.Store.DB.Begin()
	if err != nil {
		return protocol.Device{}, err
	}
	defer tx.Rollback()
	var priorKey string
	var revoked sql.NullString
	err = tx.QueryRow("SELECT public_key,revoked_at FROM devices WHERE id=?", id).Scan(&priorKey, &revoked)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return protocol.Device{}, err
	}
	if err == nil && (!revoked.Valid || priorKey != key) {
		return protocol.Device{}, errors.New("设备已注册，不能覆盖活动设备或更换其密钥")
	}
	// Reapproval cannot revive any bearer issued before the revocation.
	if _, err = tx.Exec("DELETE FROM sessions WHERE device_id=?", id); err != nil {
		return protocol.Device{}, err
	}
	_, err = tx.Exec(`INSERT INTO devices VALUES(?,?,?,?,?,?,NULL)
ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,last_seen_at=excluded.last_seen_at,revoked_at=NULL
WHERE devices.revoked_at IS NOT NULL AND devices.public_key=excluded.public_key`, id, name, key, role, now, now)
	if err != nil {
		return protocol.Device{}, err
	}
	if err = tx.Commit(); err != nil {
		return protocol.Device{}, err
	}
	return a.Device(id)
}
func (a *Auth) session(deviceID string) (string, error) {
	a.Store.Mu.Lock()
	defer a.Store.Mu.Unlock()
	token := RandomToken()
	tx, err := a.Store.DB.Begin()
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	_, err = tx.Exec("DELETE FROM sessions WHERE expires_at<?", time.Now().Unix())
	if err != nil {
		return "", err
	}
	_, err = tx.Exec("INSERT INTO sessions VALUES(?,?,?)", Hash(token), deviceID, time.Now().Add(15*time.Minute).Unix())
	if err != nil {
		return "", err
	}
	_, err = tx.Exec("UPDATE devices SET last_seen_at=? WHERE id=?", time.Now().UTC().Format(time.RFC3339Nano), deviceID)
	if err != nil {
		return "", err
	}
	return token, tx.Commit()
}
func (a *Auth) Device(id string) (protocol.Device, error) {
	var d protocol.Device
	err := a.Store.DB.QueryRow("SELECT id,name,public_key,role,created_at,last_seen_at,revoked_at FROM devices WHERE id=?", id).Scan(&d.ID, &d.Name, &d.PublicKey, &d.Role, &d.CreatedAt, &d.LastSeenAt, &d.RevokedAt)
	return d, err
}
func (a *Auth) Validate(token string) (protocol.Device, error) {
	var id string
	err := a.Store.DB.QueryRow("SELECT device_id FROM sessions WHERE hash=? AND expires_at>?", Hash(token), time.Now().Unix()).Scan(&id)
	if err != nil {
		return protocol.Device{}, errors.New("session expired")
	}
	d, err := a.Device(id)
	if err != nil || d.RevokedAt != nil {
		return d, errors.New("device revoked")
	}
	return d, nil
}
func (a *Auth) Revoke(id string) error {
	a.Store.Mu.Lock()
	defer a.Store.Mu.Unlock()
	tx, err := a.Store.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var role string
	var revoked sql.NullString
	if err = tx.QueryRow("SELECT role,revoked_at FROM devices WHERE id=?", id).Scan(&role, &revoked); err != nil {
		return err
	}
	if role == "owner" && !revoked.Valid {
		var n int
		tx.QueryRow("SELECT count(*) FROM devices WHERE role='owner' AND revoked_at IS NULL").Scan(&n)
		if n <= 1 {
			return errors.New("cannot revoke last owner")
		}
	}
	_, err = tx.Exec("UPDATE devices SET revoked_at=? WHERE id=?", time.Now().UTC().Format(time.RFC3339Nano), id)
	if err != nil {
		return err
	}
	_, err = tx.Exec("DELETE FROM sessions WHERE device_id=?", id)
	if err != nil {
		return err
	}
	return tx.Commit()
}
