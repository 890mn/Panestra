//go:build !windows

package backplane

import "errors"

func AttachJob(pid int) (func(), error) { return func() {}, nil }
func LockSession() error                { return errors.New("session lock requires Windows") }
