package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

func createLANCertificates(home, host string) error {
	if host == "" {
		return fmt.Errorf("--host requires a stable LAN IP or DNS name")
	}
	dir := filepath.Join(home, "tls")
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial := func() *big.Int { n, _ := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128)); return n }
	now := time.Now()
	ca := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: "LinkOS local CA"}, NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(10, 0, 0), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &key.PublicKey, key)
	if err != nil {
		return err
	}
	// Renewal keeps the existing CA so clients do not need a new trust root.
	if raw, e := os.ReadFile(filepath.Join(dir, "ca.crt")); e == nil {
		block, _ := pem.Decode(raw)
		if block == nil {
			return fmt.Errorf("invalid CA certificate")
		}
		ca, err = x509.ParseCertificate(block.Bytes)
		if err != nil {
			return err
		}
		caDER = block.Bytes
		raw, err = os.ReadFile(filepath.Join(dir, "ca.key"))
		if err != nil {
			return err
		}
		block, _ = pem.Decode(raw)
		if block == nil {
			return fmt.Errorf("invalid CA key")
		}
		parsed, e := x509.ParsePKCS8PrivateKey(block.Bytes)
		if e != nil {
			return e
		}
		var ok bool
		key, ok = parsed.(*ecdsa.PrivateKey)
		if !ok {
			return fmt.Errorf("unsupported CA key")
		}
		if !ca.IsCA || time.Until(ca.NotAfter) < 366*24*time.Hour {
			return fmt.Errorf("CA expiring; create a new trust root explicitly")
		}
	}
	leafKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	leaf := &x509.Certificate{SerialNumber: serial(), Subject: pkix.Name{CommonName: host}, NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(1, 0, 0), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, KeyUsage: x509.KeyUsageDigitalSignature}
	if ip := net.ParseIP(host); ip != nil {
		leaf.IPAddresses = []net.IP{ip}
	} else {
		leaf.DNSNames = []string{host}
	}
	leaf.DNSNames = append(leaf.DNSNames, "localhost")
	leaf.IPAddresses = append(leaf.IPAddresses, net.ParseIP("127.0.0.1"), net.ParseIP("::1"))
	der, err := x509.CreateCertificate(rand.Reader, leaf, ca, &leafKey.PublicKey, key)
	if err != nil {
		return err
	}
	for name, value := range map[string]interface{}{"ca.key": key, "server.key": leafKey} {
		raw, e := x509.MarshalPKCS8PrivateKey(value)
		if e != nil {
			return e
		}
		if e = os.WriteFile(filepath.Join(dir, name), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: raw}), 0600); e != nil {
			return e
		}
	}
	for name, raw := range map[string][]byte{"ca.crt": caDER, "server.crt": der} {
		if e := os.WriteFile(filepath.Join(dir, name), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: raw}), 0600); e != nil {
			return e
		}
	}
	return os.WriteFile(filepath.Join(dir, "TRUST.txt"), []byte("Trust ca.crt on each client using its operating system certificate settings. Never copy ca.key or server.key to clients. LinkOS does not install a trust root or modify firewall rules automatically. Run linkos tls renew before server.crt expires.\n"), 0600)
}

func checkTLS(c runtimeConfig) error {
	pair, err := tls.LoadX509KeyPair(c.TLSCertFile, c.TLSKeyFile)
	if err != nil {
		return fmt.Errorf("TLS certificate/key: %w", err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return err
	}
	u, err := url.Parse(c.PublicURL)
	if err != nil {
		return err
	}
	if err = leaf.VerifyHostname(u.Hostname()); err != nil {
		return err
	}
	if time.Now().Before(leaf.NotBefore) || time.Now().After(leaf.NotAfter) {
		return fmt.Errorf("TLS certificate expired or not yet valid")
	}
	return nil
}
