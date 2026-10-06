package server

import (
	"net"
	"sort"
)

// Only the authenticated local owner receives these address choices.
func pairingEndpoints(listen string) []string {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		return []string{}
	}
	if host != "" && host != "0.0.0.0" && host != "::" {
		return []string{"https://" + net.JoinHostPort(host, port)}
	}
	addresses := map[string]bool{}
	interfaces, _ := net.Interfaces()
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		entries, _ := iface.Addrs()
		for _, entry := range entries {
			ip, _, parseErr := net.ParseCIDR(entry.String())
			if parseErr == nil && ip.To4() != nil && ip.IsPrivate() && !ip.IsLoopback() {
				addresses[ip.String()] = true
			}
		}
	}
	// UDP connect selects the OS default route; it sends no packets.
	preferred := ""
	route, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: net.IPv4(198, 51, 100, 1), Port: 9})
	if err == nil {
		preferred = route.LocalAddr().(*net.UDPAddr).IP.String()
		route.Close()
	}
	hosts := make([]string, 0, len(addresses))
	for address := range addresses {
		hosts = append(hosts, address)
	}
	sort.Slice(hosts, func(i, j int) bool {
		if hosts[i] == hosts[j] {
			return false
		}
		if hosts[i] == preferred {
			return true
		}
		if hosts[j] == preferred {
			return false
		}
		return hosts[i] < hosts[j]
	})
	result := make([]string, 0, len(hosts))
	for _, address := range hosts {
		result = append(result, "https://"+net.JoinHostPort(address, port))
	}
	return result
}
