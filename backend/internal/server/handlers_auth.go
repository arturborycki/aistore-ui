package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/arturborycki/aistore-ui/backend/internal/aistor"
	"github.com/arturborycki/aistore-ui/backend/internal/apierr"
	"github.com/arturborycki/aistore-ui/backend/internal/audit"
	"github.com/arturborycki/aistore-ui/backend/internal/auth"
	"github.com/arturborycki/aistore-ui/backend/internal/session"
)

const maxAuthBody = 8 << 10

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxAuthBody))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		apierr.Write(w, http.StatusBadRequest, "ValidationError", "invalid request body")
		return false
	}
	return true
}

// ---------------------------------------------------------------- cookies

func (s *Server) setSessionCookie(w http.ResponseWriter, id string) {
	http.SetCookie(w, &http.Cookie{
		Name: s.cfg.CookieName(), Value: id, Path: "/", HttpOnly: true, Secure: s.cfg.SecureCookies(),
		SameSite: http.SameSiteStrictMode, MaxAge: int(s.cfg.Session.AbsoluteTTL / time.Second),
	})
}

func (s *Server) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{Name: s.cfg.CookieName(), Value: "", Path: "/", HttpOnly: true, Secure: s.cfg.SecureCookies(), SameSite: http.SameSiteStrictMode, MaxAge: -1})
}

func (s *Server) stateCookieName() string {
	if s.cfg.SecureCookies() {
		return "__Host-aistor_oidc"
	}
	return "aistor_oidc"
}

// ---------------------------------------------------------------- helpers

// safeReturnTo accepts only same-origin absolute paths.
func safeReturnTo(v string) string {
	if v == "" || !strings.HasPrefix(v, "/") || strings.HasPrefix(v, "//") || strings.HasPrefix(v, "/\\") || strings.ContainsAny(v, "\r\n\t") {
		return "/"
	}
	if strings.HasPrefix(v, "/auth/") || strings.HasPrefix(v, "/api/") {
		return "/"
	}
	u, err := url.Parse(v)
	if err != nil || u.Host != "" || u.Scheme != "" {
		return "/"
	}
	return u.RequestURI()
}

type exchangeResult struct {
	creds       map[string]*session.Credentials
	errs        map[string]string
	authFailure bool
}

// exchangeAll obtains credentials from every configured cluster in parallel.
func (s *Server) exchangeAll(ctx context.Context, fn func(context.Context, *aistor.Client) (*session.Credentials, error)) exchangeResult {
	res := exchangeResult{creds: map[string]*session.Credentials{}, errs: map[string]string{}}
	var mu sync.Mutex
	var wg sync.WaitGroup
	for id, c := range s.clients {
		wg.Add(1)
		go func(id string, c *aistor.Client) {
			defer wg.Done()
			cr, err := fn(ctx, c)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				if aistor.IsAuthFailure(err) {
					res.authFailure = true
					res.errs[id] = "AIStor rejected this identity for this cluster"
				} else {
					res.errs[id] = "cluster unreachable"
				}
				s.log.Info("sts exchange failed", "cluster", id, "err", err)
				return
			}
			res.creds[id] = cr
		}(id, c)
	}
	wg.Wait()
	return res
}

// establish creates a new session (discarding any existing one) and sets the cookie.
func (s *Server) establish(w http.ResponseWriter, r *http.Request, sess *session.Session) (string, error) {
	if st := stateFrom(r); st != nil {
		_ = s.sessions.DeleteSession(r.Context(), st.id, st.s)
	}
	sess.User.Admin = isAdmin(s.cfg, &sess.User)
	sess.ClientIP = clientIP(r)
	sess.UserAgent = truncate(r.UserAgent(), 200)
	id, err := s.sessions.Create(r.Context(), sess)
	if err != nil {
		return "", err
	}
	s.setSessionCookie(w, id)
	return id, nil
}

func (s *Server) loginFailed(w http.ResponseWriter, r *http.Request, actor audit.Actor, op string, res exchangeResult) {
	if res.authFailure || len(res.errs) == 0 {
		s.recordAuth(r, actor, op, "denied", "invalid credentials")
		apierr.Write(w, http.StatusUnauthorized, "InvalidCredentials", "sign-in failed: the credentials were not accepted")
		return
	}
	s.recordAuth(r, actor, op, "failure", "clusters unreachable")
	apierr.Write(w, http.StatusBadGateway, "ClusterUnavailable", "sign-in failed: no AIStor cluster could be reached")
}

// ---------------------------------------------------------------- handlers

func (s *Server) handleProviders(w http.ResponseWriter, _ *http.Request) {
	a := s.cfg.Auth
	writeJSON(w, http.StatusOK, map[string]any{
		"oidc":    map[string]any{"enabled": a.OIDC.Enabled, "displayName": a.OIDC.DisplayName},
		"ldap":    map[string]any{"enabled": a.LDAP.Enabled, "displayName": a.LDAP.DisplayName},
		"builtin": map[string]any{"enabled": a.Builtin.Enabled},
		"version": s.version,
	})
}

