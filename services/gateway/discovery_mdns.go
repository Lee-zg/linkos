package main

import (
	"context"
	"encoding/binary"
	"log"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const linkOSMDNSService = "_linkos._tcp.local"

func localDiscoveryBeacon(source string) discoveryBeacon {
	address := strings.TrimRight(strings.TrimSpace(os.Getenv("LINKOS_PUBLIC_URL")), "/")
	// The development browser entry terminates TLS and proxies HTTP/WebSocket
	// to a loopback-only Gateway. Advertise that reachable entry, not the target.
	if os.Getenv("LINKOS_ENV") == "development" {
		if public := strings.TrimRight(os.Getenv("LINKOS_DEV_PUBLIC_URL"), "/"); validDiscoveryAddress(public) {
			address = public
		}
	}
	tlsEnabled := strings.TrimSpace(os.Getenv("LINKOS_TLS_CERT_FILE")) != ""
	if !validDiscoveryAddress(address) {
		scheme := "http"
		if tlsEnabled {
			scheme = "https"
		}
		_, port, err := net.SplitHostPort(os.Getenv("LINKOS_LISTEN"))
		if err != nil {
			_, port, _ = net.SplitHostPort(defaultConfig(defaultHome()).Listen)
		}
		address = scheme + "://" + net.JoinHostPort(localIPv4(), port)
	}
	id := strings.TrimSpace(os.Getenv("LINKOS_WORKSPACE_ID"))
	if id == "" {
		id = "demo"
	}
	name := strings.TrimSpace(os.Getenv("LINKOS_WORKSPACE_NAME"))
	if name == "" {
		name = "Nimbus Lab"
	}
	return discoveryBeacon{Protocol: "linkos-discovery/1", ID: id, Name: name, Address: address, Version: buildVersion, TLS: tlsEnabled || strings.HasPrefix(address, "https://"), OnlineMembers: 0, At: time.Now().UTC(), Source: source}
}

func localIPv4() string {
	connections, err := net.Interfaces()
	if err == nil {
		for _, networkInterface := range connections {
			if networkInterface.Flags&net.FlagUp == 0 || networkInterface.Flags&net.FlagLoopback != 0 {
				continue
			}
			addresses, _ := networkInterface.Addrs()
			for _, address := range addresses {
				ip, _, err := net.ParseCIDR(address.String())
				if err == nil && ip.To4() != nil {
					return ip.String()
				}
			}
		}
	}
	return "127.0.0.1"
}

func (d *discoveryService) runMDNS(ctx context.Context) {
	group := &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}
	conn, err := net.ListenMulticastUDP("udp4", nil, group)
	if err != nil {
		log.Printf("discovery mDNS disabled: %v", err)
		return
	}
	defer conn.Close()
	_ = conn.SetReadBuffer(64 * 1024)
	beacon := localDiscoveryBeacon("mdns")
	host, _ := os.Hostname()
	instance := dnsLabel(host) + "-" + strconv.Itoa(os.Getpid()) + "." + linkOSMDNSService
	target := dnsLabel(host) + ".local"
	announce := buildMDNSAnnouncement(instance, target, beacon)
	query := buildMDNSQuery()
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		_, _ = conn.WriteToUDP(query, group)
		_, _ = conn.WriteToUDP(announce, group)
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				_, _ = conn.WriteToUDP(query, group)
				_, _ = conn.WriteToUDP(announce, group)
			}
		}
	}()
	buffer := make([]byte, 64*1024)
	for {
		_ = conn.SetReadDeadline(time.Now().Add(time.Second))
		n, _, readErr := conn.ReadFromUDP(buffer)
		if readErr != nil {
			select {
			case <-ctx.Done():
				return
			default:
				continue
			}
		}
		packet := append([]byte(nil), buffer[:n]...)
		if dnsQuestionMatches(packet, linkOSMDNSService) {
			_, _ = conn.WriteToUDP(announce, group)
		}
		for _, candidate := range parseLinkOSMDNS(packet) {
			if candidate.Address != beacon.Address {
				d.remember(candidate)
			}
		}
	}
}

func dnsLabel(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	var result strings.Builder
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '-' {
			result.WriteRune(character)
		}
	}
	if result.Len() == 0 {
		return "linkos"
	}
	return result.String()
}

func encodeDNSName(value string) []byte {
	var result []byte
	for _, label := range strings.Split(strings.TrimSuffix(value, "."), ".") {
		if len(label) == 0 || len(label) > 63 {
			continue
		}
		result = append(result, byte(len(label)))
		result = append(result, label...)
	}
	return append(result, 0)
}

func buildMDNSQuery() []byte {
	packet := make([]byte, 12)
	binary.BigEndian.PutUint16(packet[4:6], 1)
	packet = append(packet, encodeDNSName(linkOSMDNSService)...)
	packet = binary.BigEndian.AppendUint16(packet, 12)
	return binary.BigEndian.AppendUint16(packet, 1)
}

