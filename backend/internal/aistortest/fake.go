// Package aistortest provides an in-process AIStor test double for tests
// only. It verifies SigV4 signatures exactly as AIStor would (so a signing
// bug fails tests), issues STS credentials, and enforces a simple per-user
// allow-list of s3tables actions to prove users are isolated from each other.
package aistortest

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
)

// User is an identity known to the fake.
type User struct {
	AccessKey string
	SecretKey string // for AssumeRole (built-in users)
	LDAPPass  string // for AssumeRoleWithLDAPIdentity (keyed by AccessKey as username)
	WebToken  string // for AssumeRoleWithWebIdentity
	// Allowed lists the operations (e.g. "GET /warehouses") the user may call; "*" allows all.
	Allowed []string
}

// Recorded is a catalog request as received.
type Recorded struct {
	User    string
	Method  string
	RawPath string
	Query   url.Values
	Header  http.Header
	Body    string
}

type Fake struct {
	prefix string
	Server *httptest.Server
	Region string

	mu       sync.Mutex
	users    map[string]*User
	sessions map[string]stsSession // temp access key → session
	Requests []Recorded
	// Handler answers authorised catalog requests. Defaults to a small JSON responder.
	Handler func(w http.ResponseWriter, r *http.Request, user string)
	// ExpireNext makes the next catalog request fail with ExpiredToken.
	ExpireNext bool
	// STSDuration is the lifetime of issued credentials.
	STSDuration time.Duration
	// WebIdentity, when set, maps a web identity token to a user (for JWT-based tests).
	WebIdentity func(token string) string
	// STSCalls counts STS exchanges by action.
	STSCalls map[string]int
}

type stsSession struct {
	user   string
	secret string
	token  string
}

func New(users ...*User) *Fake {
	f := &Fake{prefix: fakeUUID(fmt.Sprint(time.Now().UnixNano()))[:8], Region: "us-east-1", users: map[string]*User{}, sessions: map[string]stsSession{}, STSDuration: time.Hour, STSCalls: map[string]int{}}
	for _, u := range users {
		f.users[u.AccessKey] = u
	}
	f.Server = httptest.NewServer(http.HandlerFunc(f.serve))
	return f
}

func (f *Fake) Close() { f.Server.Close() }

// SetAllowed replaces a user's allowed operations.
func (f *Fake) SetAllowed(user string, allowed []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if u := f.users[user]; u != nil {
		u.Allowed = allowed
	}
}

func (f *Fake) URL() string { return f.Server.URL }

func (f *Fake) Last() Recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.Requests[len(f.Requests)-1]
}

func (f *Fake) serve(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost && r.URL.Path == "/" {
		f.serveSTS(w, r)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/_iceberg/v1/") {
		f.serveCatalog(w, r)
		return
	}
	http.NotFound(w, r)
}