func validCredentialText(v string, max int) bool {
	return v != "" && len(v) <= max && utf8.ValidString(v) && !strings.ContainsAny(v, "\x00\r\n")
}

func (s *Server) handleLDAPLogin(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.Auth.LDAP.Enabled {
		apierr.Write(w, http.StatusNotFound, "NotFound", "LDAP sign-in is disabled")
		return
	}
	var body struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !validCredentialText(body.Username, 256) || !validCredentialText(body.Password, 1024) {
		apierr.Write(w, http.StatusBadRequest, "ValidationError", "username and password are required")
		return
	}
	actor := audit.Actor{Subject: "ldap:" + body.Username, Username: body.Username, Method: "ldap"}
	res := s.exchangeAll(r.Context(), func(ctx context.Context, c *aistor.Client) (*session.Credentials, error) {
		return c.AssumeRoleWithLDAPIdentity(ctx, body.Username, body.Password)
	})
	body.Password = ""
	if len(res.creds) == 0 {
		s.loginFailed(w, r, actor, "LoginLDAP", res)
		return
	}
	sess := &session.Session{User: session.User{Subject: actor.Subject, Username: body.Username, Method: "ldap"}, Creds: res.creds, ClusterErrors: res.errs}
	if _, err := s.establish(w, r, sess); err != nil {
		apierr.Write(w, http.StatusServiceUnavailable, "SessionStoreUnavailable", "could not create session")
		return
	}
	s.recordAuth(r, actor, "LoginLDAP", "success", "")
	writeJSON(w, http.StatusOK, s.mePayload(sess))
}

