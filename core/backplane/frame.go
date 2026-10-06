package backplane

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"sync"
)

const MaxFrame = 256 * 1024

type Message struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      string          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   string          `json:"error,omitempty"`
}
type Framer struct {
	R  io.Reader
	W  io.Writer
	mu sync.Mutex
}

func (f *Framer) Read() (Message, error) {
	var m Message
	var h [4]byte
	if _, err := io.ReadFull(f.R, h[:]); err != nil {
		return m, err
	}
	size := binary.BigEndian.Uint32(h[:])
	if size == 0 || size > MaxFrame {
		return m, errors.New("IPC frame size exceeded")
	}
	b := make([]byte, size)
	if _, err := io.ReadFull(f.R, b); err != nil {
		return m, err
	}
	if err := json.Unmarshal(b, &m); err != nil {
		return m, err
	}
	if m.JSONRPC != "2.0" {
		return m, errors.New("invalid JSON-RPC version")
	}
	return m, nil
}
func (f *Framer) Write(m Message) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	m.JSONRPC = "2.0"
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}
	if len(b) > MaxFrame {
		return errors.New("IPC frame size exceeded")
	}
	h := make([]byte, 4)
	binary.BigEndian.PutUint32(h, uint32(len(b)))
	if _, err = f.W.Write(h); err != nil {
		return err
	}
	_, err = f.W.Write(b)
	return err
}
func Raw(v any) json.RawMessage { b, _ := json.Marshal(v); return b }
