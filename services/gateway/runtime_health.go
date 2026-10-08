package main

import (
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

func runtimeHealthcheck(c runtimeConfig) error {
	_, port, e := net.SplitHostPort(c.Listen)
	if e != nil {
		return e
	}
	scheme := "http"
	client := &http.Client{Timeout: 3 * time.Second}
	if c.TLSMode == "direct" {
		scheme = "https"
		pool, e := x509.SystemCertPool()
		if e != nil {
			pool = x509.NewCertPool()
		}
		raw, e := os.ReadFile(filepath.Join(activeHome, "tls", "ca.crt"))
		if e == nil {
			pool.AppendCertsFromPEM(raw)
		}
		tr := http.DefaultTransport.(*http.Transport).Clone()
		tr.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
		client.Transport = tr
	}
	response, e := client.Get(scheme + "://localhost:" + port + "/api/v1/readyz")
	if e != nil {
		return e
	}
	defer response.Body.Close()
	if response.StatusCode != 200 {
		return fmt.Errorf("Gateway not ready: %d", response.StatusCode)
	}
	return nil
}
