// Test-only JSONL peer. This binary is never included in application packages.
package main

import (
	"bufio"
	"encoding/json"
	"os"
	"time"
)

func main() {
	if len(os.Args) != 2 || os.Args[1] != "app-server" {
		os.Exit(1)
	}
	scanner := bufio.NewScanner(os.Stdin)
	encoder := json.NewEncoder(os.Stdout)
	step := 0
	for scanner.Scan() {
		var msg struct {
			ID     any    `json:"id"`
			Method string `json:"method"`
		}
		_ = json.Unmarshal(scanner.Bytes(), &msg)
		expected := []string{"initialize", "initialized", "account/read", "account/rateLimits/read"}
		if step >= len(expected) || msg.Method != expected[step] {
			os.Exit(2)
		}
		step++
		if msg.ID == nil {
			continue
		}
		var result any = map[string]any{}
		switch msg.Method {
		case "account/read":
			result = map[string]any{"account": map[string]any{"type": "chatgpt", "planType": "plus"}}
		case "account/rateLimits/read":
			time.Sleep(200 * time.Millisecond)
			result = map[string]any{"rateLimitsByLimitId": map[string]any{"codex": map[string]any{"primary": map[string]any{"usedPercent": 37, "windowDurationMins": 300, "resetsAt": time.Now().Unix() + 3600}, "secondary": map[string]any{"usedPercent": nil, "windowDurationMins": 10080, "resetsAt": nil}}, "reserve": map[string]any{"limitName": "Model reserve", "primary": map[string]any{"usedPercent": 0, "windowDurationMins": 10080, "resetsAt": time.Now().Unix() + 86400}}}, "rateLimitResetCredits": map[string]any{"availableCount": 2}}
		}
		_ = encoder.Encode(map[string]any{"id": msg.ID, "result": result})
	}
}
