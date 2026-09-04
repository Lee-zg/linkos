package main

import (
	"context"
	"encoding/json"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

type discoveryBeacon struct {
	Protocol      string    `json:"protocol"`
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	Address       string    `json:"address"`
	Version       string    `json:"version"`
	TLS           bool      `json:"tls"`
	OnlineMembers int       `json:"onlineMembers"`
	At            time.Time `json:"at"`
	Source        string    `json:"source,omitempty"`
}

type discoveryService struct {
	mu    sync.RWMutex
	peers map[string]discoveryBeacon
	port  int
	stop  context.CancelFunc
}

func newDiscoveryService() *discoveryService {
	port := 8788
	if raw := strings.TrimSpace(os.Getenv("LINKOS_DISCOVERY_PORT")); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed < 65536 {
			port = parsed
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	d := &discoveryService{peers: make(map[string]discoveryBeacon), port: port, stop: cancel}
	go d.run(ctx)
	go d.runMDNS(ctx)
	return d
}

func (d *discoveryService) run(ctx context.Context) {
	addr := &net.UDPAddr{IP: net.IPv4zero, Port: d.port}
	conn, err := net.ListenUDP("udp4", addr)
	if err != nil {
		log.Printf("discovery UDP disabled on :%d: %v", d.port, err)
		return
	}
	defer conn.Close()
	_ = conn.SetReadBuffer(64 * 1024)
	beacon := localDiscoveryBeacon("udp")
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				beacon.At = time.Now().UTC()
				encoded, _ := json.Marshal(beacon)
				target := &net.UDPAddr{IP: net.IPv4bcast, Port: d.port}
				if _, err := conn.WriteToUDP(encoded, target); err != nil {
					return
				}
			}
		}
	}()
	buf := make([]byte, 64*1024)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		n, _, err := conn.ReadFromUDP(buf)
		if err != nil {
			select {
			case <-ctx.Done():
				return
			default:
				continue
			}
		}
		var candidate discoveryBeacon
		if json.Unmarshal(buf[:n], &candidate) != nil || candidate.Protocol != "linkos-discovery/1" || candidate.ID == "" {
			continue
		}
		if candidate.Address == beacon.Address {
			continue
		}
		candidate.Source = "udp"
		d.remember(candidate)
	}
}

func (d *discoveryService) remember(candidate discoveryBeacon) {
	if candidate.Address == "" || candidate.ID == "" {
		return
	}
	d.mu.Lock()
	d.peers[candidate.ID+"|"+candidate.Address] = candidate
	d.mu.Unlock()
}

func (d *discoveryService) list() []discoveryBeacon {
	d.mu.RLock()
	defer d.mu.RUnlock()
	items := make([]discoveryBeacon, 0, len(d.peers))
	cutoff := time.Now().UTC().Add(-15 * time.Second)
	for id, p := range d.peers {
		if p.At.Before(cutoff) {
			continue
		}
		items = append(items, p)
		_ = id
	}
	return items
}

func (d *discoveryService) close() {
	if d != nil && d.stop != nil {
		d.stop()
	}
}
