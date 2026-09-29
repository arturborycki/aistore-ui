package server

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	jose "github.com/go-jose/go-jose/v4"

	"github.com/arturborycki/aistore-ui/backend/internal/aistortest"
	"github.com/arturborycki/aistore-ui/backend/internal/audit"
	"github.com/arturborycki/aistore-ui/backend/internal/config"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

// fakeIdP is a minimal OpenID provider issuing RS256-signed ID tokens.
type fakeIdP struct {
	srv       *httptest.Server
	key       *rsa.PrivateKey
	mu        sync.Mutex
	nonces    map[string]string // code → nonce
	refreshes int
	lifetime  time.Duration
}

func newIdP(t *testing.T) *fakeIdP {
	k, _ := rsa.GenerateKey(rand.Reader, 2048)
	idp := &fakeIdP{key: k, nonces: map[string]string{}, lifetime: time.Hour}
	idp.srv = httptest.NewServer(http.HandlerFunc(idp.serve))
	t.Cleanup(idp.srv.Close)
	return idp
}

func (i *fakeIdP) sign(claims map[string]any) string {
	signer, _ := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: jose.JSONWebKey{Key: i.key, KeyID: "k1"}}, nil)
	b, _ := json.Marshal(claims)
	obj, _ := signer.Sign(b)
	s, _ := obj.CompactSerialize()
	return s
}

func (i *fakeIdP) idToken(nonce string) string {
	now := time.Now()
	c := map[string]any{"iss": i.srv.URL, "aud": "aistor-ui", "sub": "sub-alice", "preferred_username": "alice",
		"name": "Alice Liddell", "groups": []string{"catalog-admins"}, "iat": now.Unix(), "exp": now.Add(i.lifetime).Unix(), "auth_time": now.Unix()}
	if nonce != "" {
		c["nonce"] = nonce
	}
	return i.sign(c)
}

func (i *fakeIdP) serve(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/.well-known/openid-configuration":
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer": i.srv.URL, "authorization_endpoint": i.srv.URL + "/authorize", "token_endpoint": i.srv.URL + "/token",
			"jwks_uri": i.srv.URL + "/jwks", "end_session_endpoint": i.srv.URL + "/logout", "id_token_signing_alg_values_supported": []string{"RS256"},
		})
	case "/jwks":
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: &i.key.PublicKey, KeyID: "k1", Algorithm: "RS256", Use: "sig"}}})
	case "/token":
		_ = r.ParseForm()
		i.mu.Lock()
		defer i.mu.Unlock()
		var idt string
		switch r.Form.Get("grant_type") {
		case "authorization_code":
			nonce, ok := i.nonces[r.Form.Get("code")]
			if !ok || r.Form.Get("code_verifier") == "" {
				http.Error(w, `{"error":"invalid_grant"}`, 400)
				return
			}
			delete(i.nonces, r.Form.Get("code"))
			idt = i.idToken(nonce)
		case "refresh_token":
			if r.Form.Get("refresh_token") != "rt-1" {
				http.Error(w, `{"error":"invalid_grant"}`, 400)
				return
			}
			i.refreshes++
			idt = i.idToken("")
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "token_type": "Bearer", "expires_in": 300, "refresh_token": "rt-1", "id_token": idt})
	default:
		http.NotFound(w, r)
	}
}

func jwtSubject(tok string) string {
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return ""
	}
	b, _ := base64.RawURLEncoding.DecodeString(parts[1])
	var c struct {
		Username string `json:"preferred_username"`
	}
	_ = json.Unmarshal(b, &c)
	return c.Username
}

