package backplane

import (
	"context"
	"encoding/json"
	"errors"
	"panestra.local/panestra/core/security"
	"time"
)

type Request struct {
	Operation string          `json:"operation"`
	Role      string          `json:"role"`
	Body      json.RawMessage `json:"body"`
}
type Response struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body"`
}

// Request invokes only an operation declared by this installed plugin.
func (r *Runtime) Request(ctx context.Context, request Request) (Response, error) {
	if next := r.next.Load(); next != nil {
		return next.Request(ctx, request)
	}
	declared := false
	for _, route := range r.Manifest.Routes {
		if route.Operation == request.Operation {
			declared = true
		}
	}
	if !declared {
		return Response{}, errors.New("plugin operation not declared")
	}
	r.mu.Lock()
	frame := r.frame
	if frame == nil || r.status != "running" {
		r.mu.Unlock()
		return Response{}, errors.New("plugin offline")
	}
	id := security.RandomToken()
	reply := make(chan Message, 1)
	r.pending[id] = reply
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.pending, id); r.mu.Unlock() }()
	if err := frame.Write(Message{ID: id, Method: "request", Params: Raw(request)}); err != nil {
		return Response{}, err
	}
	select {
	case <-ctx.Done():
		return Response{}, ctx.Err()
	case message := <-reply:
		if message.Error != "" {
			return Response{}, errors.New(message.Error)
		}
		var response Response
		if json.Unmarshal(message.Result, &response) != nil || response.Status < 200 || response.Status > 599 || !json.Valid(response.Body) {
			return Response{}, errors.New("invalid plugin response")
		}
		return response, nil
	}
}

func (r *Runtime) WaitReady(ctx context.Context) error {
	for {
		r.mu.Lock()
		ready := r.status == "running" && !r.healthReply.IsZero()
		r.mu.Unlock()
		if ready {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
}