func (s *Server) handleBuiltinLogin(w http.ResponseWriter, r *http.Request) {
	if !s.cfg.Auth.Builtin.Enabled {
		apierr.Write(w, http.StatusNotFound, "NotFound", "access-key sign-in is disabled")
		return
	}
	var body struct {
		AccessKey string `json:"accessKey"`
		SecretKey string `json:"secretKey"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !validCredentialText(body.AccessKey, 128) || !validCredentialText(body.SecretKey, 256) {
		apierr.Write(w, http.StatusBadRequest, "ValidationError", "access key and secret key are required")
		return
	}
	actor := audit.Actor{Subject: "builtin:" + body.AccessKey, Username: body.AccessKey, Method: "builtin"}
	res := s.exchangeAll(r.Context(), func(ctx context.Context, c *aistor.Client) (*session.Credentials, error) {
		return c.AssumeRole(ctx, body.AccessKey, body.SecretKey)
	})
	body.SecretKey = "" // the long-lived secret is never stored
	if len(res.creds) == 0 {
		s.loginFailed(w, r, actor, "LoginAccessKey", res)
		return
	}
	sess := &session.Session{User: session.User{Subject: actor.Subject, Username: body.AccessKey, Method: "builtin"}, Creds: res.creds, ClusterErrors: res.errs}
	if _, err := s.establish(w, r, sess); err != nil {
		apierr.Write(w, http.StatusServiceUnavailable, "SessionStoreUnavailable", "could not create session")
		return
	}
	s.recordAuth(r, actor, "LoginAccessKey", "success", "")
	writeJSON(w, http.StatusOK, s.mePayload(sess))
}

// handlePasswordStepUp re-verifies an LDAP password or MinIO secret key and
// marks the session as recently re-authenticated.
func (s *Server) handlePasswordStepUp(w http.ResponseWriter, r *http.Request) {
	st := stateFrom(r)
	var body struct {
		Secret string `json:"secret"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	if !validCredentialText(body.Secret, 1024) {
		apierr.Write(w, http.StatusBadRequest, "ValidationError", "password is required")
		return
	}
	u := st.s.User
	var fn func(context.Context, *aistor.Client) (*session.Credentials, error)
	switch u.Method {
	case "ldap":
		fn = func(ctx context.Context, c *aistor.Client) (*session.Credentials, error) {
			return c.AssumeRoleWithLDAPIdentity(ctx, u.Username, body.Secret)
		}
	case "builtin":
		fn = func(ctx context.Context, c *aistor.Client) (*session.Credentials, error) {
			return c.AssumeRole(ctx, u.Username, body.Secret)
		}
	default:
		apierr.Write(w, http.StatusBadRequest, "UseIdentityProvider", "confirm your identity through your identity provider")
		return
	}
	actor := s.actor(r)
	res := s.exchangeAll(r.Context(), fn)
	body.Secret = ""
	if len(res.creds) == 0 {
		s.recordAuth(r, actor, "StepUp", "denied", "re-authentication failed")
		apierr.Write(w, http.StatusUnauthorized, "InvalidCredentials", "the password was not accepted")
		return
	}
	st.mu.Lock()
	st.s.StepUpAt = time.Now()
	for k, v := range res.creds {
		st.s.Creds[k] = v
	}
	newID, err := s.sessions.Rotate(r.Context(), st.id, st.s)
	st.mu.Unlock()
	if err != nil {
		apierr.Write(w, http.StatusServiceUnavailable, "SessionStoreUnavailable", "could not update session")
		return
	}
	s.setSessionCookie(w, newID)
	s.recordAuth(r, actor, "StepUp", "success", "")
	writeJSON(w, http.StatusOK, s.mePayload(st.s))
}

func (s *Server) handleOIDCLogin(w http.ResponseWriter, r *http.Request) {
	if s.oidc == nil {
		apierr.Write(w, http.StatusNotFound, "NotFound", "single sign-on is disabled")
		return
	}
	stepUp := r.URL.Query().Get("stepUp") == "1"
	hint := ""
	if stepUp {
		st := stateFrom(r)
		if st == nil || st.s.User.Method != "oidc" {
			http.Redirect(w, r, "/login?error=stepup", http.StatusFound)
			return
		}
		hint = st.s.User.Username
	}
	authURL, state, err := s.oidc.AuthURL(r.Context(), safeReturnTo(r.URL.Query().Get("returnTo")), stepUp, hint)
	if err != nil {
		s.log.Error("oidc login unavailable", "err", err)
		http.Redirect(w, r, "/login?error=idp_unavailable", http.StatusFound)
		return
	}
	if stepUp {
		state.SessionID = stateFrom(r).id
	}
	raw, _ := json.Marshal(state)
	sealed, err := s.sessions.Keys().Seal(raw, []byte("oidc-state"))
	if err != nil {
		apierr.Write(w, http.StatusInternalServerError, "InternalError", "internal error")
		return
	}
	http.SetCookie(w, &http.Cookie{Name: s.stateCookieName(), Value: base64.RawURLEncoding.EncodeToString(sealed), Path: "/",
		HttpOnly: true, Secure: s.cfg.SecureCookies(), SameSite: http.SameSiteLaxMode, MaxAge: 600})
	http.Redirect(w, r, authURL, http.StatusFound)
}

func (s *Server) readOIDCState(w http.ResponseWriter, r *http.Request) (*auth.State, error) {
	c, err := r.Cookie(s.stateCookieName())
	http.SetCookie(w, &http.Cookie{Name: s.stateCookieName(), Value: "", Path: "/", HttpOnly: true, Secure: s.cfg.SecureCookies(), SameSite: http.SameSiteLaxMode, MaxAge: -1})
	if err != nil {
		return nil, errors.New("missing login state")
	}
	blob, err := base64.RawURLEncoding.DecodeString(c.Value)
	if err != nil {
		return nil, err
	}
	raw, err := s.sessions.Keys().Open(blob, []byte("oidc-state"))
	if err != nil {
		return nil, err
	}
	var st auth.State
	if err := json.Unmarshal(raw, &st); err != nil {
		return nil, err
	}
	if time.Now().After(st.Expires) {
		return nil, errors.New("login state expired")
	}
	return &st, nil
}

func (s *Server) handleOIDCCallback(w http.ResponseWriter, r *http.Request) {
	if s.oidc == nil {
		apierr.Write(w, http.StatusNotFound, "NotFound", "single sign-on is disabled")
		return
	}
	q := r.URL.Query()
	state, err := s.readOIDCState(w, r)
	if err != nil || q.Get("state") == "" || q.Get("state") != state.State {
		s.log.Info("oidc callback: bad state", "err", err)
		http.Redirect(w, r, "/login?error=state", http.StatusFound)
		return
	}
	if e := q.Get("error"); e != "" {
		s.recordAuth(r, s.actor(r), "LoginOIDC", "denied", "identity provider returned "+truncate(e, 64))
		http.Redirect(w, r, "/login?error=idp", http.StatusFound)
		return
	}
	id, err := s.oidc.Exchange(r.Context(), q.Get("code"), state)
	if err != nil {
		s.log.Info("oidc exchange failed", "err", err)
		s.recordAuth(r, s.actor(r), "LoginOIDC", "failure", "token exchange failed")
		http.Redirect(w, r, "/login?error=exchange", http.StatusFound)
		return
	}
	actor := audit.Actor{Subject: id.User.Subject, Username: id.User.Username, Method: "oidc"}
	token := s.oidc.STSToken(&id.Tokens)
	res := s.exchangeAll(r.Context(), func(ctx context.Context, c *aistor.Client) (*session.Credentials, error) {
		return c.AssumeRoleWithWebIdentity(ctx, token)
	})

	if state.StepUp {
		st := stateFrom(r)
		if st == nil && state.SessionID != "" {
			if sess, err := s.sessions.Load(r.Context(), state.SessionID); err == nil {
				st = &reqState{id: state.SessionID, s: sess}
			}
		}
		if st == nil || st.s.User.Subject != id.User.Subject || (!id.AuthTime.IsZero() && time.Since(id.AuthTime) > 5*time.Minute) {
			s.recordAuth(r, actor, "StepUp", "denied", "re-authentication did not match the signed-in user")
			http.Redirect(w, r, "/login?error=stepup", http.StatusFound)
			return
		}
		st.mu.Lock()
		st.s.StepUpAt = time.Now()
		st.s.OIDC = &id.Tokens
		for k, v := range res.creds {
			st.s.Creds[k] = v
		}
		newID, err := s.sessions.Rotate(r.Context(), st.id, st.s)
		st.mu.Unlock()
		if err != nil {
			http.Redirect(w, r, "/login?error=session", http.StatusFound)
			return
		}
		s.setSessionCookie(w, newID)
		s.recordAuth(r, actor, "StepUp", "success", "")
		http.Redirect(w, r, state.ReturnTo, http.StatusFound)
		return
	}

	if len(res.creds) == 0 {
		s.recordAuth(r, actor, "LoginOIDC", "denied", "AIStor STS rejected the identity token")
		http.Redirect(w, r, "/login?error=sts", http.StatusFound)
		return
	}
	sess := &session.Session{User: id.User, OIDC: &id.Tokens, Creds: res.creds, ClusterErrors: res.errs}
	if _, err := s.establish(w, r, sess); err != nil {
		http.Redirect(w, r, "/login?error=session", http.StatusFound)
		return
	}
	s.recordAuth(r, actor, "LoginOIDC", "success", "")
	http.Redirect(w, r, state.ReturnTo, http.StatusFound)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	st := stateFrom(r)
	redirect := ""
	if st != nil {
		if st.s.User.Method == "oidc" && s.oidc != nil && st.s.OIDC != nil {
			redirect = s.oidc.EndSessionURL(r.Context(), st.s.OIDC.IDToken, s.cfg.PublicURL().String()+"/login")
		}
		_ = s.sessions.DeleteSession(r.Context(), st.id, st.s)
		s.recordAuth(r, s.actor(r), "Logout", "success", "")
	}
	s.clearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]any{"redirect": redirect})
}