func TestOIDCLoginRefreshStepUpLogout(t *testing.T) {
	idp := newIdP(t)
	fake := aistortest.New(&aistortest.User{AccessKey: "alice", Allowed: []string{"*"}})
	defer fake.Close()
	fake.WebIdentity = jwtSubject

	app := httptest.NewUnstartedServer(nil)
	pub := "http://" + app.Listener.Addr().String()
	cfg, err := config.Parse([]byte(`
server: { publicUrl: "` + pub + `" }
session: { keys: [{ id: k1, value: "0000000000000000000000000000000000000000000000000000000000000002" }] }
auth:
  adminGroups: [catalog-admins]
  oidc: { enabled: true, issuer: "` + idp.srv.URL + `", clientId: aistor-ui, clientSecret: s3cr3t, endSessionRedirect: true, scopes: [openid, profile, groups] }
clusters: [{ id: dev, endpoint: "` + fake.URL() + `" }]
`))
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	kr, _ := session.NewKeyring([]session.KeyMaterial{{ID: "k1", Key: cfg.Session.Keys[0].Bytes()}})
	srv, err := New(Options{Config: cfg, Log: log, Sessions: session.NewManager(session.NewMemoryStore(), kr, time.Hour, 2*time.Hour), Audit: audit.NewLogger(log, audit.NewMemoryStore(10), "")})
	if err != nil {
		t.Fatal(err)
	}
	app.Config.Handler = srv.Handler()
	app.Start()
	defer app.Close()
	e := &env{t: t, fake: fake, app: app}
	b := e.browser()

	// completeLogin follows /auth/oidc/login → IdP → callback.
	completeLogin := func(path string) (authorizeURL *url.URL, final *http.Response) {
		resp, _ := b.do("GET", path, "")
		if resp.StatusCode != 302 {
			t.Fatalf("login start: %d", resp.StatusCode)
		}
		loc, _ := url.Parse(resp.Header.Get("Location"))
		q := loc.Query()
		if q.Get("code_challenge_method") != "S256" || q.Get("code_challenge") == "" {
			t.Fatalf("PKCE missing: %s", loc)
		}
		idp.mu.Lock()
		idp.nonces["code-1"] = q.Get("nonce")
		idp.mu.Unlock()
		final, _ = b.do("GET", "/auth/oidc/callback?code=code-1&state="+url.QueryEscape(q.Get("state")), "")
		return loc, final
	}

	// A forged state is rejected.
	if resp, _ := b.do("GET", "/auth/oidc/callback?code=x&state=forged", ""); resp.StatusCode != 302 || !strings.Contains(resp.Header.Get("Location"), "error=state") {
		t.Fatalf("forged state: %d %s", resp.StatusCode, resp.Header.Get("Location"))
	}

	_, final := completeLogin("/auth/oidc/login?returnTo=%2Fc%2Fdev%3Ftab%3D1")
	if final.StatusCode != 302 || final.Header.Get("Location") != "/c/dev?tab=1" {
		t.Fatalf("callback: %d %s", final.StatusCode, final.Header.Get("Location"))
	}
	resp, me := b.do("GET", "/auth/me", "")
	if resp.StatusCode != 200 {
		t.Fatalf("me: %d", resp.StatusCode)
	}
	user := me["user"].(map[string]any)
	if user["username"] != "alice" || user["admin"] != true || user["method"] != "oidc" {
		t.Fatalf("me: %v", me)
	}
	b.csrf = me["csrfToken"].(string)

	// Catalog call signed with credentials from AssumeRoleWithWebIdentity.
	if resp, out := b.do("GET", "/api/c/dev/warehouses", ""); resp.StatusCode != 200 || out["user"] != "alice" {
		t.Fatalf("list: %d %v", resp.StatusCode, out)
	}

	// Expired AIStor credentials are renewed transparently via the refresh token.
	fake.ExpireNext = true
	idp.lifetime = 30 * time.Second // renewed ID tokens will look near-expiry too
	if resp, out := b.do("GET", "/api/c/dev/warehouses", ""); resp.StatusCode != 200 {
		t.Fatalf("after expiry: %d %v", resp.StatusCode, out)
	}
	if idp.refreshes == 0 || fake.STSCalls["AssumeRoleWithWebIdentity"] < 2 {
		t.Fatalf("no refresh happened: refreshes=%d sts=%v", idp.refreshes, fake.STSCalls)
	}

	// Purge requires step-up; the IdP is asked to re-authenticate interactively.
	if resp, out := b.do("DELETE", "/api/c/dev/wh/analytics/ns/a/t/b?purge=true", ""); resp.StatusCode != 403 || errType(out) != "StepUpRequired" {
		t.Fatalf("purge before step-up: %d %v", resp.StatusCode, out)
	}
	loc, final := completeLogin("/auth/oidc/login?stepUp=1&returnTo=%2Fback")
	if loc.Query().Get("prompt") != "login" || loc.Query().Get("max_age") != "0" {
		t.Fatalf("step-up did not force re-authentication: %s", loc)
	}
	if final.Header.Get("Location") != "/back" {
		t.Fatalf("step-up callback: %s", final.Header.Get("Location"))
	}
	if resp, out := b.do("DELETE", "/api/c/dev/wh/analytics/ns/a/t/b?purge=true", ""); resp.StatusCode != 200 {
		t.Fatalf("purge after step-up: %d %v", resp.StatusCode, out)
	}

	// Logout returns the IdP end-session URL and kills the session.
	resp, out := b.do("POST", "/auth/logout", "")
	if resp.StatusCode != 200 || !strings.HasPrefix(out["redirect"].(string), idp.srv.URL+"/logout?") {
		t.Fatalf("logout: %d %v", resp.StatusCode, out)
	}
	if resp, _ := b.do("GET", "/auth/me", ""); resp.StatusCode != 401 {
		t.Fatalf("session survived logout")
	}
}
