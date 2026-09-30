package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/arturborycki/aistore-ui/backend/internal/aistortest"
	"github.com/arturborycki/aistore-ui/backend/internal/audit"
	"github.com/arturborycki/aistore-ui/backend/internal/config"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

type env struct {
	t     *testing.T
	fake  *aistortest.Fake
	app   *httptest.Server
	store session.Store
	mgr   *session.Manager
	skew  atomic.Int64 // added to the session manager's clock
}

// advance moves the session manager's clock forward.
func (e *env) advance(d time.Duration) { e.skew.Add(int64(d)) }

func newEnv(t *testing.T, useRedis bool) *env { return newEnvCfg(t, useRedis, "") }

// newEnvCfg appends extra YAML (top-level keys) to the test configuration.
func newEnvCfg(t *testing.T, useRedis bool, extra string) *env {
	t.Helper()
	fake := aistortest.New(
		&aistortest.User{AccessKey: "alice", SecretKey: "alice-secret-key", LDAPPass: "alice-pw", Allowed: []string{"*"}},
		&aistortest.User{AccessKey: "bob", SecretKey: "bob-secret-key", LDAPPass: "bob-pw", Allowed: []string{"GET /warehouses"}},
	)
	t.Cleanup(fake.Close)

	app := httptest.NewUnstartedServer(nil)
	pub := "http://" + app.Listener.Addr().String()
	cfgYAML := `
server: { publicUrl: "` + pub + `" }
session: { keys: [{ id: k1, value: "0000000000000000000000000000000000000000000000000000000000000001" }] }
auth: { ldap: { enabled: true }, builtin: { enabled: true }, adminUsers: [alice] }
clusters: [{ id: dev, endpoint: "` + fake.URL() + `" }]
limits: { loginPerMinute: 1000 }
` + extra
	cfg, err := config.Parse([]byte(cfgYAML))
	if err != nil {
		t.Fatal(err)
	}
	var store session.Store
	var astore audit.Store
	if useRedis {
		mr := miniredis.RunT(t)
		rc := redis.NewClient(&redis.Options{Addr: mr.Addr()})
		store = session.NewRedisStoreFromClient(rc)
		astore = audit.NewRedisStore(rc, 100)
	} else {
		store = session.NewMemoryStore()
		astore = audit.NewMemoryStore(100)
	}
	kr, _ := session.NewKeyring([]session.KeyMaterial{{ID: "k1", Key: cfg.Session.Keys[0].Bytes()}})
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	mgr := session.NewManager(store, kr, cfg.Session.IdleTimeout, cfg.Session.AbsoluteTTL)
	e := &env{t: t, fake: fake, app: app, store: store, mgr: mgr}
	mgr.SetClock(func() time.Time { return time.Now().Add(time.Duration(e.skew.Load())) })
	srv, err := New(Options{Config: cfg, Log: log, Sessions: mgr, Audit: audit.NewLogger(log, astore, "")})
	if err != nil {
		t.Fatal(err)
	}
	app.Config.Handler = srv.Handler()
	app.Start()
	t.Cleanup(app.Close)
	return e
}

type browser struct {
	e    *env
	c    *http.Client
	csrf string
}

