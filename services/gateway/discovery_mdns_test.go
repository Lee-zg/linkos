package main

import (
	"encoding/binary"
	"testing"
)

func TestMDNSAnnouncementRoundTrip(t *testing.T) {
	beacon := discoveryBeacon{
		ID:      "workspace-1",
		Name:    "Engineering",
		Address: "https://linkos.local:9443",
		Version: "0.1.0",
		TLS:     true,
	}
	packet := buildMDNSAnnouncement("gateway."+linkOSMDNSService, "gateway.local", beacon)

	items := parseLinkOSMDNS(packet)
	if len(items) != 1 {
		t.Fatalf("expected one discovery record, got %+v", items)
	}
	got := items[0]
	if got.ID != beacon.ID || got.Name != beacon.Name || got.Address != beacon.Address || got.Version != beacon.Version || !got.TLS || got.Source != "mdns" {
		t.Fatalf("unexpected discovery record: %+v", got)
	}
}

func TestMDNSQueryMatchesLinkOSService(t *testing.T) {
	query := buildMDNSQuery()
	if !dnsQuestionMatches(query, linkOSMDNSService) {
		t.Fatal("LinkOS service query was not recognized")
	}
	if dnsQuestionMatches(query, "_http._tcp.local") {
		t.Fatal("unrelated service query was accepted")
	}
	if dnsQuestionMatches(query[:len(query)-1], linkOSMDNSService) {
		t.Fatal("truncated query was accepted")
	}
}

func TestMDNSParserRejectsUnrelatedTXTAndInvalidAddresses(t *testing.T) {
	instance := "gateway." + linkOSMDNSService
	valid := discoveryBeacon{ID: "workspace-1", Name: "Engineering", Address: "http://127.0.0.1:8787"}

	unrelated := buildMDNSAnnouncement(instance, "gateway.local", valid)
	ptrNameOffset := 12
	_, ptrHeaderOffset, ok := readDNSName(unrelated, ptrNameOffset)
	if !ok {
		t.Fatal("could not locate PTR record")
	}
	copy(unrelated[ptrNameOffset:ptrHeaderOffset], encodeDNSName("_other._tcp.local"))
	if items := parseLinkOSMDNS(unrelated); len(items) != 0 {
		t.Fatalf("unrelated TXT record was accepted: %+v", items)
	}

	for _, address := range []string{"javascript:alert(1)", "http:///missing-host", "https://user:pass@example.test"} {
		t.Run(address, func(t *testing.T) {
			invalid := valid
			invalid.Address = address
			packet := buildMDNSAnnouncement(instance, "gateway.local", invalid)
			if items := parseLinkOSMDNS(packet); len(items) != 0 {
				t.Fatalf("invalid address %q was accepted: %+v", address, items)
			}
		})
	}
}

func TestMDNSParserRejectsMalformedRecordLength(t *testing.T) {
	packet := buildMDNSAnnouncement("gateway."+linkOSMDNSService, "gateway.local", discoveryBeacon{ID: "workspace-1", Name: "Engineering", Address: "http://127.0.0.1:8787"})
	_, header, ok := readDNSName(packet, 12)
	if !ok {
		t.Fatal("could not locate PTR record")
	}
	binary.BigEndian.PutUint16(packet[header+8:header+10], uint16(len(packet)))
	if items := parseLinkOSMDNS(packet); len(items) != 0 {
		t.Fatalf("malformed packet was accepted: %+v", items)
	}
}
