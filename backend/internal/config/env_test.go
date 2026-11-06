package config

import (
	"slices"
	"strings"
	"testing"
	"time"
)

const envKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestConfigFromEnvironmentOnly(t *testing.T) {
	c, err := parse(nil, []string{
		"AISTOR_UI_SERVER_LISTEN=:8443",
		"AISTOR_UI_SERVER_PUBLIC_URL=https://nas.local:30553",
		"AISTOR_UI_SERVER_EXTRA_ORIGINS=https://192.0.2.10:30553, https://nas:30553",
		"AISTOR_UI_SERVER_TLS_SELF_SIGNED=true",
		"AISTOR_UI_SERVER_TLS_CERT_FILE=/data/tls/cert.pem",
		"AISTOR_UI_SERVER_TLS_KEY_FILE=/data/tls/key.pem",
		"AISTOR_UI_SESSION_KEY_VALUE=" + envKey,
		"AISTOR_UI_SESSION_IDLE_TIMEOUT=45m",
		"AISTOR_UI_AUTH_BUILTIN_ENABLED=true",
		"AISTOR_UI_AUTH_ADMIN_USERS=alice,bob",
		"AISTOR_UI_CLUSTER_ID=aistor",
		"AISTOR_UI_CLUSTER_ENDPOINT=http://aistor:9000",
		"AISTOR_UI_CLUSTER_STS_DURATION=12h",
		"AISTOR_UI_SEMANTIC_ENABLED=true",
		"AISTOR_UI_SEMANTIC_BUCKET=models",
		"AISTOR_UI_SEMANTIC_CATALOG_ALIASES=edw1=lake, edw2=warehouse",
		"AISTOR_UI_LIMITS_MAX_BODY_BYTES=4194304",
		"AISTOR_UI_DEBUG=1", // not a setting, ignored
		"PATH=/usr/bin",
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.PublicURL().Host != "nas.local:30553" || !c.Server.TLSSelfSigned || c.Server.Listen != ":8443" {
		t.Errorf("server: %+v", c.Server)
	}
	if !slices.Equal(c.Server.ExtraOrigins, []string{"https://192.0.2.10:30553", "https://nas:30553"}) {
		t.Errorf("extraOrigins: %q", c.Server.ExtraOrigins)
	}
	if len(c.Session.Keys) != 1 || c.Session.Keys[0].ID != "env" || len(c.Session.Keys[0].Bytes()) != 32 {
		t.Errorf("session keys: %+v", c.Session.Keys)
	}
	if c.Session.IdleTimeout != 45*time.Minute {
		t.Errorf("idle timeout: %v", c.Session.IdleTimeout)
	}
	if len(c.Clusters) != 1 || c.Clusters[0].ID != "aistor" || c.Clusters[0].STSDuration != 12*time.Hour || c.Clusters[0].Region != "us-east-1" {
		t.Errorf("clusters: %+v", c.Clusters)
	}
	if !slices.Equal(c.Auth.AdminUsers, []string{"alice", "bob"}) {
		t.Errorf("admin users: %q", c.Auth.AdminUsers)
	}
	if c.Semantic.CatalogAliases["edw2"] != "warehouse" || c.Limits.MaxBodyBytes != 4194304 {
		t.Errorf("semantic/limits: %+v %+v", c.Semantic, c.Limits)
	}
}

func TestEnvironmentOverridesFile(t *testing.T) {
	file := []byte(`
server: { publicUrl: "https://old.local" }
session: { keys: [{ id: a, value: "` + envKey + `" }] }
auth: { builtin: { enabled: true } }
clusters: [{ id: lab, name: Lab, endpoint: "http://aistor:9000" }, { id: two, endpoint: "http://two:9000" }]
`)
	c, err := parse(file, []string{
		"AISTOR_UI_SERVER_PUBLIC_URL=https://new.local",
		"AISTOR_UI_CLUSTER_NAME=Renamed",
	})
	if err != nil {
		t.Fatal(err)
	}
	if c.PublicURL().Host != "new.local" {
		t.Errorf("publicUrl not overridden: %s", c.PublicURL())
	}
	if c.Clusters[0].Name != "Renamed" || c.Clusters[0].ID != "lab" || len(c.Clusters) != 2 {
		t.Errorf("clusters: %+v", c.Clusters)
	}
	if c.Session.Keys[0].ID != "a" {
		t.Errorf("file key replaced: %+v", c.Session.Keys)
	}
}

func TestEnvironmentErrors(t *testing.T) {
	base := []string{
		"AISTOR_UI_SERVER_PUBLIC_URL=https://nas.local",
		"AISTOR_UI_SESSION_KEY_VALUE=" + envKey,
		"AISTOR_UI_AUTH_BUILTIN_ENABLED=true",
		"AISTOR_UI_CLUSTER_ID=a",
		"AISTOR_UI_CLUSTER_ENDPOINT=http://aistor:9000",
	}
	for _, tc := range []struct{ env, want string }{
		{"AISTOR_UI_SERVER_PUBLC_URL=x", "AISTOR_UI_SERVER_PUBLC_URL is not a configuration setting"},
		{"AISTOR_UI_SERVER_TRUST_PROXY=maybe", "AISTOR_UI_SERVER_TRUST_PROXY: want true or false"},
		{"AISTOR_UI_SESSION_IDLE_TIMEOUT=10", "AISTOR_UI_SESSION_IDLE_TIMEOUT: time: missing unit"},
		{"AISTOR_UI_LIMITS_MAX_BODY_BYTES=big", "AISTOR_UI_LIMITS_MAX_BODY_BYTES: want a whole number"},
		{"AISTOR_UI_CLUSTERS=x", "AISTOR_UI_CLUSTERS: not settable"},
	} {
		_, err := parse(nil, append(slices.Clone(base), tc.env))
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want %q", tc.env, err, tc.want)
		}
	}
}

func TestEnvNamesFollowYAMLKeys(t *testing.T) {
	names := EnvNames()
	for _, want := range []string{
		"AISTOR_UI_SERVER_PUBLIC_URL", "AISTOR_UI_SERVER_TLS_SELF_SIGNED", "AISTOR_UI_AUTH_OIDC_CLIENT_SECRET_FILE",
		"AISTOR_UI_SEMANTIC_SERVING_REQUESTS_PER_MINUTE", "AISTOR_UI_CLUSTER_STS_ENDPOINT", "AISTOR_UI_CLUSTER_CA_FILE",
		"AISTOR_UI_SESSION_KEY_GENERATE", "AISTOR_UI_SESSION_ABSOLUTE_TIMEOUT",
	} {
		if !slices.Contains(names, want) {
			t.Errorf("missing %s", want)
		}
	}
	for _, n := range names {
		if strings.Contains(n, "__") || strings.ToUpper(n) != n {
			t.Errorf("bad name %s", n)
		}
	}
}

func TestVariablesReferencedByTheFileAreNotSettings(t *testing.T) {
	// deploy/compose passes these into the container for ${...} expansion.
	t.Setenv("AISTOR_UI_SESSION_KEY", envKey)
	file := []byte(`
server: { publicUrl: "https://nas.local" }
session: { keys: [{ id: a, value: "${AISTOR_UI_SESSION_KEY}" }] }
auth: { builtin: { enabled: true } }
clusters: [{ id: lab, endpoint: "http://aistor:9000" }]
`)
	if _, err := parse(file, []string{"AISTOR_UI_SESSION_KEY=" + envKey}); err != nil {
		t.Fatalf("a variable used by the file must not count as an unknown setting: %v", err)
	}
}
