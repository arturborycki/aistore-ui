package config

import (
	"os"
	"testing"
)

func TestLoadFromEnvironment(t *testing.T) {
	t.Setenv("TEST_PUBLIC", "https://nas.local:30443")
	t.Setenv("TEST_CONFIG", `
server: { publicUrl: "${TEST_PUBLIC}" }
session: { keys: [{ id: a, value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }] }
auth: { builtin: { enabled: true } }
clusters: [{ id: lab, endpoint: "http://aistor:9000" }]
`)
	c, err := Load("env:TEST_CONFIG")
	if err != nil {
		t.Fatal(err)
	}
	if c.PublicURL().Host != "nas.local:30443" {
		t.Errorf("publicUrl = %s", c.PublicURL())
	}
	if _, err := Load("env:TEST_MISSING"); err == nil {
		t.Error("an empty variable must be an error")
	}
}

func TestGeneratedSessionKey(t *testing.T) {
	dir := t.TempDir()
	keyFile := dir + "/keys/session.key"
	raw := []byte(`
server: { publicUrl: "https://nas.local:30443" }
session: { keys: [{ id: a, file: "` + keyFile + `", generate: true }] }
auth: { builtin: { enabled: true } }
clusters: [{ id: lab, endpoint: "http://aistor:9000" }]
`)
	c1, err := Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(c1.Session.Keys[0].Bytes()) != 32 {
		t.Fatalf("key length %d", len(c1.Session.Keys[0].Bytes()))
	}
	if st, err := os.Stat(keyFile); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("key file: %v %v", st, err)
	}
	c2, err := Parse(raw) // a restart keeps the key
	if err != nil {
		t.Fatal(err)
	}
	if string(c1.Session.Keys[0].Bytes()) != string(c2.Session.Keys[0].Bytes()) {
		t.Error("the generated key changed across restarts")
	}
	if _, err := Parse([]byte(`
server: { publicUrl: "https://nas.local" }
session: { keys: [{ id: a, generate: true }] }
auth: { builtin: { enabled: true } }
clusters: [{ id: lab, endpoint: "http://aistor:9000" }]
`)); err == nil {
		t.Error("generate without file must be an error")
	}
}

func TestYAMLInEnvironmentIsNotASetting(t *testing.T) {
	t.Setenv("AISTOR_UI_CONFIG_YAML", `
server: { publicUrl: "https://nas.local:30443" }
session: { keys: [{ id: a, value: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }] }
auth: { builtin: { enabled: true } }
clusters: [{ id: lab, endpoint: "http://aistor:9000" }]
`)
	if _, err := Load("env:AISTOR_UI_CONFIG_YAML"); err != nil {
		t.Fatalf("existing TrueNAS YAML installs must keep working: %v", err)
	}
}

func TestMissingFileWithEnvironment(t *testing.T) {
	t.Setenv("AISTOR_UI_SERVER_PUBLIC_URL", "https://nas.local")
	t.Setenv("AISTOR_UI_SESSION_KEY_VALUE", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	t.Setenv("AISTOR_UI_AUTH_BUILTIN_ENABLED", "true")
	t.Setenv("AISTOR_UI_CLUSTER_ID", "lab")
	t.Setenv("AISTOR_UI_CLUSTER_ENDPOINT", "http://aistor:9000")
	if _, err := Load(t.TempDir() + "/missing.yaml"); err != nil {
		t.Fatalf("a missing file must be fine when AISTOR_UI_* variables are set: %v", err)
	}
}
