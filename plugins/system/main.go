package main

import (
	"encoding/json"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
	gnet "github.com/shirou/gopsutil/v4/net"
	"os"
	"panestra.local/panestra/core/backplane"
	"runtime"
	"time"
)

func main() {
	f := &backplane.Framer{R: os.Stdin, W: os.Stdout}
	if f.Write(backplane.Message{ID: "hello", Method: "hello", Params: backplane.Raw(map[string]any{"pluginId": "dev.panestra.system", "version": "0.1.0", "protocolVersion": 1, "manifestDigest": os.Getenv("PANESTRA_MANIFEST_DIGEST")})}) != nil {
		return
	}
	response, err := f.Read()
	if err != nil || response.Error != "" {
		return
	}
	var grants struct {
		Granted []string `json:"grantedCapabilities"`
	}
	if json.Unmarshal(response.Result, &grants) != nil {
		return
	}
	allowed := map[string]bool{}
	for _, g := range grants.Granted {
		allowed[g] = true
	}
	if !allowed["system.metrics.read"] {
		return
	}
	go func() {
		for {
			m, err := f.Read()
			if err != nil {
				os.Exit(0)
			}
			switch m.Method {
			case "health":
				if f.Write(backplane.Message{Method: "health"}) != nil {
					os.Exit(0)
				}
			case "action":
				var p struct {
					Action string `json:"action"`
				}
				json.Unmarshal(m.Params, &p)
				r := backplane.Message{ID: m.ID}
				if p.Action != "lock" || !allowed["system.session.lock"] {
					r.Error = "capability denied"
				} else if err := backplane.LockSession(); err != nil {
					r.Error = err.Error()
				} else {
					r.Result = backplane.Raw(map[string]bool{"ok": true})
				}
				if f.Write(r) != nil {
					os.Exit(0)
				}
			}
		}
	}()
	info, _ := host.Info()
	cpuInfo, _ := cpu.Info()
	model := "Processor"
	if len(cpuInfo) > 0 {
		model = cpuInfo[0].ModelName
	}
	var prevRx, prevTx uint64
	var prevTime time.Time
	publish := func(source string, value any) {
		if f.Write(backplane.Message{Method: "publish", Params: backplane.Raw(map[string]any{"source": source, "value": value})}) != nil {
			os.Exit(0)
		}
	}
	_, _ = cpu.Percent(0, false)
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for now := range ticker.C {
		if c, err := cpu.Percent(0, false); err == nil && len(c) > 0 {
			publish("cpu.usage", c[0])
		}
		if m, err := mem.VirtualMemory(); err == nil {
			publish("memory.usage", m.UsedPercent)
			if info != nil {
				publish("system.info", map[string]any{"hostname": info.Hostname, "os": info.Platform + " " + info.PlatformVersion, "cpu": model, "cores": runtime.NumCPU(), "memoryGB": float64(m.Total) / 1073741824, "uptime": info.Uptime + uint64(time.Since(time.Unix(int64(info.BootTime), 0)).Seconds()) - info.Uptime})
			}
		}
		root := string(os.PathSeparator)
		if runtime.GOOS == "windows" {
			root = os.Getenv("SystemDrive") + "\\"
			if root == "\\" {
				root = "C:\\"
			}
		}
		if d, err := disk.Usage(root); err == nil {
			publish("disk.usage", d.UsedPercent)
		}
		if stats, err := gnet.IOCounters(false); err == nil && len(stats) > 0 {
			v := stats[0]
			if !prevTime.IsZero() {
				elapsed := now.Sub(prevTime).Seconds()
				rx, tx := 0.0, 0.0
				if v.BytesRecv >= prevRx {
					rx = float64(v.BytesRecv-prevRx) / elapsed / 1024
				}
				if v.BytesSent >= prevTx {
					tx = float64(v.BytesSent-prevTx) / elapsed / 1024
				}
				publish("network.rx", rx)
				publish("network.tx", tx)
			}
			prevRx, prevTx, prevTime = v.BytesRecv, v.BytesSent, now
		}
	}
}
