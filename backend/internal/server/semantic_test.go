package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/arturborycki/aistore-ui/backend/internal/aistortest"
)

// doH is do with extra request headers.
func (b *browser) doH(method, path, body string, hdr map[string]string) (*http.Response, map[string]any) {
	b.e.t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, b.e.app.URL+path, rdr)
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Origin", b.e.app.URL)
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	if b.csrf != "" {
		req.Header.Set("X-CSRF-Token", b.csrf)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := b.c.Do(req)
	if err != nil {
		b.e.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if out == nil {
		out = map[string]any{"_raw": string(raw)}
	}
	return resp, out
}

const semanticCfg = `
semantic: { enabled: true, bucket: models }
`

func semanticEnv(t *testing.T) (*env, *aistortest.ObjectStore) {
	e := newEnvCfg(t, false, semanticCfg)
	cat := aistortest.NewCatalog()
	e.fake.Handler = func(w http.ResponseWriter, r *http.Request, _ string) { cat.Handle(w, r) }
	objs := aistortest.NewObjectStore()
	objs.CreateBucket("models", true)
	e.fake.Objects = objs
	return e, objs
}

func TestSemanticModelLifecycle(t *testing.T) {
	e, objs := semanticEnv(t)
	// bob may read the catalog and models but not write models.
	e.fake.SetAllowed("bob", []string{"GET *"})
	alice, bob := e.browser(), e.browser()
	alice.login("alice", "alice-pw")
	bob.login("bob", "bob-pw")

	alice.do("POST", "/api/c/dev/warehouses", `{"name":"shop"}`)
	alice.do("POST", "/api/c/dev/wh/shop/namespaces", `{"namespace":["sales"]}`)
	for _, tbl := range []string{
		`{"name":"orders","schema":{"type":"struct","identifier-field-ids":[1],"fields":[{"id":1,"name":"order_id","type":"long","required":true,"doc":"Order key"},{"id":2,"name":"customer_id","type":"long","required":true},{"id":3,"name":"amount","type":"decimal(12, 2)","required":false}]}}`,
		`{"name":"customers","schema":{"type":"struct","identifier-field-ids":[1],"fields":[{"id":1,"name":"customer_id","type":"long","required":true},{"id":2,"name":"name","type":"string","required":false}]}}`,
	} {
		if resp, out := alice.do("POST", "/api/c/dev/wh/shop/ns/sales/tables", tbl); resp.StatusCode != 200 {
			t.Fatalf("create table: %d %v", resp.StatusCode, out)
		}
	}
	me := func(b *browser) map[string]any { _, m := b.do("GET", "/auth/me", ""); return m }
	if f := me(alice)["features"].(map[string]any)["semantic"].(map[string]any); f["enabled"] != true {
		t.Fatalf("feature flag: %v", f)
	}

	base := "/api/c/dev/semantic/wh/shop/ns/sales/models"
	// Create from two tables.
	resp, out := alice.do("POST", base, `{"name":"retail","description":"Retail","tables":[{"namespace":["sales"],"name":"orders"},{"namespace":["sales"],"name":"customers"}]}`)
	if resp.StatusCode != 201 {
		t.Fatalf("create: %d %v", resp.StatusCode, out)
	}
	etag := out["etag"].(string)
	if keys := objs.Keys("models"); len(keys) != 1 || keys[0] != "shop/sales/retail.ossie.yaml" {
		t.Fatalf("stored keys: %v", keys)
	}
	if resp, out := alice.do("POST", base, `{"name":"retail","tables":[{"namespace":["sales"],"name":"orders"}]}`); resp.StatusCode != 409 || errType(out) != "ModelExists" {
		t.Fatalf("duplicate create: %d %v", resp.StatusCode, out)
	}

	// Read it back: generated datasets, row key, extensions.
	_, got := alice.do("GET", base+"/retail", "")
	model := got["model"].(map[string]any)
	ds := model["datasets"].([]any)[0].(map[string]any)
	if ds["name"] != "orders" || ds["source"] != "shop.sales.orders" || ds["primary_key"].([]any)[0] != "order_id" {
		t.Fatalf("generated dataset: %v", ds)
	}
	// The stored file is canonical, schema-valid YAML.
	yresp, _ := alice.doH("GET", base+"/retail?format=yaml", "", nil)
	if ct := yresp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/yaml") {
		t.Fatalf("yaml content type %q", ct)
	}

	// Edit: add a relationship and a metric, save with If-Match.
	model["relationships"] = []any{map[string]any{"name": "orders_customer", "from": "orders", "to": "customers", "from_columns": []any{"customer_id"}, "to_columns": []any{"customer_id"}}}
	model["metrics"] = []any{map[string]any{"name": "revenue", "datatype": "Decimal", "expression": map[string]any{"dialects": []any{map[string]any{"dialect": "ANSI_SQL", "expression": "SUM(orders.amount)"}}}}}
	body, _ := json.Marshal(map[string]any{"model": model})
	if resp, _ := alice.doH("PUT", base+"/retail", string(body), nil); resp.StatusCode != 428 {
		t.Fatalf("save without If-Match: %d", resp.StatusCode)
	}
	resp, out = alice.doH("PUT", base+"/retail", string(body), map[string]string{"If-Match": etag})
	if resp.StatusCode != 200 {
		t.Fatalf("save: %d %v", resp.StatusCode, out)
	}
	etag2 := out["etag"].(string)
	// A stale save conflicts instead of overwriting.
	if resp, out := alice.doH("PUT", base+"/retail", string(body), map[string]string{"If-Match": etag}); resp.StatusCode != 409 || errType(out) != "ModelConflict" {
		t.Fatalf("stale save: %d %v", resp.StatusCode, out)
	}
	// Invalid models are rejected with located problems.
	bad := strings.Replace(string(body), "SUM(orders.amount)", "SUM(orders.amt)", 1)
	resp, out = alice.doH("PUT", base+"/retail", bad, map[string]string{"If-Match": etag2})
	if resp.StatusCode != 422 || !strings.Contains(toJSON(out["problems"]), `orders has no field \"amt\"`) {
		t.Fatalf("invalid save: %d %v", resp.StatusCode, out)
	}
	yamlBody := "version: \"0.2.0.dev0\"\nname: retail\nextra: 1\ndatasets: [{name: a, source: a.b.c}]\n"
	resp, out = alice.doH("PUT", base+"/retail", yamlBody, map[string]string{"If-Match": etag2, "Content-Type": "application/yaml"})
	if resp.StatusCode != 422 || !strings.Contains(toJSON(out["problems"]), "additional properties") {
		t.Fatalf("schema-invalid YAML: %d %v", resp.StatusCode, out)
	}

	// bob can read but AIStor denies his writes, and says which permission.
	if resp, _ := bob.do("GET", base+"/retail", ""); resp.StatusCode != 200 {
		t.Fatalf("bob read: %d", resp.StatusCode)
	}
	resp, out = bob.doH("PUT", base+"/retail", string(body), map[string]string{"If-Match": etag2})
	if resp.StatusCode != 403 || resp.Header.Get("X-Aistor-Action") != "s3:PutObject" || resp.Header.Get("X-Aistor-Resource") != "arn:aws:s3:::models/shop/sales/retail.ossie.yaml" {
		t.Fatalf("bob write: %d %v %v", resp.StatusCode, resp.Header, out)
	}

	// History, with the editor of each version.
	_, out = alice.do("GET", base+"/retail/versions", "")
	vs := out["versions"].([]any)
	if len(vs) != 2 || vs[0].(map[string]any)["editor"] != "alice" {
		t.Fatalf("versions: %v", vs)
	}
	oldID := vs[1].(map[string]any)["versionId"].(string)
	if _, out := alice.do("GET", base+"/retail?version="+oldID, ""); out["model"].(map[string]any)["metrics"] != nil {
		t.Fatalf("old version has the later metric: %v", out)
	}

	// Listing, usage and search.
	_, out = alice.do("GET", base, "")
	if ms := out["models"].([]any); len(ms) != 1 || ms[0].(map[string]any)["metrics"].(float64) != 1 {
		t.Fatalf("list: %v", out)
	}
	_, tbl := alice.do("GET", "/api/c/dev/wh/shop/ns/sales/t/orders", "")
	uuid := tbl["metadata"].(map[string]any)["table-uuid"].(string)
	_, out = alice.do("GET", "/api/c/dev/semantic/wh/shop/usage?table="+uuid, "")
	u := out["usage"].([]any)
	if len(u) != 1 || u[0].(map[string]any)["dataset"] != "orders" || len(u[0].(map[string]any)["metrics"].([]any)) != 1 {
		t.Fatalf("usage: %v", out)
	}
	_, out = alice.do("GET", "/api/c/dev/semantic/search?q=reven", "")
	if hits := out["results"].([]any); len(hits) == 0 || hits[0].(map[string]any)["kind"] != "metric" {
		t.Fatalf("search: %v", out)
	}

	// Drift: rename a column and the table; the model follows by field ID and UUID.
	commit := `{"requirements":[],"updates":[{"action":"add-schema","schema":{"type":"struct","identifier-field-ids":[1],"fields":[{"id":1,"name":"order_id","type":"long","required":true},{"id":2,"name":"customer_id","type":"long","required":true},{"id":3,"name":"total","type":"decimal(12, 2)","required":false},{"id":4,"name":"channel","type":"string","required":false}]},"last-column-id":4},{"action":"set-current-schema","schema-id":-1}]}`
	if resp, out := alice.do("POST", "/api/c/dev/wh/shop/ns/sales/t/orders", commit); resp.StatusCode != 200 {
		t.Fatalf("evolve: %d %v", resp.StatusCode, out)
	}
	if resp, out := alice.do("POST", "/api/c/dev/wh/shop/tables/rename", `{"source":{"namespace":["sales"],"name":"orders"},"destination":{"namespace":["sales"],"name":"purchases"}}`); resp.StatusCode != 204 && resp.StatusCode != 200 {
		t.Fatalf("rename: %d %v", resp.StatusCode, out)
	}
	_, out = alice.do("GET", base+"/retail/drift", "")
	kinds := toJSON(out["items"])
	for _, want := range []string{"table_moved", "column_renamed", "new_columns"} {
		if !strings.Contains(kinds, want) {
			t.Fatalf("drift %s missing: %s", want, kinds)
		}
	}
	_, out = alice.do("POST", base+"/retail/drift", `{"ids":[]}`)
	fixed := out["model"].(map[string]any)
	fb, _ := json.Marshal(map[string]any{"model": fixed})
	if resp, out := alice.doH("PUT", base+"/retail", string(fb), map[string]string{"If-Match": out["etag"].(string)}); resp.StatusCode != 200 {
		t.Fatalf("save fixed: %d %v", resp.StatusCode, out)
	}
	_, out = alice.do("GET", base+"/retail/drift", "")
	if items := out["items"].([]any); len(items) != 0 {
		t.Fatalf("drift left after fixing: %v", items)
	}
	_, got = alice.do("GET", base+"/retail", "")
	ds = got["model"].(map[string]any)["datasets"].([]any)[0].(map[string]any)
	if ds["source"] != "shop.sales.purchases" || !strings.Contains(toJSON(ds["fields"]), `"expression":"total"`) {
		t.Fatalf("fix not applied: %v", ds)
	}

	// Delete needs step-up and the current ETag.
	_, cur := alice.do("GET", base+"/retail", "")
	if resp, out := alice.doH("DELETE", base+"/retail", "", map[string]string{"If-Match": cur["etag"].(string)}); resp.StatusCode != 403 || errType(out) != "StepUpRequired" {
		t.Fatalf("delete without step-up: %d %v", resp.StatusCode, out)
	}
	alice.do("POST", "/auth/step-up", `{"secret":"alice-pw"}`)
	if resp, _ := alice.doH("DELETE", base+"/retail", "", map[string]string{"If-Match": etag}); resp.StatusCode != 409 {
		t.Fatalf("stale delete: %d", resp.StatusCode)
	}
	if resp, out := alice.doH("DELETE", base+"/retail", "", map[string]string{"If-Match": cur["etag"].(string)}); resp.StatusCode != 204 {
		t.Fatalf("delete: %d %v", resp.StatusCode, out)
	}
	if resp, out := alice.do("GET", base+"/retail", ""); resp.StatusCode != 404 || errType(out) != "NoSuchModel" {
		t.Fatalf("after delete: %d %v", resp.StatusCode, out)
	}

	// Import an existing Ossie document (the upstream TPC-DS example).
	raw, _ := json.Marshal(map[string]any{"name": "tpcds", "raw": tpcdsYAML(t)})
	if resp, out := alice.do("POST", base, string(raw)); resp.StatusCode != 201 {
		t.Fatalf("import: %d %v", resp.StatusCode, out)
	}
	bad2, _ := json.Marshal(map[string]any{"name": "broken", "raw": "version: \"0.2.0.dev0\"\nname: x\n"})
	if resp, out := alice.do("POST", base, string(bad2)); resp.StatusCode != 422 || out["problems"] == nil {
		t.Fatalf("invalid import: %d %v", resp.StatusCode, out)
	}

	// Every change is audited.
	_, act := alice.do("GET", "/api/activity?q="+url.QueryEscape("SemanticModel"), "")
	if act["total"].(float64) < 3 {
		t.Fatalf("semantic changes not audited: %v", act)
	}
}

func TestSemanticDisabledAndMissingBucket(t *testing.T) {
	e := newEnv(t, false)
	b := e.browser()
	b.login("alice", "alice-pw")
	if resp, _ := b.do("GET", "/api/c/dev/semantic/wh/xyz/ns/y/models", ""); resp.StatusCode != 404 {
		t.Fatalf("semantic routes exposed while disabled: %d", resp.StatusCode)
	}
	e2, _ := semanticEnv(t)
	e2.fake.Objects = aistortest.NewObjectStore() // no bucket
	b2 := e2.browser()
	b2.login("alice", "alice-pw")
	if resp, out := b2.do("GET", "/api/c/dev/semantic/wh/xyz/ns/y/models", ""); resp.StatusCode != 503 || errType(out) != "SemanticStoreUnavailable" {
		t.Fatalf("missing bucket: %d %v", resp.StatusCode, out)
	}
}

func tpcdsYAML(t *testing.T) string {
	b, err := os.ReadFile("../semantic/testdata/tpcds_semantic_model.yaml")
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func toJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
