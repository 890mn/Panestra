package plugins

import (
	"crypto/ed25519"
	_ "embed"
	"encoding/hex"
	"strings"
)

//go:embed publisher.pub
var pinnedPublisher string

func PublisherKey() ed25519.PublicKey {
	key, _ := hex.DecodeString(strings.TrimSpace(pinnedPublisher))
	return ed25519.PublicKey(key)
}