type clusterInfo struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Available bool   `json:"available"`
	Error     string `json:"error,omitempty"`
}

func (s *Server) mePayload(sess *session.Session) map[string]any {
	clusters := make([]clusterInfo, 0, len(s.cfg.Clusters))
	for _, c := range s.cfg.Clusters {
		ci := clusterInfo{ID: c.ID, Name: c.Name}
		if _, ok := sess.Creds[c.ID]; ok || sess.User.Method == "oidc" && sess.ClusterErrors[c.ID] == "" {
			ci.Available = true
		}
		if e, bad := sess.ClusterErrors[c.ID]; bad {
			ci.Available = false
			ci.Error = e
		}
		clusters = append(clusters, ci)
	}
	var stepUpUntil *time.Time
	if !sess.StepUpAt.IsZero() {
		t := sess.StepUpAt.Add(s.cfg.Session.StepUpValidFor)
		stepUpUntil = &t
	}
	return map[string]any{
		"user":                sess.User,
		"csrfToken":           sess.CSRFToken,
		"clusters":            clusters,
		"expiresAt":           sess.AbsoluteExpiry,
		"idleTimeoutSeconds":  int(s.cfg.Session.IdleTimeout / time.Second),
		"idleExpiresAt":       sess.LastSeen.Add(s.cfg.Session.IdleTimeout),
		"stepUpValidUntil":    stepUpUntil,
		"credentialsExpireAt": credsExpiry(sess),
		"sessionHandle":       sess.Handle,
		"version":             s.version,
	}
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	st := stateFrom(r)
	st.mu.Lock()
	defer st.mu.Unlock()
	writeJSON(w, http.StatusOK, s.mePayload(st.s))
}

func truncate(v string, n int) string {
	if len(v) <= n {
		return v
	}
	return v[:n]
}

// credsExpiry reports when the earliest AIStor credentials expire for sessions
// that cannot renew them silently (LDAP and access-key sign-in), so the UI can
// ask for the password before requests start failing.
func credsExpiry(sess *session.Session) *time.Time {
	if sess.User.Method == "oidc" {
		return nil
	}
	var min *time.Time
	for _, c := range sess.Creds {
		if c != nil && (min == nil || c.Expiration.Before(*min)) {
			t := c.Expiration
			min = &t
		}
	}
	return min
}
