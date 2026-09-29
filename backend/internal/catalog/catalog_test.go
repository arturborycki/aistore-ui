package catalog

import (
	"net/url"
	"strings"
	"testing"
)

func TestParseNamespace(t *testing.T) {
	levels, err := ParseNamespace("finance%1Fq3")
	if err != nil || len(levels) != 2 || levels[0] != "finance" || levels[1] != "q3" {
		t.Fatalf("got %v %v", levels, err)
	}
	for _, bad := range []string{"", "a%2Fb", "..", "a%1F", strings.Repeat("a%1F", 10) + "a", "a%00b"} {
		if _, err := ParseNamespace(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestApplyQuery(t *testing.T) {
	rules := map[string]QueryRule{"purge": {Upstream: "purgeRequested", Required: true, Check: qBool}}
	if _, err := ApplyQuery(rules, url.Values{}); err == nil {
		t.Fatal("missing required param accepted")
	}
	out, err := ApplyQuery(rules, url.Values{"purge": {"false"}})
	if err != nil || out.Get("purgeRequested") != "false" {
		t.Fatalf("mapping: %v %v", out, err)
	}
	if _, err := ApplyQuery(rules, url.Values{"purge": {"yes"}}); err == nil {
		t.Fatal("bad bool accepted")
	}
	if _, err := ApplyQuery(rules, url.Values{"purge": {"true"}, "x": {"1"}}); err == nil {
		t.Fatal("unknown param accepted")
	}
	if _, err := ApplyQuery(listQuery("size"), url.Values{"sort": {"records"}}); err == nil {
		t.Fatal("sort value not allowed for entity accepted")
	}
}

func TestCreateTableValidation(t *testing.T) {
	good := `{"name":"orders","schema":{"type":"struct","fields":[{"id":1,"name":"id","type":"long","required":true}]},"properties":{"owner":"x"}}`
	if _, err := vCreateTable(&Params{}, []byte(good)); err != nil {
		t.Fatalf("good rejected: %v", err)
	}
	bad := map[string]string{
		"location":      `{"name":"orders","location":"s3://x","schema":{"type":"struct","fields":[{"id":1,"name":"id","type":"long"}]}}`,
		"upper name":    `{"name":"Orders","schema":{"type":"struct","fields":[{"id":1,"name":"id","type":"long"}]}}`,
		"default value": `{"name":"orders","schema":{"type":"struct","fields":[{"id":1,"name":"id","type":"long","write-default":5}]}}`,
		"data path":     `{"name":"orders","schema":{"type":"struct","fields":[{"id":1,"name":"id","type":"long"}]},"properties":{"write.data.path":"s3://x"}}`,
		"metadata prop": `{"name":"orders","schema":{"type":"struct","fields":[{"id":1,"name":"id","type":"long"}]},"properties":{"write.metadata.path":"s3://x"}}`,
		"no schema":     `{"name":"orders"}`,
		"unknown field": `{"name":"orders","schema":{"type":"struct","fields":[{"id":1,"name":"id","type":"long"}]},"foo":1}`,
	}
	for name, body := range bad {
		if _, err := vCreateTable(&Params{}, []byte(body)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestCommitValidation(t *testing.T) {
	p := &Params{Namespace: []string{"a"}, Name: "t"}
	good := `{"identifier":{"namespace":["a"],"name":"t"},"requirements":[{"type":"assert-current-schema-id","current-schema-id":0}],"updates":[{"action":"set-properties","updates":{"k":"v"}}]}`
	if _, err := vCommitTable(p, []byte(good)); err != nil {
		t.Fatalf("good rejected: %v", err)
	}
	for name, body := range map[string]string{
		"set-location":   `{"requirements":[],"updates":[{"action":"set-location","location":"s3://evil"}]}`,
		"unknown action": `{"requirements":[],"updates":[{"action":"drop-everything"}]}`,
		"wrong ident":    `{"identifier":{"namespace":["b"],"name":"t"},"requirements":[],"updates":[{"action":"set-properties","updates":{"k":"v"}}]}`,
		"empty":          `{"requirements":[],"updates":[]}`,
		"bad prop":       `{"requirements":[],"updates":[{"action":"set-properties","updates":{"write.data.path":"x"}}]}`,
	} {
		if _, err := vCommitTable(p, []byte(body)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestRedact(t *testing.T) {
	in := `{"metadata-location":"s3://w/m.json","metadata":{"current-snapshot-id":3051729675574597004},` +
		`"config":{"s3.access-key-id":"AK","s3.secret-access-key":"SK","s3.session-token":"T","s3.delete-enabled":"false","client.region":"x","foo":"bar"},` +
		`"storage-credentials":[{"prefix":"s3://w","config":{"s3.secret-access-key":"SK"}}]}`
	out := string(Redact([]byte(in)))
	for _, leak := range []string{`"AK"`, `"SK"`, `"T"`, "storage-credentials", "client.region"} {
		if strings.Contains(out, leak) {
			t.Fatalf("leaked %s in %s", leak, out)
		}
	}
	for _, keep := range []string{"3051729675574597004", `"s3.delete-enabled":"false"`, `"foo":"bar"`} {
		if !strings.Contains(out, keep) {
			t.Fatalf("lost %s in %s", keep, out)
		}
	}
}

func TestEveryRouteHasUpstreamAndUniquePattern(t *testing.T) {
	seen := map[string]bool{}
	for _, r := range Routes(1000) {
		k := r.Method + " " + r.Pattern
		if seen[k] {
			t.Fatalf("duplicate route %s", k)
		}
		seen[k] = true
		p := &Params{Warehouse: "wh", Namespace: []string{"a", "b"}, Name: "t", Type: "icebergCompaction"}
		segs := r.Upstream(p)
		if len(segs) == 0 {
			t.Fatalf("%s has no upstream", r.Operation)
		}
		if (r.Method == "POST" || r.Method == "PUT") && r.Body == nil {
			t.Fatalf("%s accepts a body without validation", r.Operation)
		}
	}
}
