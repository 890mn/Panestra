//go:build !windows

package codex

import "os/exec"

func hideWindow(cmd *exec.Cmd)                {}
func attachLifecycle(pid int) (func(), error) { return func() {}, nil }
