//go:build windows

package netease

import (
	"bufio"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"golang.org/x/sys/windows"
	"io"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"unicode/utf16"
)

//go:embed media.ps1
var mediaScript string

type nativeMedia struct {
	mu      sync.Mutex
	parent  context.Context
	command *exec.Cmd
	input   io.WriteCloser
	output  <-chan []byte
	stop    context.CancelFunc
}

func NewMedia(ctx context.Context) Media {
	media := &nativeMedia{parent: ctx}
	go func() { <-ctx.Done(); media.Close() }()
	return media
}
func encodedScript(script string) string {
	units := utf16.Encode([]rune(script))
	raw := make([]byte, len(units)*2)
	for i, unit := range units {
		binary.LittleEndian.PutUint16(raw[i*2:], unit)
	}
	return base64.StdEncoding.EncodeToString(raw)
}
func (m *nativeMedia) startLocked() error {
	directory, err := windows.GetSystemDirectory()
	if err != nil {
		return err
	}
	command := exec.Command(filepath.Join(directory, "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedScript(mediaScript))
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	command.Stderr = io.Discard
	input, err := command.StdinPipe()
	if err != nil {
		return err
	}
	output, err := command.StdoutPipe()
	if err != nil {
		input.Close()
		return err
	}
	if err = command.Start(); err != nil {
		input.Close()
		output.Close()
		return err
	}
	channel := make(chan []byte, 1)
	workerContext, stop := context.WithCancel(m.parent)
	go func() {
		defer close(channel)
		scanner := bufio.NewScanner(output)
		scanner.Buffer(make([]byte, 4096), 64*1024)
		for scanner.Scan() {
			data := append([]byte(nil), scanner.Bytes()...)
			select {
			case channel <- data:
			case <-workerContext.Done():
				return
			}
		}
	}()
	m.command, m.input, m.output = command, input, channel
	m.stop = stop
	return nil
}
func (m *nativeMedia) stopLocked() {
	if m.command == nil {
		return
	}
	m.stop()
	m.input.Close()
	_ = m.command.Process.Kill()
	_ = m.command.Wait()
	m.command, m.input, m.output = nil, nil, nil
}
func (m *nativeMedia) Close() { m.mu.Lock(); defer m.mu.Unlock(); m.stopLocked() }
func (m *nativeMedia) Call(ctx context.Context, action Action) (Reading, error) {
	if !m.mu.TryLock() {
		return Reading{}, fail("busy", "媒体会话正在处理请求，请稍后重试")
	}
	defer m.mu.Unlock()
	if ctx.Err() != nil || m.parent.Err() != nil {
		return Reading{}, fail("unavailable", "媒体读取已取消")
	}
	if m.command == nil {
		if err := m.startLocked(); err != nil {
			return Reading{}, fail("unavailable", "无法启动 Windows 媒体接口")
		}
	}
	data, _ := json.Marshal(action)
	if _, err := m.input.Write(append(data, '\n')); err != nil {
		m.stopLocked()
		return Reading{}, fail("unavailable", "Windows 媒体接口已断开")
	}
	select {
	case data, ok := <-m.output:
		if !ok {
			m.stopLocked()
			return Reading{}, fail("unavailable", "Windows 媒体接口已退出")
		}
		var response struct {
			Reading
			Success bool `json:"success"`
		}
		if json.Unmarshal(data, &response) != nil || validReading(response.Reading) != nil {
			m.stopLocked()
			return Reading{}, fail("unavailable", "媒体状态响应无效")
		}
		if !response.Success {
			if response.State == "not_found" {
				return response.Reading, fail("not_found", "未找到网易云音乐媒体会话")
			}
			return response.Reading, fail("unavailable", "播放器未接受操作，请稍后重试")
		}
		return response.Reading, nil
	case <-ctx.Done():
		m.stopLocked()
		return Reading{}, fail("unavailable", "媒体读取超时或已取消")
	case <-m.parent.Done():
		m.stopLocked()
		return Reading{}, fail("unavailable", "媒体读取已取消")
	}
}
