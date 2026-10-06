package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"panestra.local/panestra/core/protocol"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

type ReadError struct{ State string }

func (e *ReadError) Error() string { return e.State }

// Only execute a native binary. Shell wrappers and remote executable configuration
// are deliberately excluded from the read-only account adapter.
func FindExecutable() (string, error) {
	if p := os.Getenv("PANESTRA_CODEX_EXECUTABLE"); p != "" {
		if filepath.IsAbs(p) && nativeFile(p) {
			return p, nil
		}
		return "", &ReadError{"not_found"}
	}
	name := "codex"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	if p, err := exec.LookPath(name); err == nil && nativeFile(p) {
		return p, nil
	}
	if runtime.GOOS == "windows" {
		matches, _ := filepath.Glob(filepath.Join(os.Getenv("LOCALAPPDATA"), "OpenAI", "Codex", "bin", "*", "codex.exe"))
		sort.Slice(matches, func(i, j int) bool {
			a, _ := os.Stat(matches[i])
			b, _ := os.Stat(matches[j])
			return a != nil && b != nil && a.ModTime().After(b.ModTime())
		})
		for _, p := range matches {
			if nativeFile(p) {
				return p, nil
			}
		}
		dirs := append(filepath.SplitList(os.Getenv("PATH")), filepath.Join(os.Getenv("APPDATA"), "npm"))
		target := "x86_64-pc-windows-msvc"
		pkg := "codex-win32-x64"
		if runtime.GOARCH == "arm64" {
			target = "aarch64-pc-windows-msvc"
			pkg = "codex-win32-arm64"
		}
		for _, dir := range dirs {
			for _, base := range []string{filepath.Join(dir, "node_modules", "@openai", "codex", "vendor"), filepath.Join(dir, "node_modules", "@openai", pkg, "vendor"), filepath.Join(dir, "node_modules", "@openai", "codex", "node_modules", "@openai", pkg, "vendor")} {
				p := filepath.Join(base, target, "codex", "codex.exe")
				if nativeFile(p) {
					return p, nil
				}
			}
		}
	}
	return "", &ReadError{"not_found"}
}
func nativeFile(p string) bool {
	if runtime.GOOS == "windows" && !strings.EqualFold(filepath.Ext(p), ".exe") {
		return false
	}
	info, err := os.Stat(p)
	return err == nil && info.Mode().IsRegular()
}

// App Server owns credential refresh. Never parse, copy, or return auth.json.
func Read(ctx context.Context) (Reading, error) {
	path, err := FindExecutable()
	if err != nil {
		return Reading{}, err
	}
	return readExecutable(ctx, path)
}
func readExecutable(ctx context.Context, path string) (Reading, error) {
	cmd := exec.CommandContext(ctx, path, "app-server")
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return Reading{}, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Reading{}, err
	}
	cmd.Stderr = io.Discard
	if err = cmd.Start(); err != nil {
		return Reading{}, &ReadError{"unavailable"}
	}
	release, err := attachLifecycle(cmd.Process.Pid)
	if err != nil {
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return Reading{}, &ReadError{"unavailable"}
	}
	defer release()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	defer func() {
		_ = stdin.Close()
		select {
		case <-done:
		case <-time.After(500 * time.Millisecond):
			_ = cmd.Process.Kill()
			<-done
		}
	}()
	encoder := json.NewEncoder(stdin)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), 512*1024)
	nextID := 0
	call := func(method string, params any) (json.RawMessage, error) {
		nextID++
		id := nextID
		if err := encoder.Encode(map[string]any{"id": id, "method": method, "params": params}); err != nil {
			return nil, &ReadError{"unavailable"}
		}
		for scanner.Scan() {
			var msg struct {
				ID     json.RawMessage `json:"id"`
				Method string          `json:"method"`
				Result json.RawMessage `json:"result"`
				Error  *struct {
					Code    int    `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if json.Unmarshal(scanner.Bytes(), &msg) != nil {
				return nil, &ReadError{"incompatible"}
			}
			if msg.Method != "" && len(msg.ID) > 0 {
				if err := encoder.Encode(map[string]any{"id": msg.ID, "error": map[string]any{"code": -32601, "message": "Read-only account adapter"}}); err != nil {
					return nil, &ReadError{"unavailable"}
				}
				continue
			}
			var responseID int
			if json.Unmarshal(msg.ID, &responseID) != nil || responseID != id {
				continue
			}
			if msg.Error != nil {
				state := "unavailable"
				message := strings.ToLower(msg.Error.Message)
				if msg.Error.Code == -32601 {
					state = "incompatible"
				} else if strings.Contains(message, "unauthorized") || strings.Contains(message, "not authenticated") || strings.Contains(message, "sign in") || strings.Contains(message, "401") {
					state = "needs_login"
				}
				return nil, &ReadError{state}
			}
			return msg.Result, nil
		}
		return nil, &ReadError{"unavailable"}
	}
	if _, err = call("initialize", map[string]any{"clientInfo": map[string]string{"name": "panestra", "title": "Panestra quota monitor", "version": protocol.CoreVersion}}); err != nil {
		return Reading{}, err
	}
	if err = encoder.Encode(map[string]any{"method": "initialized", "params": map[string]any{}}); err != nil {
		return Reading{}, err
	}
	data, err := call("account/read", map[string]bool{"refreshToken": false})
	if err != nil {
		return Reading{}, err
	}
	var account struct {
		Account *struct {
			Type     string `json:"type"`
			PlanType string `json:"planType"`
		} `json:"account"`
	}
	if json.Unmarshal(data, &account) != nil {
		return Reading{}, &ReadError{"incompatible"}
	}
	if account.Account == nil {
		return Reading{}, &ReadError{"needs_login"}
	}
	if account.Account.Type != "chatgpt" {
		return Reading{}, &ReadError{"unsupported_auth"}
	}
	data, err = call("account/rateLimits/read", map[string]any{})
	if err != nil {
		return Reading{}, err
	}
	reading, err := ParseLimits(data)
	if err != nil {
		return Reading{}, &ReadError{"incompatible"}
	}
	reading.PlanType = bounded(account.Account.PlanType, 40)
	return reading, nil
}
func stateFor(err error) string {
	var e *ReadError
	if errors.As(err, &e) {
		return e.State
	}
	return "unavailable"
}