func buildMDNSAnnouncement(instance, target string, beacon discoveryBeacon) []byte {
	packet := make([]byte, 12)
	binary.BigEndian.PutUint16(packet[2:4], 0x8400)
	binary.BigEndian.PutUint16(packet[6:8], 4)
	packet = appendDNSRecord(packet, linkOSMDNSService, 12, encodeDNSName(instance))
	srv := make([]byte, 6)
	parsed, _ := url.Parse(beacon.Address)
	port := 8787
	if parsed != nil && parsed.Port() != "" {
		if value, err := strconv.Atoi(parsed.Port()); err == nil {
			port = value
		}
	}
	binary.BigEndian.PutUint16(srv[4:6], uint16(port))
	srv = append(srv, encodeDNSName(target)...)
	packet = appendDNSRecord(packet, instance, 33, srv)
	txt := []string{"id=" + beacon.ID, "name=" + beacon.Name, "address=" + beacon.Address, "version=" + beacon.Version, "tls=" + strconv.FormatBool(beacon.TLS)}
	var txtData []byte
	for _, value := range txt {
		if len(value) <= 255 {
			txtData = append(txtData, byte(len(value)))
			txtData = append(txtData, value...)
		}
	}
	packet = appendDNSRecord(packet, instance, 16, txtData)
	ip := net.ParseIP(localIPv4()).To4()
	if ip == nil {
		ip = net.IPv4(127, 0, 0, 1)
	}
	return appendDNSRecord(packet, target, 1, []byte(ip))
}

func appendDNSRecord(packet []byte, name string, recordType uint16, data []byte) []byte {
	packet = append(packet, encodeDNSName(name)...)
	packet = binary.BigEndian.AppendUint16(packet, recordType)
	packet = binary.BigEndian.AppendUint16(packet, 0x8001)
	packet = binary.BigEndian.AppendUint32(packet, 120)
	packet = binary.BigEndian.AppendUint16(packet, uint16(len(data)))
	return append(packet, data...)
}

func readDNSName(packet []byte, offset int) (string, int, bool) {
	labels := []string{}
	next := offset
	jumped := false
	for steps := 0; steps < 64 && offset < len(packet); steps++ {
		length := int(packet[offset])
		if length == 0 {
			if !jumped {
				next = offset + 1
			}
			return strings.Join(labels, "."), next, true
		}
		if length&0xc0 == 0xc0 {
			if offset+1 >= len(packet) {
				return "", next, false
			}
			pointer := int(binary.BigEndian.Uint16(packet[offset:offset+2]) & 0x3fff)
			if !jumped {
				next = offset + 2
				jumped = true
			}
			offset = pointer
			continue
		}
		offset++
		if length > 63 || offset+length > len(packet) {
			return "", next, false
		}
		labels = append(labels, string(packet[offset:offset+length]))
		offset += length
		if !jumped {
			next = offset
		}
	}
	return "", next, false
}

func dnsQuestionMatches(packet []byte, expected string) bool {
	if len(packet) < 12 {
		return false
	}
	offset := 12
	for count := int(binary.BigEndian.Uint16(packet[4:6])); count > 0; count-- {
		name, next, ok := readDNSName(packet, offset)
		if !ok || next+4 > len(packet) {
			return false
		}
		if strings.EqualFold(name, expected) {
			return true
		}
		offset = next + 4
	}
	return false
}

type dnsRecord struct {
	name       string
	recordType uint16
	dataStart  int
	dataEnd    int
}

func validDiscoveryAddress(address string) bool {
	parsed, err := url.Parse(address)
	return err == nil && parsed.User == nil && parsed.Hostname() != "" &&
		(parsed.Scheme == "http" || parsed.Scheme == "https")
}

func parseLinkOSMDNS(packet []byte) []discoveryBeacon {
	if len(packet) < 12 {
		return nil
	}
	offset := 12
	questions := int(binary.BigEndian.Uint16(packet[4:6]))
	for count := 0; count < questions; count++ {
		_, next, ok := readDNSName(packet, offset)
		if !ok || next+4 > len(packet) {
			return nil
		}
		offset = next + 4
	}
	recordCount := int(binary.BigEndian.Uint16(packet[6:8])) + int(binary.BigEndian.Uint16(packet[8:10])) + int(binary.BigEndian.Uint16(packet[10:12]))
	records := make([]dnsRecord, 0, recordCount)
	for count := 0; count < recordCount; count++ {
		name, next, ok := readDNSName(packet, offset)
		if !ok || next+10 > len(packet) {
			return nil
		}
		recordType := binary.BigEndian.Uint16(packet[next : next+2])
		dataLength := int(binary.BigEndian.Uint16(packet[next+8 : next+10]))
		dataStart := next + 10
		if dataStart+dataLength > len(packet) {
			return nil
		}
		dataEnd := dataStart + dataLength
		records = append(records, dnsRecord{name: name, recordType: recordType, dataStart: dataStart, dataEnd: dataEnd})
		offset = dataEnd
	}

	instances := make(map[string]struct{})
	for _, record := range records {
		if record.recordType != 12 || !strings.EqualFold(record.name, linkOSMDNSService) {
			continue
		}
		instance, next, ok := readDNSName(packet, record.dataStart)
		if ok && next <= record.dataEnd && strings.HasSuffix(strings.ToLower(instance), "."+linkOSMDNSService) {
			instances[strings.ToLower(instance)] = struct{}{}
		}
	}

	var candidates []discoveryBeacon
	for _, record := range records {
		if record.recordType != 16 {
			continue
		}
		if _, ok := instances[strings.ToLower(record.name)]; !ok {
			continue
		}
		values := map[string]string{}
		validTXT := true
		for cursor := record.dataStart; cursor < record.dataEnd; {
			length := int(packet[cursor])
			cursor++
			if cursor+length > record.dataEnd {
				validTXT = false
				break
			}
			key, value, found := strings.Cut(string(packet[cursor:cursor+length]), "=")
			if found {
				values[key] = value
			}
			cursor += length
		}
		if validTXT && values["id"] != "" && values["name"] != "" && validDiscoveryAddress(values["address"]) {
			candidates = append(candidates, discoveryBeacon{Protocol: "linkos-discovery/1", ID: values["id"], Name: values["name"], Address: values["address"], Version: values["version"], TLS: values["tls"] == "true", At: time.Now().UTC(), Source: "mdns"})
		}
	}
	return candidates
}
