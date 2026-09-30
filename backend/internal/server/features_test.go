package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"

	"github.com/arturborycki/aistore-ui/backend/internal/aistortest"
	"github.com/arturborycki/aistore-ui/backend/internal/audit"
	"github.com/arturborycki/aistore-ui/backend/internal/config"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

func TestSessionsListAndRevoke(t *testing.T) {
	e := newEnv(t, true)
	a1, a2, bob := e.browser(), e.browser(), e.browser()
	a1.login("alice", "alice-pw")
	a2.login("alice", "alice-pw")
	bob.login("bob", "bob-pw")

	resp, out := a1.do("GET", "/api/sessions", "")
	if resp.StatusCode != 200 {
		t.Fatalf("list: %d", resp.StatusCode)
	}
	list := out["sessions"].([]any)
	if len(list) != 2 {
		t.Fatalf("alice should have 2 sessions, got %d", len(list))
	}
	var other string
	for _, s := range list {
		m := s.(map[string]any)
		if m["current"] != true {
			other = m["handle"].(string)
		}
		if _, leaked := m["csrf"]; leaked {
			t.Fatalf("session listing leaks secrets: %v", m)
		}
	}
	// Bob cannot revoke alice's session through the self-service endpoint.
	if resp, _ := bob.do("DELETE", "/api/sessions/"+other, ""); resp.StatusCode != 404 {
		t.Fatalf("bob revoked alice's session: %d", resp.StatusCode)
	}
	if resp, _ := a1.do("DELETE", "/api/sessions/"+other, ""); resp.StatusCode != 204 {
		t.Fatalf("revoke: %d", resp.StatusCode)
	}
	if resp, _ := a2.do("GET", "/auth/me", ""); resp.StatusCode != 401 {
		t.Fatalf("revoked session still works: %d", resp.StatusCode)
	}
	// Non-admins cannot list everyone's sessions; alice (admin) can revoke bob.
	if resp, _ := bob.do("GET", "/api/admin/sessions", ""); resp.StatusCode != 403 {
		t.Fatalf("bob listed all sessions")
	}
	_, out = a1.do("GET", "/api/admin/sessions", "")
	var bobHandle, bobSub string
	for _, s := range out["sessions"].([]any) {
		m := s.(map[string]any)
		u := m["user"].(map[string]any)
		if u["username"] == "bob" {
			bobHandle, bobSub = m["handle"].(string), u["sub"].(string)
		}
	}
	if bobHandle == "" {
		t.Fatalf("admin listing misses bob: %v", out)
	}
	if resp, _ := a1.do("DELETE", "/api/admin/sessions?sub="+bobSub+"&handle="+bobHandle, ""); resp.StatusCode != 204 {
		t.Fatalf("admin revoke: %d", resp.StatusCode)
	}
	if resp, _ := bob.do("GET", "/auth/me", ""); resp.StatusCode != 401 {
		t.Fatalf("bob still signed in")
	}
	// Revoking other sessions keeps the current one.
	a3 := e.browser()
	a3.login("alice", "alice-pw")
	if resp, out := a1.do("POST", "/api/sessions/revoke-others", ""); resp.StatusCode != 200 || out["revoked"].(float64) != 1 {
		t.Fatalf("revoke-others: %d %v", resp.StatusCode, out)
	}
	if resp, _ := a1.do("GET", "/auth/me", ""); resp.StatusCode != 200 {
		t.Fatalf("current session was revoked")
	}
	if resp, _ := a3.do("GET", "/auth/me", ""); resp.StatusCode != 401 {
		t.Fatalf("other session survived")
	}
}

