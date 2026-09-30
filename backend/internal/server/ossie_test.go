package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/arturborycki/aistore-ui/backend/internal/aistortest"
	"github.com/arturborycki/aistore-ui/backend/internal/audit"
	"github.com/arturborycki/aistore-ui/backend/internal/config"
	"github.com/arturborycki/aistore-ui/backend/internal/semantic"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

func TestOssieServingAndMCP(t *testing.T) {
	idp := newIdP(t)
	fake := aistortest.New(
		&aistortest.User{AccessKey: "alice", Allowed: []string{"*"}},
		&aistortest.User{AccessKey: "bob", Allowed: []string{"GET /warehouses", "GET /shop/*"}}, // catalog only, no model objects
	)
	defer fake.Close()
	fake.WebIdentity = jwtSubject
	cat := aistortest.NewCatalog()
	cat.Seed("shop", nil, map[string][3]int64{"sales": {1, 10, 10}})
	fake.Handler = func(w http.ResponseWriter, r *http.Request, _ string) { cat.Handle(w, r) }
	fake.Objects = aistortest.NewObjectStore()
	fake.Objects.CreateBucket("models", true)
	m := &semantic.Model{Version: semantic.SpecVersion, Name: "retail", Description: "Retail KPIs", Datasets: []semantic.Dataset{{Name: "orders", Source: "shop.sales.orders", Fields: []semantic.Field{{Name: "amount", Expression: semantic.Simple("amount"), Datatype: "Decimal", AIContext: map[string]any{"synonyms": []any{"order value"}}}}}},
		Metrics: []semantic.Metric{{Name: "revenue", Expression: semantic.Simple("SUM(orders.amount)")}}}
	y, _ := semantic.MarshalYAML(m)
	fake.Objects.Put("models", "shop/sales/retail.ossie.yaml", y)

	app := httptest.NewUnstartedServer(nil)
	pub := "http://" + app.Listener.Addr().String()
	cfg, err := config.Parse([]byte(`
server: { publicUrl: "` + pub + `" }
session: { keys: [{ id: k1, value: "0000000000000000000000000000000000000000000000000000000000000001" }] }
auth: { oidc: { enabled: true, issuer: "` + idp.srv.URL + `", clientId: aistor-ui, clientSecret: s } }
clusters: [{ id: dev, endpoint: "` + fake.URL() + `" }]
semantic: { enabled: true, bucket: models, serving: { enabled: true, requestsPerMinute: 1000 } }
`))
	if err != nil {
		t.Fatal(err)
	}
	kr, _ := session.NewKeyring([]session.KeyMaterial{{ID: "k1", Key: cfg.Session.Keys[0].Bytes()}})
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv, err := New(Options{Config: cfg, Log: log, Sessions: session.NewManager(session.NewMemoryStore(), kr, cfg.Session.IdleTimeout, cfg.Session.AbsoluteTTL), Audit: audit.NewLogger(log, audit.NewMemoryStore(10), ""), Version: "test"})
	if err != nil {
		t.Fatal(err)
	}
	app.Config.Handler = srv.Handler()
	app.Start()
	defer app.Close()

	token := func(user, aud string) string {
		now := time.Now()
		return idp.sign(map[string]any{"iss": idp.srv.URL, "aud": aud, "sub": "sub-" + user, "preferred_username": user, "iat": now.Unix(), "exp": now.Add(time.Hour).Unix()})
	}
	call := func(method, path, tok, body string, hdr map[string]string) (*http.Response, []byte) {
		t.Helper()
		var rdr io.Reader
		if body != "" {
			rdr = strings.NewReader(body)
		}
		req, _ := http.NewRequest(method, app.URL+path, rdr)
		if tok != "" {
			req.Header.Set("Authorization", "Bearer "+tok)
		}
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		for k, v := range hdr {
			req.Header.Set(k, v)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		b, _ := io.ReadAll(resp.Body)
		return resp, b
	}
	alice := token("alice", "aistor-ui")

	// Unauthenticated: 401 with a challenge pointing at the resource metadata.
	resp, _ := call("GET", "/ossie/v1/models", "", "", nil)
	if resp.StatusCode != 401 || !strings.Contains(resp.Header.Get("WWW-Authenticate"), "resource_metadata=") {
		t.Fatalf("no token: %d %v", resp.StatusCode, resp.Header)
	}
	if resp, _ := call("GET", "/ossie/v1/models", token("alice", "someone-else"), "", nil); resp.StatusCode != 401 {
		t.Fatalf("wrong audience accepted: %d", resp.StatusCode)
	}
	if resp, _ := call("GET", "/ossie/v1/models", "not-a-jwt", "", nil); resp.StatusCode != 401 {
		t.Fatalf("garbage token accepted: %d", resp.StatusCode)
	}
	if resp, b := call("GET", "/.well-known/oauth-protected-resource", "", "", nil); resp.StatusCode != 200 || !strings.Contains(string(b), idp.srv.URL) {
		t.Fatalf("resource metadata: %d %s", resp.StatusCode, b)
	}
	if resp, b := call("GET", "/ossie/v1/schema", "", "", nil); resp.StatusCode != 200 || !strings.Contains(string(b), "Apache Ossie") {
		t.Fatalf("schema: %d", resp.StatusCode)
	}

	// Index and model, as YAML and JSON, with conditional requests.
	resp, b := call("GET", "/ossie/v1/models", alice, "", nil)
	var idx struct {
		Models []semantic.IndexEntry `json:"models"`
	}
	_ = json.Unmarshal(b, &idx)
	if resp.StatusCode != 200 || len(idx.Models) != 1 || idx.Models[0].Name != "retail" || idx.Models[0].URL != "/ossie/v1/models/dev/shop/sales/retail" {
		t.Fatalf("index: %d %s", resp.StatusCode, b)
	}
	resp, b = call("GET", idx.Models[0].URL, alice, "", nil)
	if resp.StatusCode != 200 || !strings.HasPrefix(resp.Header.Get("Content-Type"), "application/yaml") || !strings.Contains(string(b), "name: revenue") {
		t.Fatalf("model yaml: %d %s", resp.StatusCode, b)
	}
	if r2, _ := call("GET", idx.Models[0].URL, alice, "", map[string]string{"If-None-Match": resp.Header.Get("ETag")}); r2.StatusCode != 304 {
		t.Fatalf("conditional GET: %d", r2.StatusCode)
	}
	if resp, b := call("GET", idx.Models[0].URL+"?format=json", alice, "", nil); resp.StatusCode != 200 || !strings.Contains(string(b), `"metrics"`) {
		t.Fatalf("model json: %d %s", resp.StatusCode, b)
	}
	if resp, b := call("GET", "/ossie/v1/search?q=order+value", alice, "", nil); resp.StatusCode != 200 || !strings.Contains(string(b), `"match":"order value"`) {
		t.Fatalf("search: %d %s", resp.StatusCode, b)
	}
	// Reads use the caller's own credentials: bob may not read model objects.
	bob := token("bob", "aistor-ui")
	if resp, b := call("GET", idx.Models[0].URL, bob, "", nil); resp.StatusCode != 403 || resp.Header.Get("X-Aistor-Action") != "s3:GetObject" {
		t.Fatalf("bob read: %d %s", resp.StatusCode, b)
	}
	// Cross-origin browser requests are refused (DNS rebinding protection).
	if resp, _ := call("GET", "/ossie/v1/models", alice, "", map[string]string{"Origin": "https://evil.example"}); resp.StatusCode != 403 {
		t.Fatalf("foreign origin accepted: %d", resp.StatusCode)
	}

	// MCP over HTTP.
	rpc := func(tok, body string) map[string]any {
		t.Helper()
		resp, b := call("POST", "/ossie/mcp", tok, body, map[string]string{"Accept": "application/json, text/event-stream"})
		if resp.StatusCode != 200 {
			t.Fatalf("mcp %s: %d %s", body, resp.StatusCode, b)
		}
		var out map[string]any
		_ = json.Unmarshal(b, &out)
		return out
	}
	init := rpc(alice, `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`)
	if init["result"].(map[string]any)["protocolVersion"] != "2025-06-18" {
		t.Fatalf("initialize: %v", init)
	}
	if resp, _ := call("POST", "/ossie/mcp", alice, `{"jsonrpc":"2.0","method":"notifications/initialized"}`, nil); resp.StatusCode != 202 {
		t.Fatalf("notification: %d", resp.StatusCode)
	}
	tools := rpc(alice, `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)["result"].(map[string]any)["tools"].([]any)
	if len(tools) != 3 {
		t.Fatalf("tools: %v", tools)
	}
	got := rpc(alice, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_model","arguments":{"cluster":"dev","warehouse":"shop","namespace":["sales"],"model":"retail"}}}`)
	res := got["result"].(map[string]any)
	if res["isError"] != false || !strings.Contains(res["content"].([]any)[0].(map[string]any)["text"].(string), "SUM(orders.amount)") {
		t.Fatalf("get_model: %v", got)
	}
	s := rpc(alice, `{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"search_semantics","arguments":{"query":"revenue"}}}`)
	if !strings.Contains(toJSON(s["result"].(map[string]any)["structuredContent"]), `"kind":"metric"`) {
		t.Fatalf("search tool: %v", s)
	}
	denied := rpc(bob, `{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_model","arguments":{"cluster":"dev","warehouse":"shop","namespace":["sales"],"model":"retail"}}}`)
	if denied["result"].(map[string]any)["isError"] != true {
		t.Fatalf("bob get_model: %v", denied)
	}
	if e := rpc(alice, `{"jsonrpc":"2.0","id":6,"method":"resources/list"}`)["error"]; e == nil {
		t.Fatalf("unknown method accepted")
	}
	if resp, _ := call("GET", "/ossie/mcp", alice, "", nil); resp.StatusCode != 405 {
		t.Fatalf("GET /ossie/mcp: %d", resp.StatusCode)
	}
	// Serving never touches sessions, and the UI API still requires a session.
	if resp, _ := call("GET", "/api/c/dev/semantic/wh/shop/ns/sales/models", alice, "", nil); resp.StatusCode != 401 {
		t.Fatalf("bearer token opened the session API: %d", resp.StatusCode)
	}
}
