package backplane

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"panestra.local/panestra/core/security"
	"sync/atomic"
	"time"
)

// SwitchVerified replaces only a compatible first-party plugin after the caller verifies its signed package.
// Source IDs/types and UI/action contracts stay compatible with the running v1 Core.
func (r *Runtime) SwitchVerified(ctx context.Context, binary string, raw []byte, consent []string, verify func() error, persist ...func(*sql.Tx) error) error {
	r.switchMu.Lock()
	defer r.switchMu.Unlock()
	if next := r.next.Load(); next != nil {
		return next.SwitchVerified(ctx, binary, raw, consent, verify, persist...)
	}
	if verify == nil {
		return errors.New("signed package verification required")
	}
	if err := verify(); err != nil {
		return err
	}
	m, err := ParseManifest(raw)
	if err != nil {
		return err
	}
	if m.ID != r.Manifest.ID || m.ID != "dev.panestra.system" {
		return errors.New("only bundled System Plugin can be replaced")
	}
	if len(m.Sources) != len(r.Manifest.Sources) || len(m.Widgets) != len(r.Manifest.Widgets) || len(m.Actions) != len(r.Manifest.Actions) {
		return errors.New("plugin UI/source contract changed; update Core together")
	}
	for i, source := range m.Sources {
		old := r.Manifest.Sources[i]
		if source.ID != old.ID || source.Type != old.Type || source.Unit != old.Unit {
			return errors.New("source contract changed")
		}
	}
	for i, widget := range m.Widgets {
		if string(Raw(widget)) != string(Raw(r.Manifest.Widgets[i])) {
			return errors.New("widget contract changed")
		}
	}
	for i, action := range m.Actions {
		if action != r.Manifest.Actions[i] {
			return errors.New("action policy changed")
		}
	}
	r.mu.Lock()
	previous := map[string]bool{}
	for k, v := range r.grants {
		previous[k] = v
	}
	r.mu.Unlock()
	grants := map[string]bool{}
	explicit := map[string]bool{}
	for _, cap := range consent {
		if !KnownCapabilities[cap] {
			return fmt.Errorf("unsupported new permission: %s", cap)
		}
		explicit[cap] = true
	}
	for _, permission := range m.Permissions {
		value, existing := previous[permission.ID]
		if !existing {
			value = explicit[permission.ID]
		}
		grants[permission.ID] = value && KnownCapabilities[permission.ID]
		if permission.Required && !grants[permission.ID] {
			return fmt.Errorf("explicit consent required: %s", permission.ID)
		}
	}
	candidate := &Runtime{Store: r.Store, Manifest: m, Digest: security.Hash(string(raw)), Binary: binary, pending: map[string]chan Message{}, status: "stopped", grants: grants}
	var active atomic.Bool
	candidate.Publish = func(value Telemetry) {
		if active.Load() && r.Publish != nil {
			r.Publish(value)
		}
	}
	if err = candidate.Start(ctx); err != nil {
		return err
	}
	promoted := false
	defer func() {
		if !promoted {
			candidate.Stop()
		}
	}()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(8 * time.Second)
	defer deadline.Stop()
	for {
		candidate.mu.Lock()
		ready := candidate.status == "running" && !candidate.healthReply.IsZero() && candidate.restarts == 0
		crashed := candidate.restarts > 0
		candidate.mu.Unlock()
		if crashed {
			return errors.New("new plugin failed handshake or health; old worker retained")
		}
		if ready {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return errors.New("new plugin health timeout; old worker retained")
		case <-ticker.C:
		}
	}
	r.Store.Mu.Lock()
	tx, err := r.Store.DB.Begin()
	if err != nil {
		r.Store.Mu.Unlock()
		return err
	}
	_, err = tx.Exec("UPDATE plugins SET version=?,status='running',manifest_digest=?,data=? WHERE id=?", m.Version, candidate.Digest, string(raw), m.ID)
	if err == nil {
		_, err = tx.Exec("DELETE FROM plugin_permissions WHERE plugin_id=?", m.ID)
	}
	if err == nil {
		for _, p := range m.Permissions {
			_, err = tx.Exec("INSERT INTO plugin_permissions VALUES(?,?,?) ON CONFLICT(plugin_id,capability) DO UPDATE SET granted=excluded.granted", m.ID, p.ID, grants[p.ID])
			if err != nil {
				break
			}
		}
	}
	if err == nil {
		for _, write := range persist {
			if err = write(tx); err != nil {
				break
			}
		}
	}
	if err == nil {
		err = tx.Commit()
	} else {
		tx.Rollback()
	}
	r.Store.Mu.Unlock()
	if err != nil {
		return err
	}
	// Stop/drain old requests while the candidate is healthy. The stable Runtime handle keeps routing to the new process.
	r.stopCurrent()
	r.next.Store(candidate)
	active.Store(true)
	promoted = true
	return nil
}