func (e *env) browser() *browser {
	jar, _ := cookiejar.New(nil)
	return &browser{e: e, c: &http.Client{Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}

func (b *browser) do(method, path string, body string) (*http.Response, map[string]any) {
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
	resp, err := b.c.Do(req)
	if err != nil {
		b.e.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	return resp, out
}

func (b *browser) login(user, pw string) {
	b.e.t.Helper()
	resp, out := b.do("POST", "/auth/ldap/login", `{"username":"`+user+`","password":"`+pw+`"}`)
	if resp.StatusCode != 200 {
		b.e.t.Fatalf("login %s: %d %v", user, resp.StatusCode, out)
	}
	b.csrf = out["csrfToken"].(string)
}

func errType(out map[string]any) string {
	e, _ := out["error"].(map[string]any)
	s, _ := e["type"].(string)
	return s
}

func TestEndToEndMultiUser(t *testing.T) {
	for _, useRedis := range []bool{false, true} {
		name := "memory"
		if useRedis {
			name = "redis"
		}
		t.Run(name, func(t *testing.T) {
			e := newEnv(t, useRedis)

			// Anonymous access is refused.
			anon := e.browser()
			if resp, out := anon.do("GET", "/api/c/dev/warehouses", ""); resp.StatusCode != 401 || errType(out) != "NotAuthenticated" {
				t.Fatalf("anonymous: %d %v", resp.StatusCode, out)
			}

			// Wrong password.
			if resp, _ := anon.do("POST", "/auth/ldap/login", `{"username":"alice","password":"nope"}`); resp.StatusCode != 401 {
				t.Fatalf("bad password accepted: %d", resp.StatusCode)
			}

			alice, bob := e.browser(), e.browser()
			alice.login("alice", "alice-pw")
			bob.login("bob", "bob-pw")

			// Session cookie attributes.
			u, _ := url.Parse(e.app.URL)
			if len(alice.c.Jar.Cookies(u)) != 1 {
				t.Fatalf("expected exactly one cookie")
			}

			// Both may list warehouses; the request reaches AIStor signed as each user.
			if resp, out := alice.do("GET", "/api/c/dev/warehouses?search=ana&stats=true&sort=size&sort_order=desc", ""); resp.StatusCode != 200 || out["user"] != "alice" {
				t.Fatalf("alice list: %d %v", resp.StatusCode, out)
			}
			if got := e.fake.Last().Query.Get("sort"); got != "size" {
				t.Fatalf("query not forwarded: %q", got)
			}
			if resp, out := bob.do("GET", "/api/c/dev/warehouses", ""); resp.StatusCode != 200 || out["user"] != "bob" {
				t.Fatalf("bob list: %d %v", resp.StatusCode, out)
			}

			// Bob is denied by AIStor's own policy; the UI server grants nothing extra.
			resp, out := bob.do("POST", "/api/c/dev/warehouses", `{"name":"analytics"}`)
			if resp.StatusCode != 403 || errType(out) != "AccessDenied" {
				t.Fatalf("bob create: %d %v", resp.StatusCode, out)
			}
			if resp.Header.Get("X-Aistor-Action") != "s3tables:CreateWarehouse" {
				t.Fatalf("missing action hint")
			}
			if resp, _ := alice.do("POST", "/api/c/dev/warehouses", `{"name":"analytics"}`); resp.StatusCode != 200 {
				t.Fatalf("alice create: %d", resp.StatusCode)
			}

			// CSRF: missing token is rejected before reaching AIStor.
			saved := alice.csrf
			alice.csrf = ""
			if resp, out := alice.do("POST", "/api/c/dev/warehouses", `{"name":"x-y-z"}`); resp.StatusCode != 403 || errType(out) != "CSRFRejected" {
				t.Fatalf("csrf: %d %v", resp.StatusCode, out)
			}
			alice.csrf = saved

			// Validation happens before signing.
			if resp, out := alice.do("POST", "/api/c/dev/warehouses", `{"name":"Bad_Name"}`); resp.StatusCode != 400 || errType(out) != "ValidationError" {
				t.Fatalf("validation: %d %v", resp.StatusCode, out)
			}
			if resp, _ := alice.do("GET", "/api/c/dev/warehouses?evil=1", ""); resp.StatusCode != 400 {
				t.Fatalf("unknown query param accepted")
			}

			// Multi-level namespace is encoded with %1F upstream and signed correctly.
			if resp, out := alice.do("GET", "/api/c/dev/wh/analytics/ns/finance%1Fq3/tables", ""); resp.StatusCode != 200 {
				t.Fatalf("nested ns: %d %v", resp.StatusCode, out)
			}
			if got := e.fake.Last().RawPath; got != "/_iceberg/v1/analytics/namespaces/finance%1Fq3/tables" {
				t.Fatalf("upstream path %q", got)
			}
			// Path traversal attempts are rejected.
			if resp, _ := alice.do("GET", "/api/c/dev/wh/analytics/ns/a%2Fb/tables", ""); resp.StatusCode != 400 {
				t.Fatalf("slash in namespace accepted: %d", resp.StatusCode)
			}

			// Dropping a table requires an explicit purge choice, always forwarded.
			if resp, _ := alice.do("DELETE", "/api/c/dev/wh/analytics/ns/finance/t/orders", ""); resp.StatusCode != 400 {
				t.Fatalf("delete without purge accepted: %d", resp.StatusCode)
			}
			if resp, _ := alice.do("DELETE", "/api/c/dev/wh/analytics/ns/finance/t/orders?purge=false", ""); resp.StatusCode != 200 {
				t.Fatalf("delete keep-data: %d", resp.StatusCode)
			}
			if got := e.fake.Last().Query.Get("purgeRequested"); got != "false" {
				t.Fatalf("purgeRequested=%q", got)
			}
			// Purging data needs a recent step-up.
			if resp, out := alice.do("DELETE", "/api/c/dev/wh/analytics/ns/finance/t/orders?purge=true", ""); resp.StatusCode != 403 || errType(out) != "StepUpRequired" {
				t.Fatalf("purge without step-up: %d %v", resp.StatusCode, out)
			}
			if resp, _ := alice.do("POST", "/auth/step-up", `{"secret":"wrong"}`); resp.StatusCode != 401 {
				t.Fatalf("bad step-up accepted")
			}
			resp, out = alice.do("POST", "/auth/step-up", `{"secret":"alice-pw"}`)
			if resp.StatusCode != 200 {
				t.Fatalf("step-up: %d %v", resp.StatusCode, out)
			}
			if resp, out := alice.do("DELETE", "/api/c/dev/wh/analytics/ns/finance/t/orders?purge=true", ""); resp.StatusCode != 200 {
				t.Fatalf("purge after step-up: %d %v", resp.StatusCode, out)
			}
			if got := e.fake.Last().Query.Get("purgeRequested"); got != "true" {
				t.Fatalf("purgeRequested=%q", got)
			}

			// The UI never asks AIStor for vended credentials.
			for _, rq := range e.fake.Requests {
				if rq.Header.Get("X-Iceberg-Access-Delegation") != "" {
					t.Fatalf("delegation header sent")
				}
			}

			// Expired credentials cannot be renewed silently for LDAP sessions: the UI asks for the password.
			e.fake.ExpireNext = true
			if resp, out := alice.do("GET", "/api/c/dev/warehouses", ""); resp.StatusCode != 401 || errType(out) != "CredentialsExpired" {
				t.Fatalf("expired: %d %v", resp.StatusCode, out)
			}

			// Activity: bob sees only his own records; alice (admin) sees all.
			_, out = bob.do("GET", "/api/activity", "")
			for _, r := range out["records"].([]any) {
				if r.(map[string]any)["actor"].(map[string]any)["username"] != "bob" {
					t.Fatalf("bob saw someone else's activity")
				}
			}
			if resp, _ := bob.do("GET", "/api/activity?scope=all", ""); resp.StatusCode != 403 {
				t.Fatalf("non-admin saw all activity")
			}
			_, out = alice.do("GET", "/api/activity?scope=all", "")
			if len(out["records"].([]any)) < 4 {
				t.Fatalf("admin activity too short: %v", out)
			}

			// Logout invalidates the server-side session.
			if resp, _ := bob.do("POST", "/auth/logout", ""); resp.StatusCode != 200 {
				t.Fatalf("logout failed")
			}
			if resp, _ := bob.do("GET", "/auth/me", ""); resp.StatusCode != 401 {
				t.Fatalf("session still valid after logout")
			}
		})
	}
}

func TestBuiltinLoginAndCrossSite(t *testing.T) {
	e := newEnv(t, false)
	b := e.browser()
	resp, out := b.do("POST", "/auth/builtin/login", `{"accessKey":"alice","secretKey":"alice-secret-key"}`)
	if resp.StatusCode != 200 {
		t.Fatalf("builtin login: %d %v", resp.StatusCode, out)
	}
	// A cross-site POST is rejected even with a valid token.
	b.csrf = out["csrfToken"].(string)
	req, _ := http.NewRequest("POST", e.app.URL+"/api/c/dev/warehouses", strings.NewReader(`{"name":"abc"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://evil.example")
	req.Header.Set("X-CSRF-Token", b.csrf)
	r2, err := b.c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if r2.StatusCode != 403 {
		t.Fatalf("cross-site accepted: %d", r2.StatusCode)
	}
	// Security headers are present.
	if !strings.Contains(r2.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Fatalf("missing CSP")
	}
}

func TestSafeReturnTo(t *testing.T) {
	cases := map[string]string{
		"":                     "/",
		"/c/dev/wh/a":          "/c/dev/wh/a",
		"//evil.example":       "/",
		"/\\evil.example":      "/",
		"https://evil":         "/",
		"/api/c/dev":           "/",
		"/c/dev?x=1":           "/c/dev?x=1",
		"/c/dev\r\nSet-Cookie": "/",
	}
	for in, want := range cases {
		if got := safeReturnTo(in); got != want {
			t.Errorf("safeReturnTo(%q)=%q want %q", in, got, want)
		}
	}
}