func xmlErr(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><ErrorResponse><Error><Code>%s</Code><Message>%s</Message></Error></ErrorResponse>`, code, msg)
}

func (f *Fake) issue(w http.ResponseWriter, action, user string) {
	f.mu.Lock()
	n := len(f.sessions) + 1
	ak := fmt.Sprintf("TMP%s%05d", f.prefix, n)
	s := stsSession{user: user, secret: fmt.Sprintf("tmpsecret%05d", n), token: fmt.Sprintf("tmptoken%05d", n)}
	f.sessions[ak] = s
	f.mu.Unlock()
	exp := time.Now().Add(f.STSDuration).UTC().Format(time.RFC3339)
	w.Header().Set("Content-Type", "application/xml")
	fmt.Fprintf(w, `<%[1]sResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><%[1]sResult><Credentials><AccessKeyId>%[2]s</AccessKeyId><SecretAccessKey>%[3]s</SecretAccessKey><SessionToken>%[4]s</SessionToken><Expiration>%[5]s</Expiration></Credentials></%[1]sResult></%[1]sResponse>`,
		action, ak, s.secret, s.token, exp)
}

func (f *Fake) serveSTS(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	form, _ := url.ParseQuery(string(body))
	f.mu.Lock()
	f.STSCalls[form.Get("Action")]++
	f.mu.Unlock()
	switch form.Get("Action") {
	case "AssumeRoleWithWebIdentity":
		if f.WebIdentity != nil {
			if u := f.WebIdentity(form.Get("WebIdentityToken")); u != "" {
				f.issue(w, "AssumeRoleWithWebIdentity", u)
				return
			}
			xmlErr(w, http.StatusBadRequest, "InvalidIdentityToken", "token rejected")
			return
		}
		for _, u := range f.users {
			if u.WebToken != "" && u.WebToken == form.Get("WebIdentityToken") {
				f.issue(w, "AssumeRoleWithWebIdentity", u.AccessKey)
				return
			}
		}
		xmlErr(w, http.StatusBadRequest, "InvalidIdentityToken", "token rejected")
	case "AssumeRoleWithLDAPIdentity":
		u := f.users[form.Get("LDAPUsername")]
		if u == nil || u.LDAPPass == "" || u.LDAPPass != form.Get("LDAPPassword") {
			xmlErr(w, http.StatusForbidden, "AccessDenied", "invalid LDAP credentials")
			return
		}
		f.issue(w, "AssumeRoleWithLDAPIdentity", u.AccessKey)
	case "AssumeRole":
		ak, ok := f.verify(r, body, "sts", func(ak string) (string, string, bool) {
			u := f.users[ak]
			if u == nil || u.SecretKey == "" {
				return "", "", false
			}
			return u.SecretKey, "", true
		})
		if !ok {
			xmlErr(w, http.StatusForbidden, "SignatureDoesNotMatch", "bad signature")
			return
		}
		f.issue(w, "AssumeRole", ak)
	default:
		xmlErr(w, http.StatusBadRequest, "InvalidAction", "unknown action")
	}
}

// verify recomputes the SigV4 signature over exactly the signed headers.
func (f *Fake) verify(r *http.Request, body []byte, service string, secretFor func(ak string) (secret, token string, ok bool)) (string, bool) {
	authz := r.Header.Get("Authorization")
	if !strings.HasPrefix(authz, "AWS4-HMAC-SHA256 ") {
		return "", false
	}
	parts := map[string]string{}
	for _, p := range strings.Split(strings.TrimPrefix(authz, "AWS4-HMAC-SHA256 "), ",") {
		kv := strings.SplitN(strings.TrimSpace(p), "=", 2)
		if len(kv) == 2 {
			parts[kv[0]] = kv[1]
		}
	}
	credParts := strings.Split(parts["Credential"], "/")
	if len(credParts) != 5 || credParts[2] != f.Region || credParts[3] != service {
		return "", false
	}
	ak := credParts[0]
	secret, token, ok := secretFor(ak)
	if !ok {
		return "", false
	}
	if token != "" && r.Header.Get("X-Amz-Security-Token") != token {
		return "", false
	}
	sum := sha256.Sum256(body)
	ph := hex.EncodeToString(sum[:])
	if got := r.Header.Get("X-Amz-Content-Sha256"); got != ph {
		return "", false
	}
	t, err := time.Parse("20060102T150405Z", r.Header.Get("X-Amz-Date"))
	if err != nil || time.Since(t) > 15*time.Minute {
		return "", false
	}
	u := *r.URL
	u.Scheme = "http"
	u.Host = r.Host
	clone, _ := http.NewRequestWithContext(context.Background(), r.Method, u.String(), nil)
	clone.URL.Path = r.URL.Path
	clone.URL.RawPath = r.URL.RawPath
	clone.Host = r.Host
	clone.ContentLength = r.ContentLength
	for _, h := range strings.Split(parts["SignedHeaders"], ";") {
		if h == "host" {
			continue
		}
		clone.Header[http.CanonicalHeaderKey(h)] = r.Header.Values(h)
	}
	clone.Header.Del("Authorization")
	signer := v4.NewSigner()
	if err := signer.SignHTTP(context.Background(), aws.Credentials{AccessKeyID: ak, SecretAccessKey: secret, SessionToken: token}, clone, ph, service, f.Region, t); err != nil {
		return "", false
	}
	if clone.Header.Get("Authorization") != authz {
		return "", false
	}
	return ak, true
}

func (f *Fake) serveCatalog(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(body))
	var user string
	ak, ok := f.verify(r, body, "s3tables", func(ak string) (string, string, bool) {
		f.mu.Lock()
		defer f.mu.Unlock()
		s, ok := f.sessions[ak]
		if !ok {
			return "", "", false
		}
		user = s.user
		return s.secret, s.token, true
	})
	if !ok {
		xmlErr(w, http.StatusForbidden, "SignatureDoesNotMatch", "The request signature we calculated does not match")
		return
	}
	f.mu.Lock()
	if f.ExpireNext {
		f.ExpireNext = false
		delete(f.sessions, ak)
		f.mu.Unlock()
		xmlErr(w, http.StatusForbidden, "ExpiredToken", "The provided token has expired")
		return
	}
	raw := r.URL.EscapedPath()
	f.Requests = append(f.Requests, Recorded{User: user, Method: r.Method, RawPath: raw, Query: r.URL.Query(), Header: r.Header.Clone(), Body: string(body)})
	u := f.users[user]
	f.mu.Unlock()

	op := r.Method + " " + strings.TrimPrefix(raw, "/_iceberg/v1")
	if !allowed(u, op) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprintf(w, `{"error":{"message":"Access Denied.","type":"AccessDenied","code":403}}`)
		return
	}
	if f.Handler != nil {
		f.Handler(w, r, user)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w, `{"ok":true,"user":%q}`, user)
}

func allowed(u *User, op string) bool {
	if u == nil {
		return false
	}
	for _, a := range u.Allowed {
		if a == "*" || a == op || strings.HasSuffix(a, "*") && strings.HasPrefix(op, strings.TrimSuffix(a, "*")) {
			return true
		}
	}
	return false
}

// ExpireNextRequest makes the next catalog request fail with ExpiredToken
// (safe to call while the server is running).
func (f *Fake) ExpireNextRequest() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.ExpireNext = true
}
