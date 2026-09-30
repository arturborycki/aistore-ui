package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/arturborycki/aistore-ui/backend/internal/config"
)

// selfSignedOrg marks certificates this program generated, so that only those
// are ever replaced; a certificate someone put in place is left alone.
const selfSignedOrg = "AIStor Catalog UI (self-signed)"

// ensureSelfSigned makes sure the configured certificate files exist, creating
// a self-signed certificate for the public URL's host (and the extra origins'
// hosts) when they are missing, or when a certificate generated earlier is
// about to expire or no longer covers those names.
func ensureSelfSigned(cfg *config.Config, log *slog.Logger) error {
	certFile, keyFile := cfg.Server.TLSCertFile, cfg.Server.TLSKeyFile
	names := certNames(cfg)
	if pair, err := tls.LoadX509KeyPair(certFile, keyFile); err == nil {
		leaf, err := x509.ParseCertificate(pair.Certificate[0])
		if err != nil {
			return fmt.Errorf("parse %s: %w", certFile, err)
		}
		generated := slices.Contains(leaf.Subject.Organization, selfSignedOrg)
		if !generated || (time.Until(leaf.NotAfter) > 30*24*time.Hour && covers(leaf, names)) {
			return nil
		}
		log.Info("replacing the self-signed certificate", "reason", "expiring or host names changed")
	} else if _, statErr := os.Stat(certFile); statErr == nil {
		return fmt.Errorf("load TLS certificate: %w", err)
	}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	now := time.Now()
	tmpl := &x509.Certificate{
		SerialNumber:          serial,
		Subject:               pkix.Name{CommonName: names[0], Organization: []string{selfSignedOrg}},
		NotBefore:             now.Add(-time.Hour),
		NotAfter:              now.Add(397 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
	}
	for _, n := range names {
		if ip := net.ParseIP(n); ip != nil {
			tmpl.IPAddresses = append(tmpl.IPAddresses, ip)
		} else {
			tmpl.DNSNames = append(tmpl.DNSNames, n)
		}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return err
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	for _, f := range []string{certFile, keyFile} {
		if err := os.MkdirAll(filepath.Dir(f), 0o700); err != nil {
			return fmt.Errorf("self-signed certificate: %w (is the directory writable?)", err)
		}
	}
	if err := writeFileAtomic(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		return err
	}
	if err := writeFileAtomic(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		return err
	}
	sum := sha256.Sum256(der)
	log.Warn("created a self-signed TLS certificate; browsers will ask you to accept it once",
		"names", strings.Join(names, ","), "sha256", hex.EncodeToString(sum[:]), "expires", tmpl.NotAfter.Format(time.DateOnly))
	return nil
}

// certNames lists the host names and addresses the certificate must cover,
// the public URL's host first.
func certNames(cfg *config.Config) []string {
	names := []string{cfg.PublicURL().Hostname()}
	for _, o := range cfg.Server.ExtraOrigins {
		if u, err := url.Parse(o); err == nil && u.Hostname() != "" {
			names = append(names, u.Hostname())
		}
	}
	names = append(names, "localhost", "127.0.0.1", "::1")
	var out []string
	for _, n := range names {
		if !slices.Contains(out, n) {
			out = append(out, n)
		}
	}
	return out
}

func covers(c *x509.Certificate, names []string) bool {
	for _, n := range names {
		if c.VerifyHostname(n) != nil {
			return false
		}
	}
	return true
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return fmt.Errorf("self-signed certificate: %w (is the directory writable?)", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// healthURL derives the probe URL for "-healthcheck auto": the plain-HTTP
// metrics listener when there is one (so a TLS listener needs no certificate
// check), otherwise the main listener when it serves plain HTTP.
func healthURL(cfg *config.Config) (string, error) {
	listen := cfg.Server.MetricsListen
	if listen == "" {
		if cfg.Server.TLSCertFile != "" {
			return "", errors.New("-healthcheck auto with TLS needs server.metricsListen (health is probed there over plain HTTP)")
		}
		listen = cfg.Server.Listen
	}
	_, port, err := net.SplitHostPort(listen)
	if err != nil || port == "" {
		return "", fmt.Errorf("listen address %q has no port", listen)
	}
	return "http://" + net.JoinHostPort("127.0.0.1", port) + "/healthz", nil
}