func TestExpiredLDAPCredentialsAskForPasswordNotLogout(t *testing.T) {
	e := newEnv(t, false)
	b := e.browser()
	b.login("alice", "alice-pw")
	_, me := b.do("GET", "/auth/me", "")
	if me["credentialsExpireAt"] == nil {
		t.Fatalf("LDAP session should report credential expiry")
	}
	e.fake.ExpireNext = true
	resp, out := b.do("GET", "/api/c/dev/warehouses", "")
	if resp.StatusCode != 401 || errType(out) != "CredentialsExpired" {
		t.Fatalf("expected CredentialsExpired, got %d %v", resp.StatusCode, out)
	}
	// The session itself is intact; re-entering the password restores access.
	if resp, _ := b.do("GET", "/auth/me", ""); resp.StatusCode != 200 {
		t.Fatalf("session lost")
	}
	if resp, _ := b.do("POST", "/auth/step-up", `{"secret":"alice-pw"}`); resp.StatusCode != 200 {
		t.Fatalf("re-auth failed")
	}
	if resp, _ := b.do("GET", "/api/c/dev/warehouses", ""); resp.StatusCode != 200 {
		t.Fatalf("still failing after re-auth: %d", resp.StatusCode)
	}
}

func TestActivityFiltersAndPaging(t *testing.T) {
	e := newEnv(t, false)
	b := e.browser()
	b.login("alice", "alice-pw")
	for _, n := range []string{"aaa", "bbb", "ccc"} {
		b.do("POST", "/api/c/dev/warehouses", `{"name":"`+n+`"}`)
	}
	_, out := b.do("GET", "/api/activity?kind=catalog&limit=2", "")
	if out["total"].(float64) != 3 || len(out["records"].([]any)) != 2 {
		t.Fatalf("paging: %v", out)
	}
	_, out = b.do("GET", "/api/activity?kind=catalog&limit=2&offset=2", "")
	if len(out["records"].([]any)) != 1 {
		t.Fatalf("offset: %v", out)
	}
	_, out = b.do("GET", "/api/activity?q=bbb", "")
	if out["total"].(float64) != 1 {
		t.Fatalf("text filter: %v", out)
	}
	if resp, _ := b.do("GET", "/api/activity?since=yesterday", ""); resp.StatusCode != 400 {
		t.Fatalf("bad since accepted")
	}
}

func TestSearchRespectsPermissions(t *testing.T) {
	cat := aistortest.NewCatalog()
	cat.Seed("sales", nil, map[string][3]int64{"orders.eu": {3, 100, 1000}, "marketing": {2, 10, 10}})
	cat.Seed("secret", nil, map[string][3]int64{"orders": {2, 10, 10}})
	e := newEnv(t, false)
	e.fake.Handler = func(w http.ResponseWriter, r *http.Request, _ string) { cat.Handle(w, r) }
	// bob may only list the sales warehouse subtree.
	e.fake.SetAllowed("bob", []string{"GET /warehouses", "GET /sales/*"})

	alice, bob := e.browser(), e.browser()
	alice.login("alice", "alice-pw")
	bob.login("bob", "bob-pw")

	_, out := alice.do("GET", "/api/c/dev/search?q=orders", "")
	hits := out["results"].([]any)
	seen := map[string]bool{}
	for _, h := range hits {
		m := h.(map[string]any)
		seen[m["kind"].(string)+":"+m["warehouse"].(string)] = true
	}
	if !seen["namespace:sales"] || !seen["namespace:secret"] {
		t.Fatalf("alice should find orders namespaces in both warehouses: %v", out)
	}
	_, out = bob.do("GET", "/api/c/dev/search?q=orders", "")
	for _, h := range out["results"].([]any) {
		if h.(map[string]any)["warehouse"] == "secret" {
			t.Fatalf("bob found a result he may not list: %v", out)
		}
	}
	if out["skipped"].(float64) == 0 {
		t.Fatalf("denied subtrees should be reported as skipped: %v", out)
	}
	if resp, _ := alice.do("GET", "/api/c/dev/search?q=a", ""); resp.StatusCode != 400 {
		t.Fatalf("one-character query accepted")
	}
}

