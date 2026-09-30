package main

import (
	"crypto/tls"
	"crypto/x509"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/arturborycki/aistore-ui/backend/internal/config"
)

func tlsConfig(t *testing.T, dir, public string, metrics string) *config.Config {
	t.Helper()
	cfg, err := config.Parse([]byte(`
server:
  listen: ":8443"
  metricsListen: "` + metrics + `"
  publicUrl: "` + public + `"
  extraOrigins: ["https://10.0.0.5:30443"]
  tlsSelfSigned: true
  tlsCertFile: ` + filepath.Join(dir, "tls", "cert.pem") + `
  tlsKeyFile: ` + filepath.Join(dir, "tls", "key.pem") + `
session: { keys: [{ id: a, value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }] }
auth: { builtin: { enabled: true } }
clusters: [{ id: lab, endpoint: "http://aistor:9000" }]
`))
	if err != nil {
		t.Fatal(err)
	}
	return cfg
}

func leafOf(t *testing.T, cfg *config.Config) *x509.Certificate {
	t.Helper()
	pair, err := tls.LoadX509KeyPair(cfg.Server.TLSCertFile, cfg.Server.TLSKeyFile)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	return leaf
}

func TestSelfSignedCertificate(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := tlsConfig(t, dir, "https://truenas.local:30443", ":9090")
	if err := ensureSelfSigned(cfg, log); err != nil {
		t.Fatal(err)
	}
	first := leafOf(t, cfg)
	for _, n := range []string{"truenas.local", "10.0.0.5", "localhost", "127.0.0.1"} {
		if err := first.VerifyHostname(n); err != nil {
			t.Errorf("certificate does not cover %s: %v", n, err)
		}
	}
	if st, _ := os.Stat(cfg.Server.TLSKeyFile); st.Mode().Perm() != 0o600 {
		t.Errorf("key mode = %v, want 0600", st.Mode().Perm())
	}

	// Kept across restarts.
	if err := ensureSelfSigned(cfg, log); err != nil {
		t.Fatal(err)
	}
	if leafOf(t, cfg).SerialNumber.Cmp(first.SerialNumber) != 0 {
		t.Error("certificate was replaced although it still fits")
	}

	// Replaced when the public host changes.
	moved := tlsConfig(t, dir, "https://nas.example.lan:30443", ":9090")
	if err := ensureSelfSigned(moved, log); err != nil {
		t.Fatal(err)
	}
	if err := leafOf(t, moved).VerifyHostname("nas.example.lan"); err != nil {
		t.Errorf("new host not covered: %v", err)
	}
}

func TestSelfSignedKeepsUnreadableCertificate(t *testing.T) {
	dir := t.TempDir()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	own := tlsConfig(t, dir, "https://own.local", ":9090")
	if err := ensureSelfSigned(own, log); err != nil {
		t.Fatal(err)
	}
	// A certificate file that cannot be loaded is reported, never overwritten.
	if err := os.WriteFile(own.Server.TLSCertFile, []byte("not a certificate"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := ensureSelfSigned(own, log); err == nil {
		t.Fatal("a certificate file that cannot be loaded must be reported, not overwritten")
	}
}

func TestHealthURL(t *testing.T) {
	dir := t.TempDir()
	if u, err := healthURL(tlsConfig(t, dir, "https://nas.local", ":9090")); err != nil || u != "http://127.0.0.1:9090/healthz" {
		t.Errorf("TLS with metrics: %q %v", u, err)
	}
	if _, err := healthURL(tlsConfig(t, dir, "https://nas.local", "")); err == nil {
		t.Error("TLS without a metrics listener must be an error")
	}
}
