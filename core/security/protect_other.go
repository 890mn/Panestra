//go:build !windows

package security

import "errors"

// Refuse production identities on platforms without an OS-backed secret store.
func Protect(data []byte) ([]byte, error) {
	return nil, errors.New("OS secret storage currently requires Windows")
}
func Unprotect(data []byte) ([]byte, error) {
	return nil, errors.New("OS secret storage currently requires Windows")
}
