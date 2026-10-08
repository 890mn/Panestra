package protocol

import "encoding/json"

const APIVersion = 1
const PluginProtocol = 1
const ManifestSchema = 1
const CoreVersion = "0.1.32"

type Entity struct {
	ID      string          `json:"id"`
	Kind    string          `json:"kind"`
	Rev     int64           `json:"rev"`
	Deleted bool            `json:"deleted,omitempty"`
	Data    json.RawMessage `json:"data"`
}
type Command struct {
	OpID     string          `json:"opId"`
	DeviceID string          `json:"deviceId"`
	EntityID string          `json:"entityId"`
	BaseRev  int64           `json:"baseRev"`
	Command  string          `json:"command"`
	Payload  json.RawMessage `json:"payload"`
}
type Event struct {
	Type      string   `json:"type"`
	ServerSeq int64    `json:"serverSeq"`
	CausedBy  string   `json:"causedBy"`
	DeviceID  string   `json:"deviceId"`
	Entity    Entity   `json:"entity"`
	Entities  []Entity `json:"entities,omitempty"`
}
type Snapshot struct {
	Type      string   `json:"type"`
	ServerSeq int64    `json:"serverSeq"`
	Entities  []Entity `json:"entities"`
}
type Device struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	PublicKey  string  `json:"publicKey,omitempty"`
	Role       string  `json:"role"`
	CreatedAt  string  `json:"createdAt"`
	LastSeenAt string  `json:"lastSeenAt"`
	RevokedAt  *string `json:"revokedAt"`
}
type Error struct {
	Code         string  `json:"code"`
	Message      string  `json:"message"`
	CurrentRev   int64   `json:"currentRev,omitempty"`
	CurrentState *Entity `json:"currentState,omitempty"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }
