// Package auth wraps the OpenID Connect relying-party flow (authorization
// code + PKCE) used to sign users in before exchanging their token with
// AIStor STS for per-user credentials.
package auth

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"

	"github.com/arturborycki/aistore-ui/backend/internal/config"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

// OIDC lazily discovers the provider so the server can start before the IdP is reachable.
type OIDC struct {
	cfg         config.OIDC
	redirectURL string
	httpClient  *http.Client

	mu         sync.Mutex
	provider   *oidc.Provider
	verifier   *oidc.IDTokenVerifier
	oauth      *oauth2.Config
	endSession string
}

// NewOIDC prepares the relying party. With cfg.CAFile, the identity provider's
// certificate is verified against that bundle (in addition to system roots).
func NewOIDC(cfg config.OIDC, redirectURL string) (*OIDC, error) {
	o := &OIDC{cfg: cfg, redirectURL: redirectURL}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if cfg.CAFile != "" {
		pem, err := os.ReadFile(cfg.CAFile)
		if err != nil {
			return nil, fmt.Errorf("oidc: read CA: %w", err)
		}
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM(pem) {
			return nil, fmt.Errorf("oidc: no certificates in %s", cfg.CAFile)
		}
		tlsCfg.RootCAs = pool
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.TLSClientConfig = tlsCfg
	o.httpClient = &http.Client{Transport: tr, Timeout: 15 * time.Second}
	return o, nil
}

// withClient makes go-oidc and oauth2 use the configured HTTP client. The
// returned context is not cancelled with the request, because the provider
// keeps it for fetching signing keys later.
func (o *OIDC) withClient(ctx context.Context) context.Context {
	base := context.WithoutCancel(ctx)
	base = context.WithValue(base, oauth2.HTTPClient, o.httpClient)
	return oidc.ClientContext(base, o.httpClient)
}

func (o *OIDC) init(ctx context.Context) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.provider != nil {
		return nil
	}
	ctx = o.withClient(ctx)
	discovery := o.cfg.Issuer
	if o.cfg.DiscoveryURL != "" {
		// Split-horizon deployments: discover through an internal URL while
		// still requiring tokens to carry the public issuer.
		ctx = oidc.InsecureIssuerURLContext(ctx, o.cfg.Issuer)
		discovery = o.cfg.DiscoveryURL
	}
	p, err := oidc.NewProvider(ctx, discovery)
	if err != nil {
		return fmt.Errorf("oidc discovery: %w", err)
	}
	var extra struct {
		EndSession string `json:"end_session_endpoint"`
	}
	_ = p.Claims(&extra)
	o.provider = p
	o.verifier = p.Verifier(&oidc.Config{ClientID: o.cfg.ClientID})
	o.oauth = &oauth2.Config{
		ClientID:     o.cfg.ClientID,
		ClientSecret: o.cfg.ClientSecret,
		Endpoint:     p.Endpoint(),
		RedirectURL:  o.redirectURL,
		Scopes:       o.cfg.Scopes,
	}
	o.endSession = extra.EndSession
	return nil
}

// State is kept (sealed) in a short-lived cookie between login and callback.
type State struct {
	State    string `json:"s"`
	Nonce    string `json:"n"`
	Verifier string `json:"v"`
	ReturnTo string `json:"r"`
	StepUp   bool   `json:"u,omitempty"`
	// SessionID binds a step-up to the session that started it. The IdP
	// redirect back is a cross-site navigation, so the SameSite=Strict session
	// cookie is not sent with the callback; the sealed state cookie (Lax) is.
	SessionID string    `json:"sid,omitempty"`
	Expires   time.Time `json:"e"`
}

func random() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// AuthURL starts a login. With stepUp the IdP is asked to re-authenticate the
// user interactively (prompt=login, max_age=0).
func (o *OIDC) AuthURL(ctx context.Context, returnTo string, stepUp bool, loginHint string) (string, *State, error) {
	if err := o.init(ctx); err != nil {
		return "", nil, err
	}
	st := &State{State: random(), Nonce: random(), Verifier: oauth2.GenerateVerifier(), ReturnTo: returnTo, StepUp: stepUp, Expires: time.Now().Add(10 * time.Minute)}
	opts := []oauth2.AuthCodeOption{oidc.Nonce(st.Nonce), oauth2.S256ChallengeOption(st.Verifier)}
	if stepUp {
		opts = append(opts, oauth2.SetAuthURLParam("prompt", "login"), oauth2.SetAuthURLParam("max_age", "0"))
		if loginHint != "" {
			opts = append(opts, oauth2.SetAuthURLParam("login_hint", loginHint))
		}
	}
	return o.oauth.AuthCodeURL(st.State, opts...), st, nil
}

// Identity is the verified result of a login.
type Identity struct {
	User     session.User
	Tokens   session.OIDCTokens
	AuthTime time.Time
}

type claims struct {
	Subject  string `json:"sub"`
	Name     string `json:"name"`
	Email    string `json:"email"`
	AuthTime int64  `json:"auth_time"`
	Nonce    string `json:"nonce"`
}

// Exchange completes the authorization code flow and verifies the ID token.
func (o *OIDC) Exchange(ctx context.Context, code string, st *State) (*Identity, error) {
	if err := o.init(ctx); err != nil {
		return nil, err
	}
	tok, err := o.oauth.Exchange(o.withClient(ctx), code, oauth2.VerifierOption(st.Verifier))
	if err != nil {
		return nil, fmt.Errorf("token exchange: %w", err)
	}
	return o.identityFromToken(ctx, tok, st.Nonce)
}

func (o *OIDC) identityFromToken(ctx context.Context, tok *oauth2.Token, nonce string) (*Identity, error) {
	rawID, _ := tok.Extra("id_token").(string)
	if rawID == "" {
		return nil, errors.New("provider returned no id_token")
	}
	idt, err := o.verifier.Verify(ctx, rawID)
	if err != nil {
		return nil, fmt.Errorf("verify id_token: %w", err)
	}
	var c claims
	if err := idt.Claims(&c); err != nil {
		return nil, err
	}
	if nonce != "" && c.Nonce != nonce {
		return nil, errors.New("id_token nonce mismatch")
	}
	var all map[string]any
	_ = idt.Claims(&all)
	user := session.User{
		Subject:     c.Subject,
		Username:    stringClaim(all, o.cfg.UsernameClaim),
		DisplayName: c.Name,
		Email:       c.Email,
		Groups:      listClaim(all, o.cfg.GroupsClaim),
		Method:      "oidc",
	}
	if user.Username == "" {
		user.Username = firstNonEmpty(c.Email, c.Subject)
	}
	id := &Identity{User: user, Tokens: session.OIDCTokens{IDToken: rawID, AccessToken: tok.AccessToken, RefreshToken: tok.RefreshToken, Expiry: idt.Expiry}}
	if c.AuthTime > 0 {
		id.AuthTime = time.Unix(c.AuthTime, 0)
	}
	return id, nil
}

// Refresh uses the refresh token to obtain a fresh ID token.
func (o *OIDC) Refresh(ctx context.Context, t *session.OIDCTokens) (*Identity, error) {
	if err := o.init(ctx); err != nil {
		return nil, err
	}
	if t.RefreshToken == "" {
		return nil, errors.New("no refresh token")
	}
	src := o.oauth.TokenSource(o.withClient(ctx), &oauth2.Token{RefreshToken: t.RefreshToken, Expiry: time.Unix(1, 0)})
	tok, err := src.Token()
	if err != nil {
		return nil, fmt.Errorf("refresh: %w", err)
	}
	id, err := o.identityFromToken(ctx, tok, "")
	if err != nil {
		return nil, err
	}
	if id.Tokens.RefreshToken == "" {
		id.Tokens.RefreshToken = t.RefreshToken // provider did not rotate it
	}
	return id, nil
}

// EndSessionURL returns the RP-initiated logout URL, if the provider supports it.
func (o *OIDC) EndSessionURL(ctx context.Context, idTokenHint, postLogout string) string {
	if !o.cfg.EndSessionRedirect || o.init(ctx) != nil || o.endSession == "" {
		return ""
	}
	u := o.endSession + "?client_id=" + queryEscape(o.cfg.ClientID) + "&post_logout_redirect_uri=" + queryEscape(postLogout)
	if idTokenHint != "" {
		u += "&id_token_hint=" + queryEscape(idTokenHint)
	}
	return u
}

// STSToken selects the token presented to AssumeRoleWithWebIdentity.
func (o *OIDC) STSToken(t *session.OIDCTokens) string {
	if o.cfg.STSToken == "access_token" {
		return t.AccessToken
	}
	return t.IDToken
}
