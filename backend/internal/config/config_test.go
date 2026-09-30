package config

import "testing"

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