func TestMultipleClustersAreIsolated(t *testing.T) {
	f1 := aistortest.New(&aistortest.User{AccessKey: "alice", LDAPPass: "pw", Allowed: []string{"*"}})
	f2 := aistortest.New(&aistortest.User{AccessKey: "alice", LDAPPass: "pw", Allowed: []string{"*"}})
	f3 := aistortest.New() // alice is unknown here
	for _, f := range []*aistortest.Fake{f1, f2, f3} {
		t.Cleanup(f.Close)
	}
	app := httptest.NewUnstartedServer(nil)
	cfg, err := config.Parse([]byte(`
server: { publicUrl: "http://` + app.Listener.Addr().String() + `" }
session: { keys: [{ id: k, value: "0000000000000000000000000000000000000000000000000000000000000003" }] }
auth: { ldap: { enabled: true } }
clusters:
  - { id: eu, endpoint: "` + f1.URL() + `" }
  - { id: us, endpoint: "` + f2.URL() + `" }
  - { id: ap, endpoint: "` + f3.URL() + `" }
`))
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	kr, _ := session.NewKeyring([]session.KeyMaterial{{ID: "k", Key: cfg.Session.Keys[0].Bytes()}})
	srv, _ := New(Options{Config: cfg, Log: log, Sessions: session.NewManager(session.NewMemoryStore(), kr, cfg.Session.IdleTimeout, cfg.Session.AbsoluteTTL), Audit: audit.NewLogger(log, audit.NewMemoryStore(10), "")})
	app.Config.Handler = srv.Handler()
	app.Start()
	defer app.Close()
	e := &env{t: t, app: app}
	b := e.browser()
	b.login("alice", "pw")
	_, me := b.do("GET", "/auth/me", "")
	avail := map[string]bool{}
	for _, c := range me["clusters"].([]any) {
		m := c.(map[string]any)
		avail[m["id"].(string)] = m["available"].(bool)
	}
	if !avail["eu"] || !avail["us"] || avail["ap"] {
		t.Fatalf("availability: %v", avail)
	}
	b.do("POST", "/api/c/eu/warehouses", `{"name":"only-eu"}`)
	if len(f1.Requests) != 1 || len(f2.Requests) != 0 {
		t.Fatalf("request went to the wrong cluster: eu=%d us=%d", len(f1.Requests), len(f2.Requests))
	}
	// Each fake only accepts signatures made with credentials it issued itself,
	// so a successful call proves the session holds separate per-cluster credentials.
	if resp, _ := b.do("GET", "/api/c/us/warehouses", ""); resp.StatusCode != 200 {
		t.Fatalf("us: %d", resp.StatusCode)
	}
	if f1.Requests[0].Header.Get("Authorization") == f2.Requests[0].Header.Get("Authorization") {
		t.Fatalf("identical signatures across clusters")
	}
	if resp, out := b.do("GET", "/api/c/ap/warehouses", ""); resp.StatusCode != 403 || errType(out) != "ClusterUnavailable" {
		t.Fatalf("ap: %d %v", resp.StatusCode, out)
	}
}

func TestRateLimitSharedThroughRedis(t *testing.T) {
	mr := miniredis.RunT(t)
	rc := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	// Two replicas sharing Redis share one budget of 3 per minute.
	a := newRedisLimiter(rc, "login", 3, log)
	b := newRedisLimiter(rc, "login", 3, log)
	ctx := t.Context()
	allowed := 0
	for i := 0; i < 6; i++ {
		l := a
		if i%2 == 1 {
			l = b
		}
		if l.allow(ctx, "ip:1.2.3.4") {
			allowed++
		}
	}
	if allowed != 3 {
		t.Fatalf("allowed %d requests across replicas, want 3", allowed)
	}
	// Redis outage fails open.
	mr.Close()
	if !a.allow(ctx, "ip:1.2.3.4") {
		t.Fatal("limiter should fail open when Redis is down")
	}
}

func TestBackgroundRequestsDoNotExtendIdleSession(t *testing.T) {
	e := newEnv(t, false)
	b := e.browser()
	b.login("alice", "alice-pw")
	_, me := b.do("GET", "/auth/me", "")
	first := me["idleExpiresAt"].(string)
	e.advance(2 * time.Minute)
	req, _ := http.NewRequest("GET", e.app.URL+"/auth/me", nil)
	req.Header.Set("X-Aistor-Background", "1")
	resp, err := b.c.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("background me: %v %v", err, resp)
	}
	var bg map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&bg)
	resp.Body.Close()
	if bg["idleExpiresAt"].(string) != first {
		t.Fatalf("background request extended the session: %v → %v", first, bg["idleExpiresAt"])
	}
	_, me = b.do("GET", "/auth/me", "")
	if me["idleExpiresAt"].(string) == first {
		t.Fatalf("user request did not extend the session")
	}
}
